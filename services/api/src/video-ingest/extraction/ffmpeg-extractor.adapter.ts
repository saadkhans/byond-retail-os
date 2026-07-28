import { execFile } from 'node:child_process';
import {
  chmod,
  mkdtemp,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Injectable } from '@nestjs/common';
import { LocalVideoStorageAdapter } from '../storage/local-video-storage.adapter';
import {
  BufferInspectionSession,
  CropBox,
  ExtractedImage,
  ExtractFrameAtOptions,
  ExtractionFailedError,
  ExtractionInfrastructureError,
  ExtractorUnavailableError,
  FrameExceedsBudgetError,
  FrameExtractionOptions,
  FrameUnavailableError,
  VideoFrameExtractorPort,
  VideoProbeResult,
} from './video-frame-extractor.port';

export const FFMPEG_EXTRACTOR_KIND = 'ffmpeg';

// OPTIONAL system binaries resolved from PATH — never an npm dependency,
// never a user-supplied path. The adapter only runs when the operator set
// VIDEO_FFMPEG_ENABLED=true; the simulated extractor is the default.
const FFMPEG_BINARY = 'ffmpeg';
const FFPROBE_BINARY = 'ffprobe';

// Ephemeral scratch location for BUFFER inspection (the pre-storage upload
// screen): ffprobe/ffmpeg need a real file for reliable container probing,
// so the in-memory bytes are written to a per-session directory in the OS
// temp dir — deliberately OUTSIDE the durable storage root, with owner-only
// modes (0o700 dir / 0o600 file) — and removed in every path. Scratch
// paths never leak: every failure maps to the same controlled, path-free
// errors as the storage-key paths.
export const SCRATCH_DIR_PREFIX = 'byond-video-inspect-';
const SCRATCH_FILE_NAME = 'inspect.media';
const SCRATCH_DIR_MODE = 0o700;
const SCRATCH_FILE_MODE = 0o600;

// Crash-recovery scavenger threshold. Normal paths always remove the
// scratch dir, but a process crash / SIGKILL / host restart between the
// write and close() would strand it forever — so every inspectBuffer call
// first sweeps abandoned SCRATCH_DIR_PREFIX dirs. 15 minutes is FAR beyond
// any bounded live inspection (a session runs a handful of 30 s-capped
// execs over at most a few frames), so a concurrent live session's dir can
// never be swept, while a crashed process's dir is reclaimed on the next
// upload attempt.
export const SCRATCH_ABANDONED_AFTER_MS = 15 * 60 * 1000;

// Entries examined per sweep are capped so a pathological tmpdir (or a
// hostile local process minting prefix-matching dirs) cannot add unbounded
// latency to an upload; anything beyond the cap waits for the next sweep.
export const SCRATCH_SWEEP_MAX_DIRS = 50;

// Decoded PNG frames are bounded (a single 4K PNG is well under this); the
// cap exists so a hostile container cannot balloon the parent process.
// Exported: it is the ceiling every caller-supplied maxBytes is clamped to.
export const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;

// Request-wide decoded-byte budget for multi-frame extraction: the
// per-invocation maxBuffer bounds ONE frame, but a maxFrames batch retains
// every decoded frame until the service persists the batch — without an
// aggregate cap a valid request could hold maxFrames × MAX_OUTPUT_BYTES in
// heap at once.
export const MAX_TOTAL_EXTRACTION_BYTES = 128 * 1024 * 1024;

// Probe ceilings for controlled TEST clips. ffprobe output is derived from
// attacker-supplied container metadata: without upper bounds a tiny crafted
// upload can claim an arbitrarily large duration (overflowing the
// PostgreSQL Int column → uncontrolled 500) or absurd geometry that makes
// later full-frame decodes consume extreme memory. Anything outside these
// generous-for-test-footage limits is a controlled rejection.
export const MAX_PROBE_DURATION_MS = 3_600_000; // 1 hour
export const MAX_PROBE_DIMENSION = 16_384;
export const MAX_PROBE_PIXELS = 33_177_600; // 7680×4320 (8K)
export const MAX_PROBE_FPS = 240;

