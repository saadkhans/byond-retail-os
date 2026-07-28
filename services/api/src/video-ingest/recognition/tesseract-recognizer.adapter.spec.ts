import {
  buildRecognizeArgs,
  classifyRecognizerError,
  MAX_RECOGNIZED_TEXT_BYTES,
  TesseractFrameTextRecognizer,
} from './tesseract-recognizer.adapter';
import {
  FrameTextRecognitionFailedError,
  FrameTextRecognitionInfrastructureError,
  FrameTextRecognizerUnavailableError,
} from './frame-text-recognizer.port';

/**
 * The optional system-binary recognizer NEVER spawns a process in tests:
 * the command runner is injected. These specs pin the safety invariants —
 * a FIXED stdin/stdout argument vector (frame pixels never touch a disk
 * path, no user-influenced value ever becomes an argument) and controlled
 * errors that never echo stderr, binary names, or paths.
 */
describe('TesseractFrameTextRecognizer', () => {
  it('declares a pixel-reading strategy', () => {
    const recognizer = new TesseractFrameTextRecognizer(
      jest.fn(async () => ({ stdout: Buffer.alloc(0) })),
    );
    expect(recognizer.readsRealPixels).toBe(true);
    expect(recognizer.kind).toBe('tesseract');
  });

  it('recognizes text by feeding the frame over stdin with a bounded output cap', async () => {
    const runCommand = jest.fn(async () => ({
      stdout: Buffer.from('SHELF 4 AISLE 9\n', 'utf8'),
    }));
    const recognizer = new TesseractFrameTextRecognizer(runCommand);
    const frame = Buffer.from('png-bytes');
    await expect(recognizer.recognize(frame)).resolves.toBe(
      'SHELF 4 AISLE 9\n',
    );
    expect(runCommand).toHaveBeenCalledTimes(1);
    const [, args, stdinData, maxOutputBytes] = runCommand.mock
      .calls[0] as unknown as [string, string[], Buffer, number];
    // Fixed vector: the frame travels over STDIN, never as a path arg.
    expect(args).toEqual(buildRecognizeArgs());
    expect(args).toEqual(['stdin', 'stdout']);
    expect(stdinData).toBe(frame);
    expect(maxOutputBytes).toBe(MAX_RECOGNIZED_TEXT_BYTES);
  });

  it.each([
    // Missing binary → the host cannot recognize at all.
    [{ code: 'ENOENT' }, FrameTextRecognizerUnavailableError],
    // Killed (timeout or external signal) → infrastructure, retryable.
    [{ killed: true }, FrameTextRecognitionInfrastructureError],
    [{ signal: 'SIGKILL' }, FrameTextRecognitionInfrastructureError],
    // Output overran the parent's cap → infrastructure, not a verdict.
    [
      { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' },
      FrameTextRecognitionInfrastructureError,
    ],
    [
      { message: 'stdout maxBuffer length exceeded' },
      FrameTextRecognitionInfrastructureError,
    ],
    // OS refused to run the tool → infrastructure.
    [{ code: 'EACCES' }, FrameTextRecognitionInfrastructureError],
    // The tool RAN and reported failure (numeric exit code) → content.
    [{ code: 1 }, FrameTextRecognitionFailedError],
    // Unknown shapes fail closed as content failures.
    [{}, FrameTextRecognitionFailedError],
  ])('classifies runner failure %p as %p', async (failure, expected) => {
    expect(classifyRecognizerError(failure)).toBeInstanceOf(expected);
    const recognizer = new TesseractFrameTextRecognizer(
      jest.fn(async () => {
        throw Object.assign(new Error('boom'), failure);
      }),
    );
    await expect(recognizer.recognize(Buffer.alloc(4))).rejects.toBeInstanceOf(
      expected,
    );
  });

  it('never echoes the binary name, stderr, or paths in controlled errors', async () => {
    const recognizer = new TesseractFrameTextRecognizer(
      jest.fn(async () => {
        throw Object.assign(
          new Error('spawn /usr/bin/some-binary ENOENT with /secret/path'),
          { code: 'ENOENT' },
        );
      }),
    );
    const error: Error = await recognizer
      .recognize(Buffer.alloc(4))
      .then(() => {
        throw new Error('expected rejection');
      })
      .catch((caught: Error) => caught);
    expect(error.message).not.toContain('tesseract');
    expect(error.message).not.toContain('/usr/bin');
    expect(error.message).not.toContain('/secret/path');
  });
});
