import { LocalPickupMediaAdapter } from './local-pickup-media.adapter';

/**
 * Composition contract for classical-v1's media port: services hand the
 * adapter managed STORAGE KEYS, and the adapter alone resolves them to
 * local filesystem paths (internalPathFor — a capability of the concrete
 * local storage adapter, deliberately absent from the port) before
 * delegating to the confined ffmpeg decoder. Mirrors the fusion module's
 * LocalStorageMediaDecoder seam.
 */
describe('LocalPickupMediaAdapter', () => {
  function build() {
    const storage = {
      internalPathFor: jest.fn((key: string) => `/data/videos/${key}`),
    };
    const decoder = {
      decodeAnalysisFrames: jest.fn(async () => [
        { index: 0, timestampMs: 0, rgb: Buffer.alloc(3) },
      ]),
      decodeReferenceImage: jest.fn(async () => ({
        width: 96,
        height: 96,
        rgb: Buffer.alloc(96 * 96 * 3),
      })),
    };
    const adapter = new LocalPickupMediaAdapter(
      storage as never,
      decoder as never,
    );
    return { adapter, storage, decoder };
  }

  it('resolves the storage key to a local path before decoding analysis frames', async () => {
    const { adapter, storage, decoder } = build();
    const geometry = { width: 40, height: 30 };

    await adapter.decodeAnalysisFrames('assets/clip.mp4', 2, geometry, 8000);

    expect(storage.internalPathFor).toHaveBeenCalledWith('assets/clip.mp4');
    expect(decoder.decodeAnalysisFrames).toHaveBeenCalledWith(
      '/data/videos/assets/clip.mp4',
      2,
      geometry,
      8000,
    );
  });

  it('resolves the storage key to a local path before decoding a reference image', async () => {
    const { adapter, storage, decoder } = build();

    await adapter.decodeReferenceImage('refs/img-1.png');

    expect(storage.internalPathFor).toHaveBeenCalledWith('refs/img-1.png');
    expect(decoder.decodeReferenceImage).toHaveBeenCalledWith(
      '/data/videos/refs/img-1.png',
    );
  });
});
