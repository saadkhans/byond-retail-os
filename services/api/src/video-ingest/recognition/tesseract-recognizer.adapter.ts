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

/**
 * Fixed argument vector: the frame bytes travel over STDIN and the text
 * comes back over STDOUT, so the pixels NEVER touch a disk path, no temp
 * file exists to clean or leak, and no user-influenced value ever becomes
 * an argument. Exported for tests.
 */
export function buildRecognizeArgs(): string[] {
  return ['stdin', 'stdout'];
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
) => Promise<{ stdout: Buffer }>;

const defaultRunCommand: RunCommand = (binary, args, stdinData, maxOutputBytes) =>
  new Promise((resolvePromise, rejectPromise) => {
    const child = execFile(
      binary,
      args,
      {
        encoding: 'buffer',
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

  constructor(private readonly runCommand: RunCommand = defaultRunCommand) {
    super();
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