/** Integers only — a non-integer here means a validation layer was skipped. */
function assertBoundedInt(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 2_147_483_647) {
    throw new ExtractionFailedError();
  }
  void field;
  return value;
}

/**
 * Argument builders are PURE and exported for tests: every numeric value is
 * asserted to be a bounded non-negative integer before it becomes an
 * argument, arguments are passed as a vector to execFile (NO shell, no
 * string interpolation into a command line), and the only path argument is
 * the storage adapter's root-confined internal path.
 */
export function buildProbeArgs(internalPath: string): string[] {
  return [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    '-select_streams',
    'v:0',
    internalPath,
  ];
}

export function buildFrameArgs(
  internalPath: string,
  timestampMs: number,
): string[] {
  const ts = assertBoundedInt(timestampMs, 'timestampMs');
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-ss',
    (ts / 1000).toFixed(3),
    '-i',
    internalPath,
    '-frames:v',
    '1',
    '-f',
    'image2pipe',
    '-vcodec',
    'png',
    'pipe:1',
  ];
}

export function buildCropArgs(
  internalPath: string,
  timestampMs: number,
  box: CropBox,
): string[] {
  const ts = assertBoundedInt(timestampMs, 'timestampMs');
  const width = assertBoundedInt(box.width, 'width');
  const height = assertBoundedInt(box.height, 'height');
  const x = assertBoundedInt(box.x, 'x');
  const y = assertBoundedInt(box.y, 'y');
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-ss',
    (ts / 1000).toFixed(3),
    '-i',
    internalPath,
    '-frames:v',
    '1',
    '-vf',
    `crop=${width}:${height}:${x}:${y}`,
    '-f',
    'image2pipe',
    '-vcodec',
    'png',
    'pipe:1',
  ];
}

interface ProbeStream {
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  duration?: string;
  side_data_list?: { rotation?: number }[];
}

interface ProbeOutput {
  streams?: ProbeStream[];
  format?: { duration?: string };
}

function parseRate(rate: string | undefined): number {
  const [num, den] = (rate ?? '').split('/').map(Number);
  return num && den ? num / den : Number.NaN;
}

export function parseProbeOutput(stdout: string): VideoProbeResult {
  let parsed: ProbeOutput;
  try {
    parsed = JSON.parse(stdout) as ProbeOutput;
  } catch {
    throw new ExtractionFailedError();
  }
  const stream = parsed.streams?.[0];
  const durationSeconds = Number(
    stream?.duration ?? parsed.format?.duration ?? Number.NaN,
  );
  // Rotation side-data: phone portrait videos store landscape coded
  // dimensions plus a ±90° rotation, and ffmpeg AUTOROTATES its output —
  // the probe must report the DISPLAY geometry or every crop-box bound and
  // artifact dimension would be validated against the wrong axes.
  const rotation = Math.abs(
    stream?.side_data_list?.find(
      (data) => typeof data.rotation === 'number',
    )?.rotation ?? 0,
  );
  const swapAxes = rotation % 180 === 90;
  const width = (swapAxes ? stream?.height : stream?.width) ?? 0;
  const height = (swapAxes ? stream?.width : stream?.height) ?? 0;
  // avg_frame_rate is the honest rate for variable-frame-rate sources
  // (screen recordings, MediaRecorder output); r_frame_rate is the
  // container TICK rate there and can read 1000+ fps, which would bounce
  // off the sanity cap and reject a legitimate clip. Fall back to
  // r_frame_rate when avg is absent/degenerate ("0/0").
  const avgFps = parseRate(stream?.avg_frame_rate);
  const fps =
    Number.isFinite(avgFps) && avgFps > 0
      ? avgFps
      : parseRate(stream?.r_frame_rate);
  const durationMs = Math.round(durationSeconds * 1000);
  if (
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    // A positive sub-0.5 ms duration ROUNDS to 0, which the DB CHECK
    // (durationMs > 0) would turn into an uncontrolled 500 — reject the
    // rounded value, not just the raw seconds.
    durationMs <= 0 ||
    durationMs > MAX_PROBE_DURATION_MS ||
    !Number.isInteger(width) ||
    width <= 0 ||
    width > MAX_PROBE_DIMENSION ||
    !Number.isInteger(height) ||
    height <= 0 ||
    height > MAX_PROBE_DIMENSION ||
    width * height > MAX_PROBE_PIXELS ||
    !Number.isFinite(fps) ||
    fps <= 0 ||
    fps > MAX_PROBE_FPS
  ) {
    throw new ExtractionFailedError();
  }
  return { durationMs, width, height, fps };
}

