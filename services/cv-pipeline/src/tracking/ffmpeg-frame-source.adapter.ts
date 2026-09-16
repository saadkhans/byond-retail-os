import { spawn } from 'node:child_process';
import { Injectable } from '@nestjs/common';
import {
  FrameResult,
  FrameSourceOptions,
  FrameSourcePort,
} from './frame-source.port';

/**
 * REAL frame source: one ffmpeg invocation per sampled frame — connect,
 * grab a single frame as raw RGB24 at the requested geometry, exit.
 *
 * This deliberately mirrors the API's RTSP frame sampler rather than
 * inventing a second discipline, because the rules that matter are the
 * same ones:
 *
 * SOURCE SECRECY. The stream location comes from operator-managed
 * environment configuration and is used ONLY as ffmpeg's input argument.
 * It is never returned, thrown, logged, interpolated into a message, or
 * persisted. Callers learn a controlled code and nothing else.
 *
 * CREDENTIAL-FREE SOURCES ONLY. The input lands in argv, which is visible
 * to process listings and telemetry, so escaping shell metacharacters is
 * not enough — there is no shell. A scheme-shaped value must be scheme +
 * host(:port) + path with no userinfo, no query and no fragment, checked
 * BEFORE any spawn. A camera URL that needs a credential is out of scope
 * until a transport exists that keeps it out of argv.
 *
 * NO RECORDING. Frames are decoded into memory, measured by the tracker,
 * and dropped. This class writes nothing to disk.
 */

const FFMPEG_BINARY = 'ffmpeg';

/** Bounds on the per-sample wall clock, matching the API's pilot band. */
export const SAMPLE_MIN_TIMEOUT_MS = 1_000;
export const SAMPLE_MAX_TIMEOUT_MS = 60_000;

/** Bound on a file-backed seek, so a runaway index cannot ask ffmpeg to
 *  scan hours into a file. */
export const MAX_FILE_SEEK_MS = 15 * 60_000;

/**
 * Pure pre-spawn gate. A SCHEME-shaped value may be scheme + host(:port)
 * + path only; any userinfo, query or fragment rejects.
 *
 * Every rtsp/rtsps occurrence is checked wherever it appears, not just at
 * the start, so a harmless-looking prefix cannot smuggle a
 * credential-bearing camera URL past the gate. Plain filesystem paths
 * skip the start-anchored check: a Windows path is not a URL and has no
 * userinfo or query semantics.
 */
export function violatesCredentialFreeRule(value: string): boolean {
  const embedded = /rtsps?:\/\//gi;
  let match: RegExpExecArray | null;
  while ((match = embedded.exec(value)) !== null) {
    const rest = value.slice(match.index + match[0].length);
    if (rest.includes('?') || rest.includes('#')) {
      return true;
    }
    const slash = rest.indexOf('/');
    const authority = slash === -1 ? rest : rest.slice(0, slash);
    if (authority.includes('@')) {
      return true;
    }
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    return false;
  }
  if (value.includes('?') || value.includes('#')) {
    return true;
  }
  const afterScheme = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const slash = afterScheme.indexOf('/');
  const authority = slash === -1 ? afterScheme : afterScheme.slice(0, slash);
  return authority.includes('@');
}

/**
 * The ffmpeg argument vector for one frame. Exported so a test can prove
 * the shape — no shell, the source as a single argv entry, a numeric seek
 * that can never be derived from attacker-tinted text — without spawning
 * anything.
 */
export function buildFrameArgs(
  source: string,
  options: FrameSourceOptions,
): string[] {
  // Case-insensitive scheme detection: a mixed-case RTSP:// is a live
  // stream (transport flag, no seek), while a local file merely NAMED
  // something.rtsp.mp4 is file-backed and must keep advancing via seek.
  const isStream = /^rtsps?:\/\//i.test(source);
  const seekSeconds =
    !isStream && typeof options.seekMs === 'number' && options.seekMs > 0
      ? Math.min(options.seekMs, MAX_FILE_SEEK_MS) / 1000
      : null;

  return [
    '-hide_banner',
    '-loglevel',
    'error',
    // TCP for real streams: UDP loss produces torn frames on a typical
    // store network, and a torn frame reads as motion.
    ...(isStream ? ['-rtsp_transport', 'tcp'] : []),
    ...(seekSeconds !== null ? ['-ss', seekSeconds.toFixed(3)] : []),
    '-i',
    source,
    '-frames:v',
    '1',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    '-s',
    `${options.width}x${options.height}`,
    'pipe:1',
  ];
}

