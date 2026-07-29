import { execFile } from 'node:child_process';
import { Injectable } from '@nestjs/common';
import {
  FrameTextRecognitionFailedError,
  FrameTextRecognitionInfrastructureError,
  FrameTextRecognizerPort,
  FrameTextRecognizerUnavailableError,
} from './frame-text-recognizer.port';

export const TESSERACT_RECOGNIZER_KIND = 'tesseract';

// OPTIONAL system binary resolved from PATH — never an npm dependency,
// never a user-supplied path. The adapter only runs when the operator set
// VIDEO_OCR_ENABLED=true; the simulated recognizer is the default. The
// binary name is CONFINED to this file and the module wiring (pinned by
// the vendor-neutrality spec, exactly like the extraction binaries).
const TESSERACT_BINARY = 'tesseract';

// Recognized text is bounded: a frame of a test clip yields at most a few
// KiB of text, so 1 MiB is generous — the cap exists so a pathological
// output can never balloon the parent process.
export const MAX_RECOGNIZED_TEXT_BYTES = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;

// How long a READINESS answer (see checkToolingReady) stays good — the same
// rationale, and the same value, as the extraction adapter's TTL: a
// pre-buffer upload gate must be cheap, so it cannot spawn a child per
// request, and an unmemoized NEGATIVE would turn one missing binary into a
// spawn storm of one failed exec per rejected upload.
export const TOOLING_READY_TTL_MS = 60_000;

// `--version` reads no input and recognizes nothing, so its kill timeout is
// far tighter than the recognition ceiling: a host where the OCR binary
// needs seconds just to print its version cannot screen inside a request.
export const TOOLING_READY_TIMEOUT_MS = 2_000;

// A version banner is a few hundred bytes; the cap bounds a hostile PATH
// entry. An overrun rejects, which reads as NOT ready (fail-closed).
const TOOLING_READY_MAX_OUTPUT_BYTES = 64 * 1024;

/**
 * Fixed argument vector: the frame bytes travel over STDIN and the text
 * comes back over STDOUT, so the pixels NEVER touch a disk path, no temp
 * file exists to clean or leak, and no user-influenced value ever becomes
 * an argument. Exported for tests.
 */
export function buildRecognizeArgs(): string[] {
  return ['stdin', 'stdout'];
}

/**
 * The READINESS vector: a fixed, single flag that makes the tool print its
 * version and exit. No frame, no path, no user-influenced value, no OCR —
 * the cheapest possible proof that the binary exists, is executable, and
 * runs. Exported for tests.
 */
export function buildVersionArgs(): string[] {
  return ['--version'];
}

/** Error shape execFile produces: exit failures carry a NUMERIC code, spawn/
 *  OS failures a STRING errno, kills a signal/killed flag. */
interface CommandError {
  code?: string | number | null;
  killed?: boolean;
  signal?: string | null;
  message?: string;
}

/**
 * Classify a child-process failure the same way the extraction adapter
 * does, so INFRASTRUCTURE problems stay retryable and are never mistaken
 * for a screening verdict:
 *
 * - Missing binary (spawn ENOENT) → FrameTextRecognizerUnavailableError.
 * - Killed process (timeout/external signal) →
 *   FrameTextRecognitionInfrastructureError.
 * - Output overran maxBuffer → FrameTextRecognitionInfrastructureError.
 * - Any other STRING errno (EACCES, EAGAIN, ENOMEM, ...) →
 *   FrameTextRecognitionInfrastructureError.
 * - NUMERIC exit code (the tool RAN and reported failure) or an unknown
 *   error shape → FrameTextRecognitionFailedError.
 *
 * Exported for tests; never echoes stderr, signals, errno values, or paths.
 */
export function classifyRecognizerError(error: unknown): Error {
  const failure = (error ?? {}) as CommandError;
  if (failure.code === 'ENOENT') {
    return new FrameTextRecognizerUnavailableError();
  }
  if (failure.killed === true || typeof failure.signal === 'string') {
    return new FrameTextRecognitionInfrastructureError();
  }
  if (
    failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ||
    (typeof failure.message === 'string' &&
      failure.message.includes('maxBuffer'))
  ) {
    return new FrameTextRecognitionInfrastructureError();
  }
  if (typeof failure.code === 'string') {
    return new FrameTextRecognitionInfrastructureError();
  }
  return new FrameTextRecognitionFailedError();
}

