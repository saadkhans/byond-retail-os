import { findForbiddenMediaPath, percentDecodeStages } from './media-policy';

describe('media policy — forbidden keys', () => {
  it.each([
    'image',
    'images',
    'frame',
    'frames',
    'video',
    'clip',
    'storageKey',
    'signedUrl',
    'presignedUrl',
    'artifact',
    'bytes',
    'base64',
    'pixels',
  ])('rejects the channel key %s', (key) => {
    expect(findForbiddenMediaPath({ [key]: 'anything' })).toBe(key);
  });

  it.each([
    'cropImageUrl',
    'frameSignedUrl',
    'clipStorageKey',
    'evidenceMediaUri',
    'thumbnailBase64',
  ])('rejects the qualified alias %s', (key) => {
    expect(findForbiddenMediaPath({ [key]: 'x' })).toBe(key);
  });

  it('normalizes separators and case before matching', () => {
    expect(findForbiddenMediaPath({ 'storage_key': 'x' })).toBe('storage_key');
    expect(findForbiddenMediaPath({ 'Storage-Key': 'x' })).toBe('Storage-Key');
  });

  it('allows opaque reference keys', () => {
    expect(
      findForbiddenMediaPath({
        cropId: 'crp_123',
        zoneCode: 'A1',
        frameIndex: 7,
      }),
    ).toBeNull();
  });
});

describe('media policy — forbidden values', () => {
  it.each([
    ['an inline data URI', 'data:image/jpeg;base64,/9j/4AAQ'],
    ['an s3 location', 's3://bucket/frames/1.jpg'],
    ['an https location', 'https://cdn.example.test/frame.png'],
    ['an rtsp camera address', 'rtsp://camera.local/stream1'],
    ['a file path with a scheme', 'file:///var/media/clip.mp4'],
    ['a single-slash scheme', 'file:/tmp/clip'],
    ['a protocol-relative locator', '//cdn.example.test/frames/1'],
    ['a bare media filename', 'frame.jpg'],
    ['a presigned signature', 'ref?X-Amz-Signature=deadbeef'],
  ])('rejects %s under an innocuous key', (_label, value) => {
    expect(findForbiddenMediaPath({ cropId: value })).toBe('cropId');
  });

  it('rejects an Azure SAS only with its version context', () => {
    expect(findForbiddenMediaPath({ ref: 'x?sig=abc&se=2026' })).toBe('ref');
    // `sig=` alone is too generic to reject on its own.
    expect(findForbiddenMediaPath({ ref: 'design=abc' })).toBeNull();
  });

  it('sees through repeated percent encoding', () => {
    const doubled = 's3%253A%252F%252Fbucket%252Fframe.jpg';
    expect(findForbiddenMediaPath({ cropId: doubled })).toBe('cropId');
  });

  it('decodes valid pairs even when one escape is malformed', () => {
    // A lenient decoder downstream would still resolve the valid pairs, so
    // a single bad escape must not be a way to smuggle a location past.
    const stages = percentDecodeStages('s3%3A%2F%2Fbucket%zz');
    expect(stages.some((stage) => stage.includes('s3://'))).toBe(true);
  });

  it('allows dotted opaque ids that are not locations', () => {
    expect(
      findForbiddenMediaPath({ cameraRef: 'shelf.cam.7', cropId: 'v2:zone/7' }),
    ).toBeNull();
  });
});

describe('media policy — structure', () => {
  it('reports the dotted path of a nested offence', () => {
    expect(
      findForbiddenMediaPath({
        trigger: { kind: 'HAND_IN_ZONE' },
        evidence: { peak: 0.4, source: 'rtsp://camera.local/1' },
      }),
    ).toBe('evidence.source');
  });

  it('reports an indexed path inside an array', () => {
    expect(
      findForbiddenMediaPath({ refs: ['crp_1', 'crp_2', 'frame.png'] }),
    ).toBe('refs[2]');
  });

  it('passes a clean descriptor of numbers and codes', () => {
    expect(
      findForbiddenMediaPath({
        trigger: {
          kind: 'HAND_IN_ZONE',
          zoneCode: 'A1',
          startFrameIndex: 12,
          endFrameIndex: 18,
        },
        evidence: { peakMotionRatio: 0.42, frameCount: 6 },
      }),
    ).toBeNull();
  });
});