type RunCommand = (
  binary: string,
  args: string[],
  maxOutputBytes: number,
) => Promise<{ stdout: Buffer }>;

/** Error shape execFile produces: exit failures carry a NUMERIC code, spawn/
 *  OS failures a STRING errno, kills a signal/killed flag. */
interface CommandError {
  code?: string | number | null;
  killed?: boolean;
  signal?: string | null;
  message?: string;
}

/**
 * The exec output overran the invocation's maxBuffer cap. Recognized
 * separately from the general classification so a DELIBERATELY tightened
 * cap (a caller-supplied budget below the adapter's own ceiling) can map
 * to FrameExceedsBudgetError instead of an infrastructure failure.
 */
export function isMaxBufferOverflow(error: unknown): boolean {
  const failure = (error ?? {}) as CommandError;
  return (
    failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ||
    (typeof failure.message === 'string' &&
      failure.message.includes('maxBuffer'))
  );
}

/**
 * Classify a child-process failure so INFRASTRUCTURE problems stay
 * retryable instead of permanently rejecting a valid asset:
 *
 * - Missing binary (spawn ENOENT) → ExtractorUnavailableError: the host has
 *   no ffmpeg/ffprobe at all (503, no status change — existing behavior).
 * - Killed process (timeout kill sets `killed`/`signal`; an external
 *   SIGKILL sets `signal` alone) → ExtractionInfrastructureError: the tool
 *   never got to judge the file.
 * - Output overran maxBuffer (code ERR_CHILD_PROCESS_STDIO_MAXBUFFER, or
 *   the pre-code Node message naming maxBuffer) →
 *   ExtractionInfrastructureError: a parent-side cap fired, not a verdict
 *   on the video.
 * - Any other STRING errno (EACCES, EAGAIN, ENOMEM, EMFILE, ...) →
 *   ExtractionInfrastructureError: the OS refused to run the tool.
 * - NUMERIC exit code (the tool RAN and reported failure) or an unknown
 *   error shape → ExtractionFailedError: genuine content failure.
 *
 * Exported for tests; never echoes stderr, signals, errno values, or paths.
 */
export function classifyCommandError(error: unknown): Error {
  const failure = (error ?? {}) as CommandError;
  if (failure.code === 'ENOENT') {
    return new ExtractorUnavailableError();
  }
  if (failure.killed === true || typeof failure.signal === 'string') {
    return new ExtractionInfrastructureError();
  }
  if (isMaxBufferOverflow(error)) {
    return new ExtractionInfrastructureError();
  }
  if (typeof failure.code === 'string') {
    return new ExtractionInfrastructureError();
  }
  return new ExtractionFailedError();
}

const defaultRunCommand: RunCommand = (binary, args, maxOutputBytes) =>
  new Promise((resolvePromise, rejectPromise) => {
    execFile(
      binary,
      args,
      {
        encoding: 'buffer',
        // The caller passes the REMAINING request budget, so a single
        // invocation can never allocate past the aggregate ceiling.
        maxBuffer: maxOutputBytes,
        timeout: COMMAND_TIMEOUT_MS,
        windowsHide: true,
        // No shell: arguments reach the binary as a vector, so no value can
        // be reinterpreted as shell syntax.
        shell: false,
      },
      (error, stdout) => {
        if (error) {
          rejectPromise(error);
          return;
        }
        resolvePromise({ stdout });
      },
    );
  });

/**
 * OPTIONAL local extraction via the system ffmpeg/ffprobe binaries. Command
 * execution is injectable so tests never spawn a process; failures map to
 * controlled errors that never echo stderr, binary paths, or file paths.
 */