@Injectable()
export class FfmpegFrameSource extends FrameSourcePort {
  readonly kind = 'ffmpeg';
  readonly readsRealBytes = true;

  private readyCache: { value: boolean; checkedAt: number } | null = null;

  /** Memoized for a minute, NEGATIVES included: an uncached negative
   *  turns a missing binary into a spawn storm on a per-frame loop. */
  private static readonly READY_TTL_MS = 60_000;

  constructor(
    /** Resolved once at construction from operator configuration. Held
     *  privately and never exposed — see the source-secrecy note above. */
    private readonly source: string | null,
  ) {
    super();
  }

  async checkReady(): Promise<boolean> {
    const now = Date.now();
    if (
      this.readyCache !== null &&
      now - this.readyCache.checkedAt < FfmpegFrameSource.READY_TTL_MS
    ) {
      return this.readyCache.value;
    }
    const value = await this.probeBinary();
    this.readyCache = { value, checkedAt: now };
    return value;
  }

  async sample(options: FrameSourceOptions): Promise<FrameResult> {
    const source = this.source;
    if (source === null || source.length === 0) {
      return { ok: false, code: 'SOURCE_NOT_CONFIGURED' };
    }
    if (violatesCredentialFreeRule(source)) {
      return { ok: false, code: 'SOURCE_CREDENTIALS_UNSUPPORTED' };
    }
    const timeoutMs = Math.max(
      SAMPLE_MIN_TIMEOUT_MS,
      Math.min(options.timeoutMs, SAMPLE_MAX_TIMEOUT_MS),
    );
    const expectedBytes = options.width * options.height * 3;
    const args = buildFrameArgs(source, options);

    return new Promise<FrameResult>((resolve) => {
      let settled = false;
      const settle = (result: FrameResult) => {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      };

      let child;
      try {
        // Argument vector, NO shell: the source is one argv entry and can
        // never be re-read as shell syntax.
        child = spawn(FFMPEG_BINARY, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch {
        settle({ ok: false, code: 'TOOLING_UNAVAILABLE' });
        return;
      }

      const chunks: Buffer[] = [];
      let collected = 0;
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGKILL');
        } catch {
          // Already gone; the close handler still settles.
        }
      }, timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => {
        // Bounded: never accumulate more than one frame, however much
        // ffmpeg decides to emit.
        if (collected >= expectedBytes) {
          return;
        }
        const room = expectedBytes - collected;
        const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
        chunks.push(slice);
        collected += slice.length;
      });

      // stderr is drained and DISCARDED — it routinely echoes the input
      // argument, which is exactly what must never escape this module.
      child.stderr.on('data', () => undefined);

      child.on('error', () => {
        clearTimeout(timer);
        settle({ ok: false, code: 'TOOLING_UNAVAILABLE' });
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          settle({ ok: false, code: 'FRAME_TIMEOUT' });
          return;
        }
        if (collected < expectedBytes) {
          // A clean exit with too few bytes means the input opened but
          // produced no decodable frame; a non-zero exit means it never
          // opened. Both are controlled codes carrying nothing.
          settle({
            ok: false,
            code: code === 0 ? 'FRAME_DECODE_FAILED' : 'SOURCE_CONNECT_FAILED',
          });
          return;
        }
        settle({
          ok: true,
          frame: {
            data: Buffer.concat(chunks, expectedBytes),
            width: options.width,
            height: options.height,
            capturedAt: new Date(),
          },
        });
      });
    });
  }

  private probeBinary(): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (value: boolean) => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };
      try {
        const child = spawn(FFMPEG_BINARY, ['-version'], {
          stdio: ['ignore', 'ignore', 'ignore'],
        });
        child.on('error', () => settle(false));
        child.on('close', (code) => settle(code === 0));
      } catch {
        settle(false);
      }
    });
  }
}
