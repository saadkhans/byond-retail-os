import {
  buildRecognizeArgs,
  buildToolingReadyArgs,
  classifyRecognizerError,
  MAX_RECOGNIZED_TEXT_BYTES,
  TesseractFrameTextRecognizer,
  toolingReadyProbeImage,
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
   *
   * THE SECOND, SHARPER FINDING: running the binary is not enough if the
   * invocation is `--version`. A version banner prints fine on a host whose
   * default OCR LANGUAGE DATA is missing or unreadable — the most likely
   * real-world misconfiguration — so the gate admitted the upload, multer
   * buffered the file, and the first genuine recognize() call was what
   * finally failed. The probe therefore drives the SAME argv over the SAME
   * stdin/stdout wiring a real recognition uses, feeding a synthetic
   * in-memory image, so it fails wherever a real recognition would.
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
      // What a correctly configured tool returns for the blank probe image:
      // exit zero, essentially no text. The text is never inspected.
      outcome: () => Promise<{ stdout: Buffer }> = () =>
        Promise.resolve({ stdout: Buffer.from('\n\f', 'utf8') }),
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

    /**
     * An INDEPENDENT CRC32 (the checksum the image chunk format specifies),
     * written here rather than imported, so the spec validates the generated
     * bytes instead of agreeing with the adapter's own arithmetic.
     */
    const crc32 = (bytes: Buffer): number => {
      let crc = 0xffffffff;
      for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit += 1) {
          crc = (crc & 1) !== 0 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
        }
        crc >>>= 0;
      }
      return (crc ^ 0xffffffff) >>> 0;
    };

    /** The 8 bytes every file of this format opens with. */
    const IMAGE_SIGNATURE = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);

    interface ImageChunk {
      type: string;
      payload: Buffer;
      crcValid: boolean;
    }

    /** Walk the chunk stream, verifying each declared length and checksum. */
    const parseImageChunks = (image: Buffer): ImageChunk[] => {
      const chunks: ImageChunk[] = [];
      let offset = IMAGE_SIGNATURE.length;
      while (offset < image.length) {
        const length = image.readUInt32BE(offset);
        const type = image.subarray(offset + 4, offset + 8).toString('ascii');
        const payload = image.subarray(offset + 8, offset + 8 + length);
        const stored = image.readUInt32BE(offset + 8 + length);
        chunks.push({
          type,
          payload,
          crcValid:
            stored ===
            crc32(Buffer.concat([Buffer.from(type, 'ascii'), payload])),
        });
        offset += 12 + length;
      }
      // A truncated trailing chunk would leave offset past the end.
      expect(offset).toBe(image.length);
      return chunks;
    };

    /**
     * The probe input is SYNTHETIC and GENERATED — no fixture file, no
     * sample media, no new dependency. This pins that it really is a
     * plausible minimal image of the declared format, not arbitrary bytes a
     * tool would reject before ever touching its language data.
     */
    it('feeds a generated, plausible minimal image — never a fixture or sample media', () => {
      const image = toolingReadyProbeImage();
      expect(image.subarray(0, 8)).toEqual(IMAGE_SIGNATURE);
      // Spelled out, so a silent format swap fails right here.
      expect([...image.subarray(0, 8)]).toEqual([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]);
      const chunks = parseImageChunks(image);
      expect(chunks.map((chunk) => chunk.type)).toEqual([
        'IHDR',
        'IDAT',
        'IEND',
      ]);
      expect(chunks.every((chunk) => chunk.crcValid)).toBe(true);
      const header = chunks[0].payload;
      expect(header).toHaveLength(13);
      const width = header.readUInt32BE(0);
      const height = header.readUInt32BE(4);
      expect(width).toBeGreaterThan(0);
      expect(height).toBeGreaterThan(0);
      // Tiny on purpose: the probe must stay CHEAP.
      expect(width).toBeLessThanOrEqual(64);
      expect(height).toBeLessThanOrEqual(64);
      expect(header.readUInt8(8)).toBe(8); // 8 bits per sample
      expect(header.readUInt8(9)).toBe(0); // greyscale
      expect(header.readUInt8(10)).toBe(0); // deflate
      expect(header.readUInt8(11)).toBe(0); // adaptive filtering
      expect(header.readUInt8(12)).toBe(0); // not interlaced
      expect(chunks[1].payload.length).toBeGreaterThan(0);
      expect(chunks[2].payload).toHaveLength(0);
      // A whole image in well under a kilobyte — nothing here is media.
      expect(image.length).toBeLessThan(512);
    });

    it('builds the probe image AT MOST ONCE per process', () => {
      // Same Buffer identity across calls: a module-level lazy constant.
      expect(toolingReadyProbeImage()).toBe(toolingReadyProbeImage());
    });

    it('probes with the SAME vector recognize() uses, over the generated image', async () => {
      const calls: Invocation[] = [];
      const recognizer = new TesseractFrameTextRecognizer(
        recordingRunner(calls),
      );
      const ready = await recognizer.checkToolingReady();
      expect(ready).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0].binary).toBe('tesseract');
      // THE POINT OF THE FIX: identical to the recognition vector, so the
      // probe resolves the same DEFAULT language data a real recognition
      // does. No `--version`, no language override, no user-influenced value.
      expect(calls[0].args).toEqual(buildToolingReadyArgs());
      expect(calls[0].args).toEqual(buildRecognizeArgs());
      expect(calls[0].args).toEqual(['stdin', 'stdout']);
      expect(calls[0].args).not.toContain('--version');
      // A real, decodable image travels over STDIN — the same seam a frame
      // uses, so nothing touches a disk path.
      expect(calls[0].stdinData.subarray(0, 8)).toEqual(IMAGE_SIGNATURE);
      expect(calls[0].stdinData).toBe(toolingReadyProbeImage());
      expect(
        parseImageChunks(calls[0].stdinData).map((chunk) => chunk.type),
      ).toEqual(['IHDR', 'IDAT', 'IEND']);
      // Bounded like every other invocation, and killed far short of the
      // recognition ceiling — this must stay CHEAP.
      expect(calls[0].maxOutputBytes).toBeGreaterThan(0);
      expect(calls[0].maxOutputBytes).toBeLessThan(MAX_RECOGNIZED_TEXT_BYTES);
      expect(calls[0].timeoutMs).toBe(TOOLING_READY_TIMEOUT_MS);
    });

    /**
     * THE REGRESSION THIS FIX EXISTS FOR: the binary is installed and
     * executable — `--version` would have exited zero and reported READY —
     * but its default language data is missing or unreadable, so the real
     * invocation exits nonzero. The pre-buffer gate must catch that here,
     * not after multer has buffered the upload.
     */
    it('reports NOT ready when the binary RUNS but its language data fails to initialize', async () => {
      const runner = jest.fn(() =>
        Promise.reject(
          Object.assign(
            new Error(
              'Error opening data file /usr/share/tessdata/eng.traineddata\n' +
                "Failed loading language 'eng'\n" +
                'Could not initialize tesseract.',
            ),
            // The tool RAN and reported failure: a NUMERIC exit code, not a
            // spawn errno. `--version` would have exited 0 on this host.
            { code: 1, killed: false, signal: null },
          ),
        ),
      );
      const recognizer = new TesseractFrameTextRecognizer(runner);
      const ready = await recognizer.checkToolingReady();
      expect(typeof ready).toBe('boolean');
      expect(ready).toBe(false);
      expect(runner).toHaveBeenCalledTimes(1);
    });

    it('reports ready when the binary AND its data initialization both succeed', async () => {
      const recognizer = new TesseractFrameTextRecognizer(
        jest.fn(() => Promise.resolve({ stdout: Buffer.from('\n\f', 'utf8') })),
      );
      await expect(recognizer.checkToolingReady()).resolves.toBe(true);
    });

    /**
     * Readiness is EXIT STATUS, never content. A runner that resolves with
     * text must still yield exactly `true`: no OCR output and no host detail
     * may ride back through this seam.
     */
    it('returns a bare boolean — recognized text never escapes the probe', async () => {
      const recognizer = new TesseractFrameTextRecognizer(
        jest.fn(() =>
          Promise.resolve({
            stdout: Buffer.from(
              'CUSTOMER 4111111111111111 /secret/path tesseract',
              'utf8',
            ),
          }),
        ),
      );
      const ready: unknown = await recognizer.checkToolingReady();
      expect(typeof ready).toBe('boolean');
      expect(ready).toBe(true);
      expect(JSON.stringify(ready)).toBe('true');
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
        missing ? enoent() : Promise.resolve({ stdout: Buffer.from('\n\f') }),
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
