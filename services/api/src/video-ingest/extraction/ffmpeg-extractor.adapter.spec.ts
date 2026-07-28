import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalVideoStorageAdapter } from '../storage/local-video-storage.adapter';
import {
  buildCropArgs,
  buildFrameArgs,
  buildProbeArgs,
  classifyCommandError,
  FfmpegVideoFrameExtractor,
  MAX_OUTPUT_BYTES,
  MAX_PROBE_DIMENSION,
  MAX_PROBE_DURATION_MS,
  MAX_TOTAL_EXTRACTION_BYTES,
  parseProbeOutput,
  SCRATCH_DIR_PREFIX,
} from './ffmpeg-extractor.adapter';

// The scratch-file logic never touches the real filesystem in tests: the
// fs layer is mocked wholesale (the storage adapter import shares the
// module but no test here performs storage I/O).
jest.mock('node:fs/promises', () => ({
  chmod: jest.fn(async () => undefined),
  mkdir: jest.fn(async () => undefined),
  mkdtemp: jest.fn(async (prefix: string) => `${prefix}abc123`),
  readFile: jest.fn(async () => Buffer.alloc(0)),
  rename: jest.fn(async () => undefined),
  rm: jest.fn(async () => undefined),
  stat: jest.fn(async () => ({})),
  unlink: jest.fn(async () => undefined),
  writeFile: jest.fn(async () => undefined),
}));
import {
  ExtractionFailedError,
  ExtractionInfrastructureError,
  ExtractorUnavailableError,
  FrameExceedsBudgetError,
  FrameUnavailableError,
} from './video-frame-extractor.port';

/**
 * The optional system-binary adapter NEVER spawns a process in tests: the
 * command runner is injected. These specs pin the two safety invariants —
 * argument vectors built ONLY from validated integers and the confined
 * internal path, and controlled errors that never echo stderr or paths.
 */
// The CONCRETE local adapter type (path capability lives there, not on the
// provider-neutral VideoStoragePort).
const storageStub = {
  internalPathFor: (key: string) => `/confined/root/${key}`,
} as unknown as LocalVideoStorageAdapter;