@Injectable()
export class FfmpegVideoFrameExtractor extends VideoFrameExtractorPort {
  readonly kind = FFMPEG_EXTRACTOR_KIND;

  // Frames come from decoding the stored media — byte-inspecting surfaces
  // (the quarantine screening preview) may serve from this adapter.
  readonly readsRealBytes = true;

  constructor(
    // The CONCRETE local adapter, not the neutral port: only local storage
    // has filesystem paths, and this adapter is local-only by definition.
    private readonly storage: LocalVideoStorageAdapter,
    private readonly runCommand: RunCommand = defaultRunCommand,
  ) {
    super();
  }

  private async run(
    binary: string,
    args: string[],
    maxOutputBytes: number,
  ): Promise<Buffer> {
    try {
      const { stdout } = await this.runCommand(binary, args, maxOutputBytes);
      return stdout;
    } catch (error) {
      throw classifyCommandError(error);
    }
  }

  async probe(storageKey: string): Promise<VideoProbeResult> {
    const stdout = await this.run(
      FFPROBE_BINARY,
      buildProbeArgs(this.storage.internalPathFor(storageKey)),
      MAX_OUTPUT_BYTES,
    );
    return parseProbeOutput(stdout.toString('utf8'));
  }

  async extractFrames(
    storageKey: string,
    probe: VideoProbeResult,
    options: FrameExtractionOptions,
  ): Promise<ExtractedImage[]> {
    const frames: ExtractedImage[] = [];
    let totalBytes = 0;
    // Duration is an EXCLUSIVE endpoint (no frame exists at durationMs) —
    // strictly-less keeps sampling provider-consistent with the simulated
    // adapter and off the empty-output failure path.
    for (
      let timestampMs = options.startMs;
      timestampMs < probe.durationMs && frames.length < options.maxFrames;
      timestampMs += options.intervalMs
    ) {
      // The budget is enforced BEFORE the next decode, not after: the
      // remaining allowance becomes the invocation's maxBuffer, so no
      // decode can even transiently allocate past the aggregate ceiling.
      const remaining = MAX_TOTAL_EXTRACTION_BYTES - totalBytes;
      if (remaining <= 0) {
        throw new ExtractionFailedError();
      }
      let frame: ExtractedImage;
      try {
        frame = await this.frameAt(
          storageKey,
          probe,
          timestampMs,
          Math.min(MAX_OUTPUT_BYTES, remaining),
        );
      } catch (error) {
        // The SHRINKING remainder tripped the exec cap: the batch cannot
        // fit its aggregate budget — the same verdict as the injected-
        // runner backstop below, never an infrastructure retry.
        if (error instanceof FrameExceedsBudgetError) {
          throw new ExtractionFailedError();
        }
        // Real containers report durations slightly past the last decodable
        // frame — end-of-stream mid-sampling is a NORMAL end condition, not
        // a batch failure. Only an empty FIRST frame means the video is
        // genuinely unreadable at the requested positions.
        if (error instanceof FrameUnavailableError && frames.length > 0) {
          break;
        }
        throw error;
      }
      // Backstop for injected runners that ignore maxOutputBytes.
      if (frame.data.length > remaining) {
        throw new ExtractionFailedError();
      }
      totalBytes += frame.data.length;
      frames.push(frame);
    }
    return frames;
  }

  async extractFrameAt(
    storageKey: string,
    probe: VideoProbeResult,
    timestampMs: number,
    options?: ExtractFrameAtOptions,
  ): Promise<ExtractedImage> {
    return this.frameAtPathWithOptions(
      this.storage.internalPathFor(storageKey),
      probe,
      timestampMs,
      options,
    );
  }

