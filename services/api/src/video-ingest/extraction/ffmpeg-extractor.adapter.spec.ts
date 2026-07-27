import { VideoStoragePort } from '../storage/video-storage.port';
import {
  buildCropArgs,
  buildFrameArgs,
  buildProbeArgs,
  FfmpegVideoFrameExtractor,
  parseProbeOutput,
} from './ffmpeg-extractor.adapter';
import {
  ExtractionFailedError,
  ExtractorUnavailableError,
} from './video-frame-extractor.port';

/**
 * The optional system-binary adapter NEVER spawns a process in tests: the
 * command runner is injected. These specs pin the two safety invariants —
 * argument vectors built ONLY from validated integers and the confined
 * internal path, and controlled errors that never echo stderr or paths.
 */
const storageStub = {
  internalPathFor: (key: string) => `/confined/root/${key}`,
} as unknown as VideoStoragePort;

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

  it('rejects empty command output instead of persisting empty artifacts', async () => {
    const extractor = new FfmpegVideoFrameExtractor(storageStub, () =>
      Promise.resolve({ stdout: Buffer.alloc(0) }),
    );
    await expect(
      extractor.extractFrameAt(
        'a/original.mp4',
        { durationMs: 10_000, width: 100, height: 100, fps: 30 },
        0,
      ),
    ).rejects.toBeInstanceOf(ExtractionFailedError);
  });
});