describe('argument builders', () => {
  it('builds probe args as a fixed vector ending in the internal path', () => {
    expect(buildProbeArgs('/confined/root/a/original.mp4')).toEqual([
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      '-select_streams',
      'v:0',
      '/confined/root/a/original.mp4',
    ]);
  });

  it('renders timestamps as fixed-point seconds and crop boxes as integers', () => {
    const frame = buildFrameArgs('/p/v.mp4', 2500);
    expect(frame).toContain('2.500');
    const crop = buildCropArgs('/p/v.mp4', 1000, {
      x: 10,
      y: 20,
      width: 300,
      height: 200,
    });
    expect(crop).toContain('crop=300:200:10:20');
  });

  it.each([
    [Number.NaN],
    [1.5],
    [-1],
    [Number.POSITIVE_INFINITY],
    [2_147_483_648],
  ])('rejects non-integer/out-of-range numeric input %p', (bad) => {
    expect(() => buildFrameArgs('/p/v.mp4', bad)).toThrow(
      ExtractionFailedError,
    );
    expect(() =>
      buildCropArgs('/p/v.mp4', 0, { x: bad, y: 0, width: 1, height: 1 }),
    ).toThrow(ExtractionFailedError);
  });

  it('never produces a shell-interpretable compound argument', () => {
    // Args are execFile vectors (no shell), but keep them clean anyway.
    const args = buildCropArgs('/p/v.mp4', 1000, {
      x: 1,
      y: 2,
      width: 3,
      height: 4,
    });
    for (const arg of args.slice(0, -1)) {
      expect(arg).not.toMatch(/[;&|><`$]/);
    }
  });
});

describe('parseProbeOutput', () => {
  it('parses stream metadata into probe results', () => {
    const probe = parseProbeOutput(
      JSON.stringify({
        streams: [
          { width: 1920, height: 1080, r_frame_rate: '30000/1001', duration: '12.5' },
        ],
      }),
    );
    expect(probe.durationMs).toBe(12_500);
    expect(probe.width).toBe(1920);
    expect(probe.height).toBe(1080);
    expect(probe.fps).toBeCloseTo(29.97, 2);
  });

  it('falls back to format duration and rejects unusable metadata', () => {
    const probe = parseProbeOutput(
      JSON.stringify({
        streams: [{ width: 640, height: 480, r_frame_rate: '25/1' }],
        format: { duration: '3.0' },
      }),
    );
    expect(probe.durationMs).toBe(3000);
    for (const bad of [
      '{not json',
      JSON.stringify({}),
      JSON.stringify({ streams: [{ width: 0, height: 480, r_frame_rate: '25/1', duration: '3' }] }),
      JSON.stringify({ streams: [{ width: 640, height: 480, r_frame_rate: '0/0', duration: '3' }] }),
    ]) {
      expect(() => parseProbeOutput(bad)).toThrow(ExtractionFailedError);
    }
  });

  it('bounds attacker-supplied probe metadata (duration, geometry, pixels, fps)', () => {
    const probe = (overrides: Record<string, unknown>) =>
      JSON.stringify({
        streams: [
          {
            width: 1920,
            height: 1080,
            r_frame_rate: '30/1',
            duration: '12.5',
            ...overrides,
          },
        ],
      });
    // A tiny crafted container can CLAIM any metadata: oversized duration
    // would overflow the PG Int column, oversized geometry would balloon
    // later full-frame decodes. All controlled rejections.
    for (const bad of [
      probe({ duration: String(MAX_PROBE_DURATION_MS / 1000 + 1) }),
      probe({ width: MAX_PROBE_DIMENSION + 1 }),
      probe({ height: MAX_PROBE_DIMENSION + 1 }),
      probe({ width: 16_000, height: 16_000 }), // per-axis ok, pixels not
      probe({ r_frame_rate: '100000/1' }),
      probe({ duration: '2147483648' }),
    ]) {
      expect(() => parseProbeOutput(bad)).toThrow(ExtractionFailedError);
    }
    // Boundary values stay accepted.
    expect(
      parseProbeOutput(probe({ duration: '3600', width: 7680, height: 4320 })),
    ).toMatchObject({ durationMs: 3_600_000, width: 7680 });
    // Sub-millisecond durations ROUND to 0 and must reject (the DB CHECK
    // requires durationMs > 0 — an accepted 0 would 500 at persistence).
    expect(() => parseProbeOutput(probe({ duration: '0.0001' }))).toThrow(
      ExtractionFailedError,
    );
  });

  it('prefers avg_frame_rate so VFR sources are not bounced off the fps cap', () => {
    // Screen recordings / MediaRecorder output report the container TICK
    // rate in r_frame_rate (can read 1000+); avg_frame_rate carries the
    // honest rate. A legitimate VFR clip must probe fine.
    const vfr = parseProbeOutput(
      JSON.stringify({
        streams: [
          {
            width: 1280,
            height: 720,
            r_frame_rate: '90000/1',
            avg_frame_rate: '2997/100',
            duration: '10.0',
          },
        ],
      }),
    );
    expect(vfr.fps).toBeCloseTo(29.97, 2);
    // Degenerate avg ("0/0") falls back to r_frame_rate.
    const cfr = parseProbeOutput(
      JSON.stringify({
        streams: [
          {
            width: 1280,
            height: 720,
            r_frame_rate: '30/1',
            avg_frame_rate: '0/0',
            duration: '10.0',
          },
        ],
      }),
    );
    expect(cfr.fps).toBe(30);
  });

  it('reports DISPLAY geometry for rotated (portrait phone) videos', () => {
    // Phones store landscape coded dimensions + a ±90° rotation side-data;
    // ffmpeg autorotates extraction output, so the probe must report the
    // rotated axes or crop bounds validate against the wrong dimensions.
    const portrait = parseProbeOutput(
      JSON.stringify({
        streams: [
          {
            width: 1920,
            height: 1080,
            r_frame_rate: '30/1',
            duration: '10.0',
            side_data_list: [{ rotation: -90 }],
          },
        ],
      }),
    );
    expect(portrait.width).toBe(1080);
    expect(portrait.height).toBe(1920);
    // 180° keeps the axes.
    const upsideDown = parseProbeOutput(
      JSON.stringify({
        streams: [
          {
            width: 1920,
            height: 1080,
            r_frame_rate: '30/1',
            duration: '10.0',
            side_data_list: [{ rotation: 180 }],
          },
        ],
      }),
    );
    expect(upsideDown.width).toBe(1920);
  });
});

describe('FfmpegVideoFrameExtractor (mocked command runner)', () => {
  it('maps a missing binary to a controlled unavailable error', async () => {
    const extractor = new FfmpegVideoFrameExtractor(storageStub, () => {
      const error = new Error('spawn ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      return Promise.reject(error);
    });
    await expect(extractor.probe('a/original.mp4')).rejects.toBeInstanceOf(
      ExtractorUnavailableError,
    );
  });

  it('maps a failing command to a controlled failure that never echoes stderr', async () => {
    const extractor = new FfmpegVideoFrameExtractor(storageStub, () =>
      Promise.reject(new Error('ffmpeg exploded: /secret/path/original.mp4')),
    );
    await expect(
      extractor.extractFrameAt(
        'a/original.mp4',
        { durationMs: 10_000, width: 100, height: 100, fps: 30 },
        0,
      ),
    ).rejects.toMatchObject({
      name: 'ExtractionFailedError',
      message: expect.not.stringContaining('/secret/path') as unknown,
    });
  });

  it('keeps ffprobe INFRASTRUCTURE failures retryable — never a content rejection', async () => {
    // A timeout kill, an OS resource/permission refusal, or a maxBuffer
    // overrun says nothing about the video; mapping any of these to
    // ExtractionFailedError would let the validation flow permanently
    // REJECT an otherwise-valid UPLOADED asset.
    const probe = (rejection: unknown) =>
      new FfmpegVideoFrameExtractor(storageStub, () =>
        Promise.reject(rejection),
      ).probe('a/original.mp4');

    // Killed by the 30s timeout: killed=true + signal, code null.
    const timeoutKill = new Error('spawn killed') as NodeJS.ErrnoException & {
      killed: boolean;
      signal: string;
    };
    timeoutKill.killed = true;
    timeoutKill.signal = 'SIGTERM';
    await expect(probe(timeoutKill)).rejects.toBeInstanceOf(
      ExtractionInfrastructureError,
    );

    // External kill (e.g. OOM killer): signal set without killed.
    const externalKill = Object.assign(new Error('killed'), {
      killed: false,
      signal: 'SIGKILL',
    });
    await expect(probe(externalKill)).rejects.toBeInstanceOf(
      ExtractionInfrastructureError,
    );

    // Transient OS spawn errors carry STRING errno codes.
    for (const errno of ['EACCES', 'EAGAIN', 'ENOMEM', 'EMFILE']) {
      const spawnError = new Error(`spawn ${errno}`) as NodeJS.ErrnoException;
      spawnError.code = errno;
      await expect(probe(spawnError)).rejects.toBeInstanceOf(
        ExtractionInfrastructureError,
      );
    }

    // maxBuffer overrun: modern Node sets a string code; older shapes only
    // carry the message.
    const maxBufferCoded = Object.assign(
      new RangeError('stdout maxBuffer length exceeded'),
      { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' },
    );
    await expect(probe(maxBufferCoded)).rejects.toBeInstanceOf(
      ExtractionInfrastructureError,
    );
    await expect(
      probe(new Error('stdout maxBuffer length exceeded')),
    ).rejects.toBeInstanceOf(ExtractionInfrastructureError);
  });

  it('keeps a nonzero ffprobe exit (tool ran, judged the file) a content failure', async () => {
    // Numeric exit code = the tool executed and reported the container
    // unreadable — the ONLY case that stays ExtractionFailedError.
    const exitFailure = Object.assign(
      new Error('ffprobe exited 1: moov atom not found'),
      { code: 1, killed: false, signal: null },
    );
    const extractor = new FfmpegVideoFrameExtractor(storageStub, () =>
      Promise.reject(exitFailure),
    );
    await expect(extractor.probe('a/original.mp4')).rejects.toBeInstanceOf(
      ExtractionFailedError,
    );
  });

  it('classifies ffmpeg frame-extraction infrastructure failures the same way', async () => {
    // The frame/crop exec path shares run(): a timeout kill there is just
    // as environmental as on the probe path.
    const timeoutKill = Object.assign(new Error('killed'), {
      killed: true,
      signal: 'SIGTERM',
    });
    const extractor = new FfmpegVideoFrameExtractor(storageStub, () =>
      Promise.reject(timeoutKill),
    );
    const probe = { durationMs: 10_000, width: 100, height: 100, fps: 30 };
    await expect(
      extractor.extractFrameAt('a/original.mp4', probe, 0),
    ).rejects.toBeInstanceOf(ExtractionInfrastructureError);
    await expect(
      extractor.extractCrop('a/original.mp4', probe, 0, {
        x: 0,
        y: 0,
        width: 10,
        height: 10,
      }),
    ).rejects.toBeInstanceOf(ExtractionInfrastructureError);
    await expect(
      extractor.extractFrames('a/original.mp4', probe, {
        intervalMs: 1000,
        maxFrames: 5,
        startMs: 0,
      }),
    ).rejects.toBeInstanceOf(ExtractionInfrastructureError);
  });

  it('never echoes signals, errno values, or paths from classified errors', () => {
    const noisy = Object.assign(
      new Error('spawn EACCES /secret/path/ffprobe'),
      { code: 'EACCES' },
    );
    const classified = classifyCommandError(noisy);
    expect(classified).toBeInstanceOf(ExtractionInfrastructureError);
    expect(classified.message).not.toContain('EACCES');
    expect(classified.message).not.toContain('/secret/path');
    // Degenerate shapes (nullish rejection) stay a controlled content error.
    expect(classifyCommandError(undefined)).toBeInstanceOf(
      ExtractionFailedError,
    );
  });

  it('returns stdout bytes with honest geometry for frames and crops', async () => {
    const calls: { binary: string; args: string[] }[] = [];
    const extractor = new FfmpegVideoFrameExtractor(
      storageStub,
      (binary, args) => {
        calls.push({ binary, args });
        return Promise.resolve({ stdout: Buffer.from('png-bytes') });
      },
    );
    const probe = { durationMs: 10_000, width: 1920, height: 1080, fps: 30 };
    const frame = await extractor.extractFrameAt('a/original.mp4', probe, 1000);
    expect(frame.width).toBe(1920);
    const crop = await extractor.extractCrop('a/original.mp4', probe, 1000, {
      x: 5,
      y: 6,
      width: 70,
      height: 80,
    });
    expect(crop.width).toBe(70);
    expect(crop.height).toBe(80);
    // Every invocation received the CONFINED internal path, never the key.
    for (const call of calls) {
      expect(call.args[call.args.indexOf('-i') + 1]).toBe(
        '/confined/root/a/original.mp4',
      );
    }
  });

  it('samples strictly BEFORE the duration (exclusive endpoint)', async () => {
    const extractor = new FfmpegVideoFrameExtractor(storageStub, () =>
      Promise.resolve({ stdout: Buffer.from('png') }),
    );
    const frames = await extractor.extractFrames(
      'a/original.mp4',
      { durationMs: 10_000, width: 100, height: 100, fps: 30 },
      { intervalMs: 5000, maxFrames: 30, startMs: 0 },
    );
    // 0, 5000 — 10000 is the exclusive endpoint (no frame exists there).
    expect(frames.map((f) => f.timestampMs)).toEqual([0, 5000]);
  });

  it('enforces a request-wide decoded-byte budget across frames', async () => {
    // Each mocked frame is ~half the budget; the third invocation would
    // exceed it. The per-invocation maxBuffer cannot catch this — only the
    // aggregate budget does.
    const bigFrame = Buffer.alloc(Math.ceil(MAX_TOTAL_EXTRACTION_BYTES / 2) + 1);
    const extractor = new FfmpegVideoFrameExtractor(storageStub, () =>
      Promise.resolve({ stdout: bigFrame }),
    );
    await expect(
      extractor.extractFrames(
        'a/original.mp4',
        { durationMs: 10_000, width: 100, height: 100, fps: 30 },
        { intervalMs: 1000, maxFrames: 10, startMs: 0 },
      ),
    ).rejects.toBeInstanceOf(ExtractionFailedError);
  });

  it('maps empty output at an explicit timestamp to FrameUnavailable (not batch failure)', async () => {
    const extractor = new FfmpegVideoFrameExtractor(storageStub, () =>
      Promise.resolve({ stdout: Buffer.alloc(0) }),
    );
    await expect(
      extractor.extractFrameAt(
        'a/original.mp4',
        { durationMs: 10_000, width: 100, height: 100, fps: 30 },
        0,
      ),
    ).rejects.toBeInstanceOf(FrameUnavailableError);
  });

  it('treats end-of-stream mid-sampling as a normal stop, not a batch failure', async () => {
    // Containers routinely report a duration slightly past the last
    // decodable frame; sampling must return what it got.
    let call = 0;
    const extractor = new FfmpegVideoFrameExtractor(storageStub, () => {
      call += 1;
      return Promise.resolve({
        stdout: call <= 2 ? Buffer.from('png') : Buffer.alloc(0),
      });
    });
    const frames = await extractor.extractFrames(
      'a/original.mp4',
      { durationMs: 10_000, width: 100, height: 100, fps: 30 },
      { intervalMs: 3000, maxFrames: 10, startMs: 0 },
    );
    expect(frames.map((f) => f.timestampMs)).toEqual([0, 3000]);
  });

  describe('inspectBuffer (pre-storage screening scratch file)', () => {
    const probeJson = JSON.stringify({
      streams: [
        { width: 1280, height: 720, r_frame_rate: '30/1', duration: '10.0' },
      ],
    });
    const scratchDir = join(tmpdir(), `${SCRATCH_DIR_PREFIX}abc123`);
    const scratchPath = join(scratchDir, 'inspect.media');

    beforeEach(() => {
      (mkdtemp as jest.Mock)
        .mockReset()
        .mockImplementation(async (prefix: string) => `${prefix}abc123`);
      (writeFile as jest.Mock).mockReset().mockResolvedValue(undefined);
      (rm as jest.Mock).mockReset().mockResolvedValue(undefined);
      (chmod as jest.Mock).mockReset().mockResolvedValue(undefined);
    });

    it('writes the buffer to an OS-tempdir scratch file (0600, wx), probes THERE, and close() removes the tree', async () => {
      const calls: { binary: string; args: string[] }[] = [];
      const extractor = new FfmpegVideoFrameExtractor(
        storageStub,
        (binary, args) => {
          calls.push({ binary, args });
          return Promise.resolve({
            stdout:
              binary === 'ffprobe'
                ? Buffer.from(probeJson)
                : Buffer.from('png'),
          });
        },
      );
      const data = Buffer.from('unscreened-bytes');
      const session = await extractor.inspectBuffer(data);
      // Scratch lives in the OS temp dir — NEVER under the storage root.
      expect(mkdtemp).toHaveBeenCalledWith(join(tmpdir(), SCRATCH_DIR_PREFIX));
      expect(writeFile).toHaveBeenCalledWith(scratchPath, data, {
        mode: 0o600,
        flag: 'wx',
      });
      expect(chmod).toHaveBeenCalledWith(scratchDir, 0o700);
      expect(session.probe.durationMs).toBe(10_000);
      // The probe ran against the scratch path, not any storage key.
      expect(calls[0].args[calls[0].args.length - 1]).toBe(scratchPath);
      // Frame extraction reads the SAME scratch path.
      const frame = await session.extractFrameAt(1000);
      expect(frame.timestampMs).toBe(1000);
      expect(calls[1].args[calls[1].args.indexOf('-i') + 1]).toBe(scratchPath);
      // close() removes the whole scratch tree — idempotently.
      await session.close();
      expect(rm).toHaveBeenCalledWith(scratchDir, {
        recursive: true,
        force: true,
      });
      await session.close();
      expect(rm).toHaveBeenCalledTimes(1);
    });

    it('removes the scratch tree when the probe itself fails (no session to close)', async () => {
      const exitFailure = Object.assign(new Error('exit 1'), { code: 1 });
      const extractor = new FfmpegVideoFrameExtractor(storageStub, () =>
        Promise.reject(exitFailure),
      );
      await expect(
        extractor.inspectBuffer(Buffer.from('x')),
      ).rejects.toBeInstanceOf(ExtractionFailedError);
      expect(rm).toHaveBeenCalledTimes(1);
      expect(rm).toHaveBeenCalledWith(scratchDir, {
        recursive: true,
        force: true,
      });
    });

    it('maps a scratch-write failure to a controlled infrastructure error and never echoes the path', async () => {
      (writeFile as jest.Mock).mockRejectedValueOnce(
        Object.assign(new Error("ENOSPC: no space, write '/tmp/secret'"), {
          code: 'ENOSPC',
        }),
      );
      const runner = jest.fn(() =>
        Promise.resolve({ stdout: Buffer.from(probeJson) }),
      );
      const extractor = new FfmpegVideoFrameExtractor(storageStub, runner);
      const error: Error = await extractor
        .inspectBuffer(Buffer.from('x'))
        .then(() => {
          throw new Error('expected rejection');
        })
        .catch((caught: Error) => caught);
      expect(error).toBeInstanceOf(ExtractionInfrastructureError);
      expect(error.message).not.toContain('/tmp');
      expect(error.message).not.toContain('ENOSPC');
      // No probe ran, and the partial scratch tree was still removed.
      expect(runner).not.toHaveBeenCalled();
      expect(rm).toHaveBeenCalledTimes(1);
    });

    it('retries a failed scratch removal once, then surfaces the infrastructure classification', async () => {
      (rm as jest.Mock).mockRejectedValue(new Error('EBUSY'));
      const extractor = new FfmpegVideoFrameExtractor(storageStub, () =>
        Promise.resolve({ stdout: Buffer.from(probeJson) }),
      );
      const session = await extractor.inspectBuffer(Buffer.from('x'));
      await expect(session.close()).rejects.toBeInstanceOf(
        ExtractionInfrastructureError,
      );
      expect(rm).toHaveBeenCalledTimes(2);
    });
  });

  it('declares itself byte-reading (screening previews may serve from it)', () => {
    const extractor = new FfmpegVideoFrameExtractor(storageStub, () =>
      Promise.resolve({ stdout: Buffer.from('png') }),
    );
    expect(extractor.readsRealBytes).toBe(true);
  });

  it('enforces a caller-supplied maxBytes as the exec maxBuffer, clamped by the ceiling', async () => {
    const budgets: number[] = [];
    const extractor = new FfmpegVideoFrameExtractor(
      storageStub,
      (_binary, _args, maxOutputBytes) => {
        budgets.push(maxOutputBytes);
        return Promise.resolve({ stdout: Buffer.from('png') });
      },
    );
    const probe = { durationMs: 10_000, width: 100, height: 100, fps: 30 };
    // A tightened caller budget IS the invocation's maxBuffer.
    await extractor.extractFrameAt('a/original.mp4', probe, 0, {
      maxBytes: 1000,
    });
    // A caller budget can never RAISE the adapter's own ceiling.
    await extractor.extractFrameAt('a/original.mp4', probe, 0, {
      maxBytes: MAX_OUTPUT_BYTES * 4,
    });
    // No caller budget → the ceiling, unchanged.
    await extractor.extractFrameAt('a/original.mp4', probe, 0);
    expect(budgets).toEqual([1000, MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES]);
  });

  it('maps a BUDGET-tripped maxBuffer overflow to FrameExceedsBudgetError, not infrastructure', async () => {
    const overflow = () =>
      Promise.reject(
        Object.assign(new RangeError('stdout maxBuffer length exceeded'), {
          code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
        }),
      );
    const extractor = new FfmpegVideoFrameExtractor(storageStub, overflow);
    const probe = { durationMs: 10_000, width: 100, height: 100, fps: 30 };
    // The caller-supplied cap (below the ceiling) is what fired → a budget
    // verdict the caller can treat as a skip.
    await expect(
      extractor.extractFrameAt('a/original.mp4', probe, 0, { maxBytes: 1000 }),
    ).rejects.toBeInstanceOf(FrameExceedsBudgetError);
    // The adapter's OWN ceiling firing stays the existing infrastructure
    // classification (a parent-side cap, not a caller budget).
    await expect(
      extractor.extractFrameAt('a/original.mp4', probe, 0),
    ).rejects.toBeInstanceOf(ExtractionInfrastructureError);
    await expect(
      extractor.extractFrameAt('a/original.mp4', probe, 0, {
        maxBytes: MAX_OUTPUT_BYTES,
      }),
    ).rejects.toBeInstanceOf(ExtractionInfrastructureError);
  });

  it('rejects a degenerate caller budget WITHOUT spawning anything', async () => {
    const runner = jest.fn(() =>
      Promise.resolve({ stdout: Buffer.from('png') }),
    );
    const extractor = new FfmpegVideoFrameExtractor(storageStub, runner);
    const probe = { durationMs: 10_000, width: 100, height: 100, fps: 30 };
    for (const maxBytes of [0, -1, 1.5, Number.NaN]) {
      await expect(
        extractor.extractFrameAt('a/original.mp4', probe, 0, { maxBytes }),
      ).rejects.toBeInstanceOf(FrameExceedsBudgetError);
    }
    expect(runner).not.toHaveBeenCalled();
  });

  it('keeps a batch whose SHRINKING budget trips the exec cap a content failure', async () => {
    // Once the aggregate pool drops below the per-frame ceiling the
    // remainder becomes the exec cap; a real overflow there surfaces as
    // FrameExceedsBudgetError inside the loop and must convert to the
    // batch's ExtractionFailedError — never an infrastructure 503.
    let call = 0;
    const extractor = new FfmpegVideoFrameExtractor(storageStub, () => {
      call += 1;
      if (call <= 2) {
        return Promise.resolve({
          stdout: Buffer.alloc(48 * 1024 * 1024),
        });
      }
      return Promise.reject(
        Object.assign(new RangeError('stdout maxBuffer length exceeded'), {
          code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
        }),
      );
    });
    await expect(
      extractor.extractFrames(
        'a/original.mp4',
        { durationMs: 20_000, width: 100, height: 100, fps: 30 },
        { intervalMs: 1000, maxFrames: 10, startMs: 0 },
      ),
    ).rejects.toBeInstanceOf(ExtractionFailedError);
  });

  it('forwards the SHRINKING remaining budget once the pool drops below the per-frame cap', async () => {
    // Reverting the budget-before-decode fix (passing a constant maxBuffer)
    // must fail this test: with 48 MiB frames against the 128 MiB pool, the
    // third invocation's allowance must be the 32 MiB remainder — not the
    // full per-frame cap.
    const frameBytes = 48 * 1024 * 1024;
    const budgets: number[] = [];
    const frame = Buffer.alloc(frameBytes);
    const extractor = new FfmpegVideoFrameExtractor(
      storageStub,
      (_binary, _args, maxOutputBytes) => {
        budgets.push(maxOutputBytes);
        return Promise.resolve({ stdout: frame });
      },
    );
    // Third frame (48 MiB) exceeds its 32 MiB allowance via the runner
    // backstop — the batch fails rather than blowing the pool.
    await expect(
      extractor.extractFrames(
        'a/original.mp4',
        { durationMs: 20_000, width: 100, height: 100, fps: 30 },
        { intervalMs: 1000, maxFrames: 10, startMs: 0 },
      ),
    ).rejects.toBeInstanceOf(ExtractionFailedError);
    expect(budgets.length).toBe(3);
    expect(budgets[2]).toBe(MAX_TOTAL_EXTRACTION_BYTES - 2 * frameBytes);
    expect(budgets[2]).toBeLessThan(budgets[0]);
  });
});