  /** Shared caller-budget handling for the storage-key and buffer paths. */
  private frameAtPathWithOptions(
    internalPath: string,
    probe: VideoProbeResult,
    timestampMs: number,
    options?: ExtractFrameAtOptions,
  ): Promise<ExtractedImage> {
    const maxBytes = options?.maxBytes;
    if (maxBytes !== undefined) {
      // A degenerate caller budget (zero/negative/non-integer) can fit no
      // frame at all — the budget verdict, decided before any exec.
      if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
        return Promise.reject(new FrameExceedsBudgetError());
      }
      return this.frameAtPath(
        internalPath,
        probe,
        timestampMs,
        // The caller cap never RAISES the adapter's own ceiling.
        Math.min(MAX_OUTPUT_BYTES, maxBytes),
      );
    }
    return this.frameAtPath(internalPath, probe, timestampMs, MAX_OUTPUT_BYTES);
  }

  private frameAt(
    storageKey: string,
    probe: VideoProbeResult,
    timestampMs: number,
    maxOutputBytes: number,
  ): Promise<ExtractedImage> {
    return this.frameAtPath(
      this.storage.internalPathFor(storageKey),
      probe,
      timestampMs,
      maxOutputBytes,
    );
  }

  private async frameAtPath(
    internalPath: string,
    probe: VideoProbeResult,
    timestampMs: number,
    maxOutputBytes: number,
  ): Promise<ExtractedImage> {
    let data: Buffer;
    try {
      const { stdout } = await this.runCommand(
        FFMPEG_BINARY,
        buildFrameArgs(internalPath, timestampMs),
        maxOutputBytes,
      );
      data = stdout;
    } catch (error) {
      // BUDGET-tripped overflow: the cap that fired was a deliberately
      // tightened one (below the adapter's own ceiling) — a verdict on the
      // budget, not on the infrastructure, so budgeted callers can skip
      // the frame. An overflow of the full ceiling keeps the existing
      // infrastructure classification.
      if (maxOutputBytes < MAX_OUTPUT_BYTES && isMaxBufferOverflow(error)) {
        throw new FrameExceedsBudgetError();
      }
      throw classifyCommandError(error);
    }
    if (data.length === 0) {
      // The command succeeded but decoded nothing — the position is past
      // the last decodable frame, not a broken video.
      throw new FrameUnavailableError();
    }
    return {
      data,
      width: probe.width,
      height: probe.height,
      mimeType: 'image/png',
      timestampMs,
    };
  }

  /**
   * IN-MEMORY inspection for the pre-storage upload screen. ffprobe/ffmpeg
   * need a real, SEEKABLE file — stdin feeding is deliberately not used
   * because probing non-faststart MP4 containers (moov atom at the end)
   * requires seeking, which a pipe cannot provide — so the buffer is
   * written to an EPHEMERAL scratch file in the OS temp dir (0o700 dir /
   * 0o600 file) — never under the durable storage root — probed there, and
   * the whole scratch directory is removed in every path: on a probe
   * failure before the session is returned, and by close() afterwards
   * (retry once, then the existing infrastructure classification — the
   * unscreened bytes are never silently left behind). Scratch write
   * failures are environmental (ENOSPC, permissions), so they map to
   * ExtractionInfrastructureError.
   *
   * Crash recovery: a crash between the write and close() would strand the
   * scratch dir, so each call FIRST runs an awaited best-effort sweep of
   * abandoned scratch dirs (see sweepAbandonedScratchDirs) — before this
   * session's own dir even exists, so the sweep can never touch it.
   */
  async inspectBuffer(data: Buffer): Promise<BufferInspectionSession> {
    // Awaited (not fire-and-forget) so "cleanup before accepting uploads"
    // is literal; runs BEFORE mkdtemp so the live session's own dir is
    // never a sweep candidate. Sweep failures never fail the inspection.
    await this.sweepAbandonedScratchDirs();
    let scratchDir: string | undefined;
    let scratchPath: string;
    try {
      scratchDir = await mkdtemp(join(tmpdir(), SCRATCH_DIR_PREFIX));
      // mkdtemp already creates 0o700 on POSIX; tighten explicitly and
      // best-effort (exotic mounts must not lose the write) like the
      // storage adapter does.
      await chmod(scratchDir, SCRATCH_DIR_MODE).catch(() => undefined);
      scratchPath = join(scratchDir, SCRATCH_FILE_NAME);
      await writeFile(scratchPath, data, {
        mode: SCRATCH_FILE_MODE,
        flag: 'wx',
      });
    } catch {
      if (scratchDir !== undefined) {
        // Never leave a partial scratch tree; a persistent removal
        // failure keeps the (correct) infrastructure classification.
        await this.removeScratchDir(scratchDir);
      }
      throw new ExtractionInfrastructureError();
    }
    let probe: VideoProbeResult;
    try {
      const stdout = await this.run(
        FFPROBE_BINARY,
        buildProbeArgs(scratchPath),
        MAX_OUTPUT_BYTES,
      );
      probe = parseProbeOutput(stdout.toString('utf8'));
    } catch (error) {
      // The caller never received a session, so the cleanup is ours. A
      // removal failure escalates as ExtractionInfrastructureError from
      // removeScratchDir (fail closed); otherwise the probe's own
      // classification propagates.
      await this.removeScratchDir(scratchDir);
      throw error;
    }
    const dir = scratchDir;
    let closed = false;
    return {
      probe,
      extractFrameAt: (timestampMs, options) =>
        this.frameAtPathWithOptions(scratchPath, probe, timestampMs, options),
      close: async () => {
        if (closed) {
          return;
        }
        closed = true;
        await this.removeScratchDir(dir);
      },
    };
  }

  /**
   * LAZY crash-recovery scavenger for scratch dirs stranded by a process
   * crash / SIGKILL / host restart mid-inspection. One readdir of the OS
   * temp dir (cheap when there is nothing to do); only entries carrying
   * the shared SCRATCH_DIR_PREFIX are considered, capped at
   * SCRATCH_SWEEP_MAX_DIRS per sweep; a dir is removed only when its mtime
   * is older than SCRATCH_ABANDONED_AFTER_MS, so a live concurrent
   * session's dir is never a candidate. Everything is best-effort: a
   * per-dir stat/removal failure is swallowed (it must not block the
   * upload or the sweep of the remaining dirs), and the whole sweep is
   * wrapped so even a readdir failure never fails the inspection. Removal
   * relies on the same rm recursive+force semantics close() uses (safe on
   * Windows). Nothing here ever surfaces a tmp path in an error.
   */
  private async sweepAbandonedScratchDirs(): Promise<void> {
    try {
      const tempRoot = tmpdir();
      const entries = await readdir(tempRoot);
      const candidates = entries
        .filter((name) => name.startsWith(SCRATCH_DIR_PREFIX))
        .slice(0, SCRATCH_SWEEP_MAX_DIRS);
      const cutoff = Date.now() - SCRATCH_ABANDONED_AFTER_MS;
      for (const name of candidates) {
        const abandonedDir = join(tempRoot, name);
        try {
          const info = await stat(abandonedDir);
          if (info.mtimeMs <= cutoff) {
            await rm(abandonedDir, { recursive: true, force: true });
          }
        } catch {
          // Best-effort per dir: one unreadable/unremovable entry must not
          // block this upload or the sweep of the other dirs.
        }
      }
    } catch {
      // The sweep is opportunistic hygiene — a readdir failure (exotic
      // tmpdir permissions) must never fail the live inspection.
    }
  }

  /** Retry-once scratch removal; a persistent failure means unscreened
   *  bytes may linger, so it surfaces as an infrastructure failure
   *  (controlled, path-free) instead of being swallowed. */
  private async removeScratchDir(scratchDir: string): Promise<void> {
    try {
      await rm(scratchDir, { recursive: true, force: true });
    } catch {
      try {
        await rm(scratchDir, { recursive: true, force: true });
      } catch {
        throw new ExtractionInfrastructureError();
      }
    }
  }

  async extractCrop(
    storageKey: string,
    probe: VideoProbeResult,
    timestampMs: number,
    box: CropBox,
  ): Promise<ExtractedImage> {
    void probe;
    const data = await this.run(
      FFMPEG_BINARY,
      buildCropArgs(this.storage.internalPathFor(storageKey), timestampMs, box),
      MAX_OUTPUT_BYTES,
    );
    if (data.length === 0) {
      throw new FrameUnavailableError();
    }
    return {
      data,
      width: box.width,
      height: box.height,
      mimeType: 'image/png',
      timestampMs,
    };
  }
}
