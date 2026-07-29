import { ChildProcess, execFile, spawn } from 'node:child_process';
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
  FrameCountExceededError,
  FrameExceedsBudgetError,
  FrameExtractionOptions,
  FrameUnavailableError,
  ScreeningDeadlineExceededError,
  VideoFrameExtractorPort,
  VideoProbeResult,
} from './video-frame-extractor.port';

export const FFMPEG_EXTRACTOR_KIND = 'ffmpeg';

// OPTIONAL system binaries resolved from PATH — never an npm dependency,
// never a user-supplied path. The adapter only runs when the operator set
// VIDEO_FFMPEG_ENABLED=true; the simulated extractor is the default.
const FFMPEG_BINARY = 'ffmpeg';
const FFPROBE_BINARY = 'ffprobe';

// BUFFER inspection (the pre-storage upload screen) is IN-MEMORY ONLY: the
// unscreened bytes are fed to ffprobe/ffmpeg over STDIN (pipe:0) and never
// touch any disk — not the storage root, not the OS temp dir. The accepted
// fail-closed cost: a container whose probing requires seeking (a
// non-faststart MP4 with the moov atom at the end) cannot be read from a
// pipe, and that inspection fails with a controlled content error — the
// service rejects the upload instead of ever materializing card-bearing
// bytes on disk. Test clips must be encoded streamable (+faststart).
const PIPE_INPUT = 'pipe:0';

// Controlled, FIXED message for the pipe-probe content failure above —
// never interpolated with stderr, paths, or metadata.
export const UNSTREAMABLE_CONTAINER_MESSAGE =
  'The video container could not be read as a stream; re-encode it as a streamable (faststart) file';

// Decoded PNG frames are bounded (a single 4K PNG is well under this); the
// cap exists so a hostile container cannot balloon the parent process.
// Exported: it is the ceiling every caller-supplied maxBytes is clamped to.
export const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

// The adapter's OWN fixed ceiling on ONE exec'd command. It bounds a hung
// tool; it is NOT a screening budget. Exported because it is the value a
// caller-supplied screening deadline is clamped AGAINST: the effective
// ffprobe timeout is min(remaining aggregate budget, this) — never more.
export const COMMAND_TIMEOUT_MS = 30_000;

// Request-wide decoded-byte budget for the STORAGE-KEY multi-frame batch
// (extractFrames over already-screened, already-stored media): the
// per-invocation maxBuffer bounds ONE frame, but a maxFrames batch retains
// every decoded frame until the service persists the batch — without an
// aggregate cap a valid request could hold maxFrames × MAX_OUTPUT_BYTES in
// heap at once. It deliberately does NOT bound the screening stream
// (streamFrames): that path retains ONE frame at a time, so an aggregate
// clamp there would only kill ffmpeg part-way through a perfectly valid
// clip — the exact Codex P1 defect this budget must not recreate.
export const MAX_TOTAL_EXTRACTION_BYTES = 128 * 1024 * 1024;

// The adapter's OWN ceiling on a screening decode's wall-clock budget. A
// caller-supplied deadlineMs is clamped DOWN to it (never up), so a
// mis-configured budget can never leave an ffmpeg child attached to a
// synchronous upload request indefinitely.
export const MAX_STREAMING_DEADLINE_MS = 120_000;

// How long a READINESS answer (see checkToolingReady) stays good. The check
// exists so a pre-buffer upload gate can refuse BEFORE the multipart body is
// read; spawning a child on EVERY upload request would defeat the point of a
// cheap gate, and — worse — an unmemoized NEGATIVE would turn one missing
// binary into a spawn storm, one failed exec per rejected request. A minute
// is short enough that an operator installing ffmpeg sees the gate open
// without a restart, long enough that a request burst costs one exec.
export const TOOLING_READY_TTL_MS = 60_000;

// The readiness invocation is `-version`: it reads no input, decodes
// nothing, and returns in milliseconds, so its kill timeout is far tighter
// than the work ceiling — a host where `ffmpeg -version` needs seconds is
// not a host that can screen an upload inside a request.
export const TOOLING_READY_TIMEOUT_MS = 2_000;

