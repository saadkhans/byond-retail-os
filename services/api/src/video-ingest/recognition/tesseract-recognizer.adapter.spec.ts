import {
  buildRecognizeArgs,
  buildVersionArgs,
  classifyRecognizerError,
  MAX_RECOGNIZED_TEXT_BYTES,
  TesseractFrameTextRecognizer,
  TOOLING_READY_TIMEOUT_MS,
  TOOLING_READY_TTL_MS,
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

  /**
   * The Codex finding this closes: the pre-Multer upload guard only
   * consulted the CAPABILITY FLAG (readsRealPixels). That is a static claim
   * about the STRATEGY — with VIDEO_OCR_ENABLED=true and no OCR binary on
   * the host it is still true — so the guard passed and multer buffered the
   * entire upload before anything failed. checkToolingReady is the runtime
   * half: it actually runs the binary.
   */
  describe('checkToolingReady', () => {
    interface Invocation {
      binary: string;
      args: string[];
      stdinData: Buffer;
      maxOutputBytes: number;
      timeoutMs?: number;
    }

    const recordingRunner = (
      calls: Invocation[],
      outcome: () => Promise<{ stdout: Buffer }> = () =>
        Promise.resolve({ stdout: Buffer.from('tesseract 5.3.0') }),
    ) =>
      jest.fn(
        (
          binary: string,
          args: string[],
          stdinData: Buffer,
          maxOutputBytes: number,
          timeoutMs?: number,
        ) => {
          calls.push({ binary, args, stdinData, maxOutputBytes, timeoutMs });
          return outcome();
        },
      );

    const enoent = () =>
      Promise.reject(
        Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }),
      );

    it('reports ready when the version invocation succeeds', async () => {
      const calls: Invocation[] = [];
      const recognizer = new TesseractFrameTextRecognizer(
        recordingRunner(calls),
      );
      const ready = await recognizer.checkToolingReady();
      expect(ready).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0].binary).toBe('tesseract');
      // A fixed, input-free vector: no frame, no path, no user value.
      expect(calls[0].args).toEqual(buildVersionArgs());
      expect(calls[0].args).toEqual(['--version']);
      // No frame is fed to a readiness check.
      expect(calls[0].stdinData.length).toBe(0);
      // Far tighter than the recognition ceiling — this must stay CHEAP.
      expect(calls[0].timeoutMs).toBe(TOOLING_READY_TIMEOUT_MS);
    });

    it.each([
      ['ENOENT (missing binary)', { code: 'ENOENT' }],
      ['EACCES (non-executable)', { code: 'EACCES' }],
      ['a nonzero exit', { code: 1, killed: false, signal: null }],
      ['a timeout kill', { killed: true, signal: 'SIGTERM' }],
      ['an output overrun', { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }],
    ])('reports NOT ready on %s, without throwing', async (_label, failure) => {
      const recognizer = new TesseractFrameTextRecognizer(
        jest.fn(() =>
          Promise.reject(
            Object.assign(
              new Error('spawn /usr/bin/tesseract failed at /secret/path'),
              failure,
            ),
          ),
        ),
      );
      const ready = await recognizer.checkToolingReady();
      // A BARE boolean: no error escapes, and nothing that could carry a
      // path, argv, errno string, or stderr comes back through this seam.
      expect(typeof ready).toBe('boolean');
      expect(ready).toBe(false);
    });

    it('MEMOIZES a positive result: later calls within the TTL never re-invoke the runner', async () => {
      const calls: Invocation[] = [];
      const runner = recordingRunner(calls);
      const recognizer = new TesseractFrameTextRecognizer(runner);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await expect(recognizer.checkToolingReady()).resolves.toBe(true);
      }
      // A per-request spawn would defeat a CHEAP pre-buffer gate.
      expect(runner).toHaveBeenCalledTimes(1);
    });

    it('MEMOIZES a NEGATIVE result too — a missing binary cannot cause a spawn storm', async () => {
      const runner = jest.fn(enoent);
      const recognizer = new TesseractFrameTextRecognizer(runner);
      for (let request = 0; request < 25; request += 1) {
        await expect(recognizer.checkToolingReady()).resolves.toBe(false);
      }
      // ONE failed exec for 25 refused uploads, not 25.
      expect(runner).toHaveBeenCalledTimes(1);
    });

    it('re-checks once the TTL has elapsed', async () => {
      let missing = true;
      const runner = jest.fn(() =>
        missing
          ? enoent()
          : Promise.resolve({ stdout: Buffer.from('tesseract 5.3.0') }),
      );
      const recognizer = new TesseractFrameTextRecognizer(runner);
      const now = jest.spyOn(Date, 'now');
      try {
        now.mockReturnValue(2_000_000);
        await expect(recognizer.checkToolingReady()).resolves.toBe(false);
        now.mockReturnValue(2_000_000 + TOOLING_READY_TTL_MS - 1);
        await expect(recognizer.checkToolingReady()).resolves.toBe(false);
        expect(runner).toHaveBeenCalledTimes(1);
        missing = false;
        now.mockReturnValue(2_000_000 + TOOLING_READY_TTL_MS);
        await expect(recognizer.checkToolingReady()).resolves.toBe(true);
        expect(runner).toHaveBeenCalledTimes(2);
      } finally {
        now.mockRestore();
      }
    });

    it('collapses CONCURRENT checks on a cold cache onto one invocation', async () => {
      const calls: Invocation[] = [];
      const runner = recordingRunner(calls);
      const recognizer = new TesseractFrameTextRecognizer(runner);
      await expect(
        Promise.all([
          recognizer.checkToolingReady(),
          recognizer.checkToolingReady(),
          recognizer.checkToolingReady(),
        ]),
      ).resolves.toEqual([true, true, true]);
      expect(runner).toHaveBeenCalledTimes(1);
    });

    it('never rejects, even when the runner throws SYNCHRONOUSLY or rejects with a non-Error', async () => {
      const hostile: (() => Promise<{ stdout: Buffer }>)[] = [
        () => {
          throw Object.assign(new Error('/secret/tesseract exploded'), {
            code: 'EACCES',
          });
        },
        () =>
          Promise.reject('a bare string naming /secret/path') as Promise<{
            stdout: Buffer;
          }>,
        () => Promise.reject(undefined) as Promise<{ stdout: Buffer }>,
      ];
      for (const runner of hostile) {
        const recognizer = new TesseractFrameTextRecognizer(runner);
        const ready = await recognizer.checkToolingReady();
        expect(typeof ready).toBe('boolean');
        expect(ready).toBe(false);
      }
    });

    it('leaves recognize() on the adapter own ceiling (readiness tightens only itself)', async () => {
      const calls: Invocation[] = [];
      const recognizer = new TesseractFrameTextRecognizer(
        recordingRunner(calls),
      );
      await recognizer.recognize(Buffer.from('png-bytes'));
      // No per-invocation timeout is passed for real work — the default
      // runner's fixed COMMAND_TIMEOUT_MS still applies, unchanged.
      expect(calls[0].timeoutMs).toBeUndefined();
      expect(calls[0].maxOutputBytes).toBe(MAX_RECOGNIZED_TEXT_BYTES);
    });
  });
});
