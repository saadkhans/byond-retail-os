import { LocalStorageMediaDecoder } from './storage-media-decoder';

/**
 * The repository-owned media decode PORT (PICKUP_MEDIA_DECODER): the
 * fusion service hands over managed STORAGE KEYS only, and this adapter
 * alone resolves them to local filesystem paths (internalPathFor — a
 * local-adapter extension, not part of the storage port) before invoking
 * the confined ffmpeg decoder. These specs pin the boundary: every decode
 * resolves through the storage adapter, the raw key never reaches the
 * decoder, and frames/images pass through unmodified — including the
 * decoder's ACTUAL-instant timestamp on a tail-of-clip fallback.
 */
describe('LocalStorageMediaDecoder (storage-key media decode port)', () => {
  const GEOMETRY = { width: 48, height: 84 };

  function build() {
    const storage = {
      internalPathFor: jest.fn((key: string) => `/data/videos/${key}`),
    };
    const frame = { index: 0, timestampMs: 28_950, rgb: Buffer.alloc(3) };
    const frames = [frame];
    const reference = { width: 96, height: 96, rgb: Buffer.alloc(3) };
    const decoder = {
      decodeAnalysisFrames: jest.fn(
        async (_path: string, _fps: number, _geometry: unknown, _durationMs: number) => frames,
      ),
      decodeFrameAt: jest.fn(
        async (_path: string, _timestampMs: number, _geometry: unknown) => frame,
      ),
      decodeReferenceImage: jest.fn(async (_path: string) => reference),
    };
    const adapter = new LocalStorageMediaDecoder(
      storage as never,
      decoder as never,
    );
    return { adapter, storage, decoder, frame, frames, reference };
  }

  it('identifies itself as a versioned adapter and reports ready', async () => {
    const { adapter } = build();
    expect(adapter.adapterKey).toBe('ffmpeg-rawvideo');
    expect(adapter.version).toBeTruthy();
    await expect(adapter.checkReady()).resolves.toBe(true);
  });

  it('decodeAnalysisFrames resolves the storage key to a path and passes fps/geometry/duration through', async () => {
    const { adapter, storage, decoder, frames } = build();

    const result = await adapter.decodeAnalysisFrames(
      'assets/clip.mp4',
      5,
      GEOMETRY,
      30_000,
    );

    expect(storage.internalPathFor).toHaveBeenCalledWith('assets/clip.mp4');
    expect(decoder.decodeAnalysisFrames).toHaveBeenCalledWith(
      '/data/videos/assets/clip.mp4',
      5,
      GEOMETRY,
      30_000,
    );
    expect(result).toBe(frames);
  });

  it('decodeFrameAt resolves the key and returns the decoder frame verbatim — the fallback timestamp survives', async () => {
    const { adapter, storage, decoder, frame } = build();

    const result = await adapter.decodeFrameAt('assets/clip.mp4', 29_950, GEOMETRY);

    expect(storage.internalPathFor).toHaveBeenCalledWith('assets/clip.mp4');
    expect(decoder.decodeFrameAt).toHaveBeenCalledWith(
      '/data/videos/assets/clip.mp4',
      29_950,
      GEOMETRY,
    );
    // The port must not relabel: the decoder reported the instant that
    // ACTUALLY decoded (a tail fallback), and callers persist exactly it.
    expect(result).toBe(frame);
    expect(result.timestampMs).toBe(28_950);
  });

  it('decodeReferenceImage resolves the key and passes the image through', async () => {
    const { adapter, storage, decoder, reference } = build();

    const result = await adapter.decodeReferenceImage('refs/img-1.png');

    expect(storage.internalPathFor).toHaveBeenCalledWith('refs/img-1.png');
    expect(decoder.decodeReferenceImage).toHaveBeenCalledWith(
      '/data/videos/refs/img-1.png',
    );
    expect(result).toBe(reference);
  });

  it('never hands the raw storage key to the decoder — only resolved paths cross the boundary', async () => {
    const { adapter, decoder } = build();

    await adapter.decodeAnalysisFrames('assets/clip.mp4', 5, GEOMETRY, 30_000);
    await adapter.decodeFrameAt('assets/clip.mp4', 0, GEOMETRY);
    await adapter.decodeReferenceImage('refs/img-1.png');

    const firstArgs = [
      ...decoder.decodeAnalysisFrames.mock.calls,
      ...decoder.decodeFrameAt.mock.calls,
      ...decoder.decodeReferenceImage.mock.calls,
    ].map((call) => call[0] as unknown as string);
    for (const arg of firstArgs) {
      expect(arg.startsWith('/data/videos/')).toBe(true);
    }
  });
});