// `-version` prints a banner plus the build's configure flags — a few KiB.
// The cap is generous for that and still bounds a hostile PATH entry; an
// overrun rejects, which reads as NOT ready (fail-closed, never a pass).
const TOOLING_READY_MAX_OUTPUT_BYTES = 256 * 1024;

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

/**
 * The READINESS vector: a fixed, single flag that makes the tool print its
 * banner and exit. No input, no path, no user-influenced value, no decode —
 * the cheapest possible proof that the binary exists, is executable, and
 * runs. Exported for tests.
 */
export function buildVersionArgs(): string[] {
  return ['-version'];
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

/**
 * Single-pass EXHAUSTIVE decode of STDIN bytes to a concatenated PNG
 * stream on stdout — the in-memory inspection's only frame path. There is
 * deliberately NO fps filter: an `fps=1` sample would drop every frame
 * between one-second ticks, letting content visible only between samples
 * reach storage unlooked-at — the screen must be OFFERED EVERY decoded
 * source frame. The stream is consumed INCREMENTALLY (see streamFrames):
 * ffmpeg's stdout is never retained as one buffer. No file path ever
 * appears in the vector.
 */
export function buildAllFramesArgs(): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    PIPE_INPUT,
    '-f',
    'image2pipe',
    '-vcodec',
    'png',
    'pipe:1',
  ];
}

// PNG stream signature (89 50 4E 47 0D 0A 1A 0A): every PNG in the
// image2pipe output starts with these eight bytes, and the sequence cannot
// occur inside a well-formed PNG's chunk stream by accident often enough to
// matter for splitting ffmpeg's own output.
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

const EMPTY = Buffer.alloc(0);

// Starting size of the streaming decoder's single-frame accumulator: one
// pipe chunk. It doubles from here as a frame arrives, so a multi-MiB PNG
// costs amortized O(bytes) to assemble instead of a fresh copy per chunk.
const PENDING_INITIAL_CAPACITY = 64 * 1024;

/** Options for one streaming screening decode of in-memory bytes. */
export interface StreamFramesOptions {
  maxFrames: number;
  maxBytesPerFrame: number;
  /** Wall-clock budget for the WHOLE decode. */
  deadlineMs: number;
  onFrame: (frame: Buffer, index: number) => Promise<'continue' | 'stop'>;
}

export interface StreamFramesResult {
  framesSeen: number;
  stoppedEarly: boolean;
}

/**
 * Why the decode was abandoned BY US. Recorded before the signal is sent
 * so the child's own 'close'/'error' events can never misread a kill we
 * initiated as an infrastructure failure (that misreading is what turned a
 * budget verdict into a retryable 503 before).
 */
type AbortReason = 'stop' | 'frame-bytes' | 'frame-count' | 'deadline' | 'callback';

/**
 * Why an exec'd PROBE would have been killed BY THE BUDGET rather than by
 * the adapter's own fixed command ceiling. Recorded BEFORE the child can
 * exist — exactly the bookkeeping-first discipline streamFrames uses — so a
 * kill under a binding aggregate budget is read as the DEADLINE verdict and
 * a kill at the fixed ceiling keeps the infrastructure classification. The
 * two can never be confused because the reason is decided by which bound
 * was actually in force, not by inspecting the kill after the fact.
 *
 * A TIE (remaining budget EXACTLY the command ceiling — the default 30 s
 * screening budget hits this on its very first probe) is the CALLER's
 * budget: the caller asked for no more than that much wall clock, so a kill
 * at that instant is the caller's allowance running out, not the host
 * misbehaving. Only a budget STRICTLY GREATER than the ceiling (or no
 * budget at all) leaves the adapter's own ceiling as the binding bound.
 */
type ProbeAbortReason = 'deadline';

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
  /** When present, the child's ENTIRE stdin — the in-memory inspection
   *  path feeds unscreened bytes this way so they never touch disk. */
  stdin?: Buffer,
  /** Wall-clock kill timeout for THIS invocation. Absent means the
   *  adapter's own fixed ceiling (COMMAND_TIMEOUT_MS); the screening
   *  probe passes min(remaining aggregate budget, that ceiling). */
  timeoutMs?: number,
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
 * The child was KILLED rather than allowed to exit: a timeout kill sets
 * `killed` (plus a signal), an external SIGKILL sets the signal alone.
 * Recognized separately so a kill that happened under a BINDING screening
 * budget can map to the deadline verdict instead of the infrastructure
 * classification — the timing analogue of isMaxBufferOverflow.
 */