type RunCommand = (
  binary: string,
  args: string[],
  stdinData: Buffer,
  maxOutputBytes: number,
  /** Wall-clock kill timeout for THIS invocation. Absent means the
   *  adapter's own fixed ceiling (COMMAND_TIMEOUT_MS) — recognition passes
   *  nothing; only the cheap readiness probe tightens it. */
  timeoutMs?: number,
) => Promise<{ stdout: Buffer }>;

const defaultRunCommand: RunCommand = (
  binary,
  args,
  stdinData,
  maxOutputBytes,
  timeoutMs,
) =>
  new Promise((resolvePromise, rejectPromise) => {
    const child = execFile(
      binary,
      args,
      {
        encoding: 'buffer',
        maxBuffer: maxOutputBytes,
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
    // The tool may exit before consuming stdin (bad input, missing language
    // data): an unhandled EPIPE on the write side would crash the parent,
    // so stream errors are swallowed — the exec callback carries the real
    // verdict either way.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(stdinData);
  });

/**
 * OPTIONAL local frame-text recognition via the system OCR binary. Command
 * execution is injectable so tests never spawn a process; failures map to
 * controlled errors that never echo stderr, binary names, or paths. The
 * frame is fed over stdin — decoded pixels never touch the filesystem.
 */
@Injectable()
export class TesseractFrameTextRecognizer extends FrameTextRecognizerPort {
  readonly kind = TESSERACT_RECOGNIZER_KIND;

  // Text comes from reading the supplied frame pixels — pixel-screening
  // surfaces (the pre-storage frame screen) may rely on this adapter.
  readonly readsRealPixels = true;

  /**
   * The memoized readiness answer and when it was taken, per ADAPTER
   * INSTANCE (the module registers one, so it is process-wide in practice
   * without a module-level global tests would have to reset).
   */
  private toolingReadyCache: { ready: boolean; checkedAtMs: number } | null =
    null;

  /** The in-flight check, so a burst on a cold cache costs ONE exec. */
  private toolingReadyInFlight: Promise<boolean> | null = null;

  constructor(private readonly runCommand: RunCommand = defaultRunCommand) {
    super();
  }

  /**
   * Does the OCR tooling ACTUALLY run on this host? `readsRealPixels` only
   * says this strategy reads pixels when it works — with VIDEO_OCR_ENABLED=
   * true and no OCR binary installed the flag is still true, so a gate keyed
   * on it alone buffers an entire upload before anything fails. This runs
   * the binary.
   *
   * MEMOIZED for TOOLING_READY_TTL_MS — negatives included. Never throws:
   * every failure shape (ENOENT, EACCES, nonzero exit, timeout kill, output
   * overrun, a runner rejecting with anything at all) is simply NOT READY.
   * The error is DISCARDED unexamined, so no path, argv, errno, or stderr
   * can escape through this seam — the answer is a bare boolean and the
   * caller composes the controlled message.
   *
   * Readiness says the TOOLING RUNS. It says nothing about any frame: a
   * ready recognizer that reports no text has still proved nothing.
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
      // Belt and braces: the probe already converts every rejection to
      // `false`; this guarantees the handed-out promise cannot reject.
      .catch(() => false)
      .then((ready) => {
        this.toolingReadyCache = { ready, checkedAtMs: Date.now() };
        this.toolingReadyInFlight = null;
        return ready;
      });
    this.toolingReadyInFlight = check;
    return check;
  }

  /** One uncached readiness pass. Never rejects. */
  private async runToolingReadyProbe(): Promise<boolean> {
    try {
      await this.runCommand(
        TESSERACT_BINARY,
        buildVersionArgs(),
        // No frame: the version call reads nothing from stdin, and an
        // empty buffer closes the pipe immediately.
        Buffer.alloc(0),
        TOOLING_READY_MAX_OUTPUT_BYTES,
        TOOLING_READY_TIMEOUT_MS,
      );
      return true;
    } catch {
      // Deliberately UNBOUND: the error is never read, let alone returned
      // or logged. Missing, non-executable, killed, or exiting nonzero —
      // all of it is one word: not ready.
      return false;
    }
  }

  async recognize(frame: Buffer): Promise<string> {
    try {
      const { stdout } = await this.runCommand(
        TESSERACT_BINARY,
        buildRecognizeArgs(),
        frame,
        MAX_RECOGNIZED_TEXT_BYTES,
      );
      return stdout.toString('utf8');
    } catch (error) {
      throw classifyRecognizerError(error);
    }
  }
}