export function isProcessKill(error: unknown): boolean {
  const failure = (error ?? {}) as CommandError;
  return failure.killed === true || typeof failure.signal === 'string';
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
  if (isProcessKill(error)) {
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

const defaultRunCommand: RunCommand = (
  binary,
  args,
  maxOutputBytes,
  stdin,
  timeoutMs,
) =>
  new Promise((resolvePromise, rejectPromise) => {
    const child = execFile(
      binary,
      args,
      {
        encoding: 'buffer',
        // The caller passes the REMAINING request budget, so a single
        // invocation can never allocate past the aggregate ceiling.
        maxBuffer: maxOutputBytes,
        // Likewise for TIME: the caller passes the already-clamped
        // effective timeout, and no caller can raise the fixed ceiling.
        timeout: timeoutMs ?? COMMAND_TIMEOUT_MS,
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
    if (stdin !== undefined && child.stdin) {
      // A child that exits before draining stdin (ffprobe stops reading
      // once it has — or cannot get — what it needs) raises EPIPE here;
      // swallowing it is CORRECT: the promise settles from the child's own
      // outcome via the execFile callback, so classification follows the
      // exit/kill/errno shape, never the pipe write.
      child.stdin.on('error', () => undefined);
      child.stdin.end(stdin);
    }
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

  /**
   * The memoized readiness answer and the wall-clock instant it was taken,
   * held per ADAPTER INSTANCE (the module registers one, so the cache is
   * process-wide in practice without a module-level global that tests would
   * have to reset between cases).
   */
  private toolingReadyCache: { ready: boolean; checkedAtMs: number } | null =
    null;

  /**
   * The in-flight check, so a burst of concurrent uploads arriving on a cold
   * cache collapses onto ONE exec instead of one each — the same "cheap
   * gate" reason the TTL exists.
   */
  private toolingReadyInFlight: Promise<boolean> | null = null;

  constructor(
    // The CONCRETE local adapter, not the neutral port: only local storage
    // has filesystem paths, and this adapter is local-only by definition.
    private readonly storage: LocalVideoStorageAdapter,
    private readonly runCommand: RunCommand = defaultRunCommand,
  ) {
    super();
  }

  /**
   * Does the extraction tooling ACTUALLY run on this host? `readsRealBytes`
   * only says this strategy decodes real bytes when it works — with
   * VIDEO_FFMPEG_ENABLED=true and no ffmpeg installed the flag is still
   * true, so a gate keyed on it alone buffers an entire upload before
   * anything fails. This runs the binaries.
   *
   * BOTH binaries are checked, ffprobe AND ffmpeg: a screen needs the probe
   * AND the decode, so a host with only one of them cannot screen an
   * upload, and reporting ready on the strength of one would recreate the
   * very "the gate passed, then the work failed" hole this closes.
   *
   * MEMOIZED for TOOLING_READY_TTL_MS — negatives included. Never throws:
   * every failure shape (ENOENT, EACCES, nonzero exit, timeout kill,
   * output overrun, a runner that rejects with anything at all) is simply
   * NOT READY. The error object is DISCARDED unexamined, so no path, argv,
   * errno, or stderr can escape through this seam — the answer is a bare
   * boolean and the caller composes the controlled message.
   *
   * Readiness says the TOOLING RUNS. It says nothing about any clip.
   */
  checkToolingReady(): Promise<boolean> {
    const cached = this.toolingReadyCache;
    if (
      cached !== null &&
      Date.now() - cached.checkedAtMs < TOOLING_READY_TTL_MS
    ) {
      return Promise.resolve(cached.ready);
    }
    if (this.toolingReadyInFlight !== null) {
      return this.toolingReadyInFlight;
    }
    const check = this.runToolingReadyProbe()
      // Belt and braces: the probe below already converts every rejection
      // to `false`, and this guarantees the promise this method hands out
      // can never reject even if that changes.
      .catch(() => false)
      .then((ready) => {
        this.toolingReadyCache = { ready, checkedAtMs: Date.now() };
        this.toolingReadyInFlight = null;
        return ready;
      });
    this.toolingReadyInFlight = check;
    return check;
  }

  /** One uncached readiness pass over both binaries. Never rejects. */
  private async runToolingReadyProbe(): Promise<boolean> {
    for (const binary of [FFPROBE_BINARY, FFMPEG_BINARY]) {
      try {
        await this.runCommand(
          binary,
          buildVersionArgs(),
          TOOLING_READY_MAX_OUTPUT_BYTES,
          undefined,
          TOOLING_READY_TIMEOUT_MS,
        );
      } catch {
        // Deliberately UNBOUND: the error is never read, let alone
        // returned or logged. Missing, non-executable, killed, chatty,
        // or exiting nonzero — all of it is one word: not ready.
        return false;
      }
    }
    return true;
  }

  private async run(
    binary: string,
    args: string[],
    maxOutputBytes: number,
    stdin?: Buffer,
  ): Promise<Buffer> {
    try {
      const { stdout } = await this.runCommand(
        binary,
        args,
        maxOutputBytes,
        stdin,
      );
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
   * IN-MEMORY inspection for the pre-storage upload screen. The unstored
   * bytes NEVER touch any disk: ffprobe reads them from STDIN (pipe:0) and
   * the single-pass EXHAUSTIVE frame decode (every source frame — no fps
   * filter) feeds the same buffer to ffmpeg's stdin, PUSHING each PNG to
   * the caller as the stdout stream delimits it (see streamFrames — the
   * stream is never retained whole). A container whose probing
   * requires seeking (non-faststart MP4, moov atom at the end) cannot be
   * read from a pipe — the tool exits nonzero and the inspection FAILS
   * CLOSED with a controlled unstreamable-container content error (the
   * service rejects the upload). That is the documented, accepted cost of
   * keeping card-bearing bytes off disk; infrastructure failures classify
   * exactly as on the storage-key paths. Opening never runs tooling —
   * probe() does, memoized — and close() only releases references, so it
   * is trivially idempotent and a crash can leak nothing.
   *
   * TIME BUDGET: the caller's aggregate screening allowance covers BOTH
   * tool stages. probe() takes the remaining slice as `deadlineMs` and
   * clamps the ffprobe timeout to min(that, COMMAND_TIMEOUT_MS);
   * streamFrames() takes what is left after probing. Either stage running
   * out gives the same ScreeningDeadlineExceededError verdict, so no
   * external tool can run past the upload-wide bound on its own ceiling.
   *
   * The frames this session yields are a REJECTION signal only: they let
   * the caller refuse an upload whose pixels show card or credential
   * content. A stream that trips nothing proves NOTHING about the clip,
   * and neither does a successful probe.
   */
  inspectBuffer(data: Buffer): Promise<BufferInspectionSession> {
    let bytes: Buffer | null = data;
    let memoizedProbe: Promise<VideoProbeResult> | undefined;

    const probe = (options?: {
      deadlineMs?: number;
    }): Promise<VideoProbeResult> => {
      if (memoizedProbe === undefined) {
        if (bytes === null) {
          // Closed session: the bytes are gone, a controlled content
          // failure (a caller bug, never an infrastructure retry).
          return Promise.reject(new ExtractionFailedError());
        }
        // Memoized INCLUDING failure — the verdict on these bytes cannot
        // change, so the tooling never re-runs for the same session. The
        // FIRST call's budget is therefore the only one that ever applies:
        // later calls return this same settled promise and their own
        // options are deliberately IGNORED (re-running under a second
        // budget would re-run the tooling, which this memoization exists
        // to prevent).
        memoizedProbe = this.probeFromStdin(bytes, options?.deadlineMs);
      }
      return memoizedProbe;
    };

    return Promise.resolve({
      probe,
      streamFrames: (options: StreamFramesOptions) => {
        // A degenerate per-frame budget (zero/negative/non-integer) can fit
        // no frame at all — the budget verdict, decided before any spawn.
        if (
          !Number.isInteger(options.maxBytesPerFrame) ||
          options.maxBytesPerFrame <= 0
        ) {
          return Promise.reject(new FrameExceedsBudgetError());
        }
        // A degenerate frame cap can fit no frame COUNT at all — the frame
        // budget verdict, also decided before any spawn.
        if (!Number.isInteger(options.maxFrames) || options.maxFrames <= 0) {
          return Promise.reject(new FrameCountExceededError());
        }
        // A degenerate deadline leaves no time to decode anything — the
        // time-budget verdict, decided before any spawn.
        if (!Number.isInteger(options.deadlineMs) || options.deadlineMs <= 0) {
          return Promise.reject(new ScreeningDeadlineExceededError());
        }
        if (bytes === null) {
          return Promise.reject(new ExtractionFailedError());
        }
        return this.streamFramesFromStdin(bytes, options);
      },
      close: () => {
        // In-memory only: release the references (idempotent by nature —
        // there is no disk state to remove and nothing a crash can leak).
        bytes = null;
        memoizedProbe = undefined;
        return Promise.resolve();
      },
    });
  }

  /**
   * The STREAMING screening decode: one ffmpeg child reading the unstored
   * bytes from stdin and writing every decoded source frame to stdout as
   * concatenated PNGs, consumed INCREMENTALLY.
   *
   * Why streaming rather than one buffered pass: the concatenated PNG
   * stream of a normal multi-second 720p/1080p clip is hundreds of MiB —
   * ANY aggregate stdout clamp is crossed long before the frame budget, so
   * a buffered pass killed ffmpeg on perfectly valid uploads and (because
   * the clamp equalled the adapter's own ceiling) reported it as an
   * infrastructure failure: a 503 and a FAILED row for a clip well inside
   * the advertised duration/frame budgets. Here stdout is parsed as it
   * arrives, each frame is handed to onFrame the moment the NEXT PNG
   * signature (or end of stream) delimits it, and the reference is dropped
   * immediately after — peak memory is O(one frame), never O(stream), and
   * MAX_TOTAL_EXTRACTION_BYTES does not apply.
   *
   * Backpressure: stdout is paused for the whole time a chunk is being
   * consumed (including any awaited onFrame) and resumed after, so a slow
   * screener throttles the decoder instead of filling the heap.
   *
   * Abandonment is always OUR bookkeeping first, the signal second: the
   * abort reason is recorded before the child is killed, so a kill for a
   * screening hit, a byte/count budget, a deadline, or a caller-callback
   * failure can never be reclassified as an infrastructure failure by the
   * 'close' handler. Only exits and signals we did NOT initiate go through
   * classifyCommandError.
   */
  private streamFramesFromStdin(
    bytes: Buffer,
    options: StreamFramesOptions,
  ): Promise<StreamFramesResult> {
    // Caller caps never RAISE the adapter's own ceilings.
    const perFrameCap = Math.min(MAX_OUTPUT_BYTES, options.maxBytesPerFrame);
    const deadlineMs = Math.min(MAX_STREAMING_DEADLINE_MS, options.deadlineMs);
    return new Promise<StreamFramesResult>((resolveResult, rejectResult) => {
      let child: ChildProcess;
      try {
        child = spawn(FFMPEG_BINARY, buildAllFramesArgs(), {
          windowsHide: true,
          // No shell: arguments reach the binary as a vector.
          shell: false,
          // stderr is DISCARDED at the OS level: it is attacker-tinted text
          // this adapter must never echo, and an undrained stderr pipe
          // would deadlock a chatty decode.
          stdio: ['pipe', 'pipe', 'ignore'],
        });
      } catch (error) {
        rejectResult(classifyCommandError(error));
        return;
      }
      const stdout = child.stdout;
      if (stdout === null) {
        try {
          child.kill('SIGKILL');
        } catch {
          // Nothing to report: the child never became usable.
        }
        rejectResult(new ExtractionInfrastructureError());
        return;
      }

      let settled = false;
      let aborted: AbortReason | null = null;
      let framesSeen = 0;
      // Accumulator for the CURRENT, not-yet-delimited frame ONLY: a
      // ZERO-FILLED (never allocUnsafe — no uninitialized memory can reach
      // a screener) buffer that GROWS BY DOUBLING and is compacted in
      // place as frames leave, so appending a 64 KiB pipe chunk to a
      // multi-MiB frame costs amortized O(chunk), not a fresh copy of the
      // whole frame. `pendingLength` is the live length; everything past
      // it is stale.
      let pending: Buffer = EMPTY;
      let pendingLength = 0;
      // The first PNG signature has been seen (leading noise discarded).
      let started = false;
      // How far into the live bytes the signature scan already reached, so
      // a frame arriving in many chunks is scanned once, not once per chunk.
      let scanned = 0;
      // Serializes chunk consumption (and therefore onFrame calls) in
      // arrival order regardless of how the events interleave.
      let queue: Promise<void> = Promise.resolve();

      const finish = (): void => {
        clearTimeout(timer);
        pending = EMPTY;
        pendingLength = 0;
      };
      const resolveOnce = (result: StreamFramesResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        finish();
        resolveResult(result);
      };
      const rejectOnce = (error: unknown): void => {
        if (settled) {
          return;
        }
        settled = true;
        finish();
        rejectResult(error);
      };

      const killChild = (signal: NodeJS.Signals): void => {
        try {
          child.stdin?.destroy();
        } catch {
          // Already gone — nothing to release.
        }
        try {
          stdout.destroy();
        } catch {
          // Already gone — nothing to release.
        }
        try {
          child.kill(signal);
        } catch {
          // The child already exited; the abort reason still stands.
        }
      };

      /** Abandon the decode for a reason WE own. */
      const abort = (reason: AbortReason, cause?: unknown): void => {
        if (settled || aborted !== null) {
          return;
        }
        aborted = reason;
        // A screening hit is a graceful stop (the decode did its job);
        // budget/deadline/callback failures stop the child hard.
        killChild(reason === 'stop' ? 'SIGTERM' : 'SIGKILL');
        if (reason === 'stop') {
          resolveOnce({ framesSeen, stoppedEarly: true });
          return;
        }
        if (reason === 'frame-bytes') {
          rejectOnce(new FrameExceedsBudgetError());
          return;
        }
        if (reason === 'frame-count') {
          rejectOnce(new FrameCountExceededError());
          return;
        }
        if (reason === 'deadline') {
          rejectOnce(new ScreeningDeadlineExceededError());
          return;
        }
        // 'callback': the caller's own failure propagates UNCHANGED — the
        // adapter never reclassifies a screener error as a decode verdict.
        rejectOnce(cause);
      };

      const timer = setTimeout(() => abort('deadline'), deadlineMs);
      // A decode must never keep the process alive on its own.
      timer.unref?.();

      /** Hand ONE delimited frame to the caller, then forget it. */
      const emit = async (frame: Buffer): Promise<void> => {
        if (settled || aborted !== null) {
          return;
        }
        if (frame.length > perFrameCap) {
          abort('frame-bytes');
          return;
        }
        if (framesSeen >= options.maxFrames) {
          // One frame past the cap: fail closed with the controlled count
          // verdict (no counts echoed), never a silent truncation.
          abort('frame-count');
          return;
        }
        const index = framesSeen;
        framesSeen += 1;
        const verdict = await options.onFrame(frame, index);
        if (verdict === 'stop') {
          abort('stop');
        }
      };

      /** Append a chunk, doubling the accumulator only when it must grow. */
      const append = (chunk: Buffer): void => {
        const needed = pendingLength + chunk.length;
        if (needed > pending.length) {
          // The accumulator never legitimately exceeds one frame plus the
          // chunk that completed it — the byte cap below fires first.
          const capacity = Math.min(
            Math.max(pending.length * 2, needed, PENDING_INITIAL_CAPACITY),
            Math.max(needed, perFrameCap + chunk.length),
          );
          const grown = Buffer.alloc(capacity);
          pending.copy(grown, 0, 0, pendingLength);
          pending = grown;
        }
        chunk.copy(pending, pendingLength);
        pendingLength = needed;
      };

      /** Drop the first `count` bytes, compacting the rest in place. */
      const discardFront = (count: number): void => {
        pending.copyWithin(0, count, pendingLength);
        pendingLength -= count;
      };

      /** Parse one stdout chunk, emitting every frame it completes. */
      const consume = async (chunk: Buffer): Promise<void> => {
        if (settled || aborted !== null) {
          return;
        }
        append(chunk);
        if (!started) {
          const first = pending.subarray(0, pendingLength).indexOf(PNG_SIGNATURE);
          if (first === -1) {
            // Retain only what could still be the head of a signature that
            // straddles the chunk boundary; leading noise is dropped.
            discardFront(
              Math.max(0, pendingLength - (PNG_SIGNATURE.length - 1)),
            );
            return;
          }
          discardFront(first);
          started = true;
          scanned = PNG_SIGNATURE.length;
        }
        for (;;) {
          // Resume the scan a signature-length short of the last position
          // so a signature split across chunks is still found, exactly once.
          const from = Math.max(
            PNG_SIGNATURE.length,
            scanned - (PNG_SIGNATURE.length - 1),
          );
          const next = pending
            .subarray(0, pendingLength)
            .indexOf(PNG_SIGNATURE, from);
          if (next === -1) {
            scanned = pendingLength;
            break;
          }
          // The frame is COPIED out (the accumulator is reused) and the
          // bytes leave it BEFORE the callback runs: nothing already handed
          // over is ever retained here.
          const frame = Buffer.from(pending.subarray(0, next));
          discardFront(next);
          scanned = PNG_SIGNATURE.length;
          await emit(frame);
          if (settled || aborted !== null) {
            return;
          }
        }
        // Only the trailing, still-INCOMPLETE frame is bounded here — a
        // chunk carrying several small frames is not their sum.
        if (pendingLength > perFrameCap) {
          abort('frame-bytes');
        }
      };

      const fail = (error: unknown): void => {
        // A rejection out of the consumption chain is the CALLER's (onFrame
        // threw): abandon the decode and surface their error unchanged.
        abort('callback', error);
      };

      stdout.on('error', () => undefined);
      stdout.on('data', (chunk: Buffer) => {
        if (settled || aborted !== null) {
          return;
        }
        // Backpressure: read nothing more while this chunk — and any frame
        // it hands to the screener — is outstanding.
        stdout.pause();
        queue = queue
          .then(() => consume(chunk))
          .then(() => {
            if (!settled && aborted === null) {
              stdout.resume();
            }
          })
          .catch(fail);
      });

      child.on('error', (error: unknown) => {
        if (settled || aborted !== null) {
          // A kill WE initiated is never an infrastructure verdict.
          return;
        }
        rejectOnce(classifyCommandError(error));
      });

      child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        if (settled || aborted !== null) {
          return;
        }
        queue = queue
          .then(async () => {
            if (settled || aborted !== null) {
              return;
            }
            if (typeof signal === 'string' || (code !== null && code !== 0)) {
              // An exit or signal we did NOT initiate: the standard
              // infrastructure-vs-content classification decides.
              rejectOnce(
                classifyCommandError({
                  code: typeof signal === 'string' ? null : code,
                  signal,
                }),
              );
              return;
            }
            // Anything buffered behind a pause() still counts as screened
            // input — drain it before judging the stream.
            for (;;) {
              const rest =
                typeof stdout.read === 'function'
                  ? (stdout.read() as Buffer | null)
                  : null;
              if (rest === null || rest === undefined || rest.length === 0) {
                break;
              }
              await consume(rest);
              if (settled || aborted !== null) {
                return;
              }
            }
            // The LAST frame has no following signature: end of stream is
            // what delimits it.
            if (started && pendingLength > 0) {
              const tail = Buffer.from(pending.subarray(0, pendingLength));
              pending = EMPTY;
              pendingLength = 0;
              await emit(tail);
              if (settled || aborted !== null) {
                return;
              }
            }
            if (framesSeen === 0) {
              // The decode SUCCEEDED but yielded nothing — no decodable
              // frame exists, not a broken tool.
              rejectOnce(new FrameUnavailableError());
              return;
            }
            // FEW frames resolve AS-IS: sufficiency is the service's
            // verdict, never grounds for an adapter throw.
            resolveOnce({ framesSeen, stoppedEarly: false });
          })
          .catch(fail);
      });

      if (child.stdin) {
        // A child that stops reading (killed early on a screening hit, or
        // done with the container) raises EPIPE here; swallowing it is
        // CORRECT — the promise settles from the child's own outcome or
        // from our recorded abort reason, never from the pipe write.
        child.stdin.on('error', () => undefined);
        child.stdin.end(bytes);
      }
    });
  }

  /**
   * STDIN probe for the in-memory inspection: the tool running and
   * refusing the piped container (numeric exit — moov-at-end MP4s land
   * here) is the controlled unstreamable-container content failure;
   * spawn/errno/maxBuffer keep the standard classification.
   *
   * TIME: probing is the FIRST external-tool stage of a screen, so it runs
   * INSIDE the caller's aggregate wall-clock budget, not beside it. The
   * effective ffprobe timeout is min(remaining aggregate budget, the
   * adapter's own fixed COMMAND_TIMEOUT_MS ceiling) — a caller budget only
   * ever tightens, never raises. Without `deadlineMs` the fixed ceiling is
   * the only bound (unchanged behavior for the storage-key callers).
   *
   * Which bound is in force is recorded BEFORE the child can be spawned
   * (the same bookkeeping-first rule streamFrames follows), so a kill is
   * attributed without guessing: killed under a BINDING aggregate budget →
   * ScreeningDeadlineExceededError, the same fail-closed verdict the
   * caller already handles for streamFrames; killed at the adapter's own
   * fixed ceiling → the existing ExtractionInfrastructureError. EQUALITY
   * counts as caller-bound (see below): the infrastructure classification
   * is reserved for a budget STRICTLY GREATER than the ceiling, or none.
   *
   * Nothing here proves the clip safe: a probe reports geometry and
   * duration only.
   */
  private async probeFromStdin(
    bytes: Buffer,
    deadlineMs?: number,
  ): Promise<VideoProbeResult> {
    // Recorded BEFORE any spawn; stays null when the adapter's own fixed
    // ceiling is the binding bound, so the two kill causes cannot mix.
    let abortReason: ProbeAbortReason | null = null;
    let timeoutMs = COMMAND_TIMEOUT_MS;
    if (deadlineMs !== undefined) {
      if (!Number.isInteger(deadlineMs) || deadlineMs <= 0) {
        // A degenerate/EXPIRED remaining budget leaves no time to probe
        // anything — the time-budget verdict, decided before any spawn,
        // exactly as streamFrames decides a degenerate deadlineMs.
        throw new ScreeningDeadlineExceededError();
      }
      timeoutMs = Math.min(COMMAND_TIMEOUT_MS, deadlineMs);
      if (deadlineMs <= COMMAND_TIMEOUT_MS) {
        // The aggregate budget — not the fixed ceiling — is what will kill
        // this child, so a kill is the DEADLINE verdict.
        //
        // The comparison is `<=`, NOT `<`: at a TIE the two bounds expire
        // at the same instant, and the caller's allowance is the one that
        // MEANS something — it asked for at most this much wall clock, so
        // running out of it is the controlled pre-storage screening
        // rejection, never a claim that the host is broken. The tie is not
        // exotic: the default 30 s aggregate screening budget IS
        // COMMAND_TIMEOUT_MS, so the very first probe of every default
        // screen lands exactly here. Classifying it as infrastructure
        // turned an ordinary slow clip into a retryable 503.
        abortReason = 'deadline';
      }
    }
    let stdout: Buffer;
    try {
      ({ stdout } = await this.runCommand(
        FFPROBE_BINARY,
        buildProbeArgs(PIPE_INPUT),
        MAX_OUTPUT_BYTES,
        bytes,
        timeoutMs,
      ));
    } catch (error) {
      if (abortReason === 'deadline' && isProcessKill(error)) {
        // Killed while the caller's budget was the binding bound: the
        // screen did not fit its time, nothing about the host is broken.
        throw new ScreeningDeadlineExceededError();
      }
      const classified = classifyCommandError(error);
      if (classified instanceof ExtractionFailedError) {
        throw new ExtractionFailedError(UNSTREAMABLE_CONTAINER_MESSAGE);
      }
      throw classified;
    }
    return parseProbeOutput(stdout.toString('utf8'));
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
