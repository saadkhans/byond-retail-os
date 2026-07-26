import { findForbiddenMediaPath, isForbiddenMediaKey } from './media-policy';

describe('inference media policy', () => {
  describe('isForbiddenMediaKey', () => {
    it.each([
      'image',
      'imageData',
      'image_bytes',
      'frame',
      'frames',
      'media',
      'mediaUrl',
      'videoUrl',
      'signedUrl',
      'presignedUrl',
      'storageKey',
      'storageUrl',
      'artifact',
      'artifacts',
      'artifactUrl',
      'bytes',
      'base64',
      'pixels',
      // Qualified aliases via suffix matching.
      'cropImageUrl',
      'frameSignedUrl',
      'clipStorageKey',
      'thumbnailBase64',
    ])('flags media-shaped key "%s"', (key) => {
      expect(isForbiddenMediaKey(key)).toBe(true);
    });

    it.each([
      'zoneId',
      'cropId',
      'frameCount',
      'framework',
      'imagination',
      'triggerType',
      'shelfZone',
      'confidenceThreshold',
    ])('keeps harmless key "%s"', (key) => {
      expect(isForbiddenMediaKey(key)).toBe(false);
    });
  });

  describe('findForbiddenMediaPath', () => {
    it('returns null for a safe typed descriptor', () => {
      expect(
        findForbiddenMediaPath({
          trigger: 'hand-in-zone',
          zoneId: 'zone-3',
          cropId: 'crop-42',
          frameCount: 4,
        }),
      ).toBeNull();
    });

    it('finds a media key at any nesting depth', () => {
      expect(
        findForbiddenMediaPath({
          trigger: { context: { cropImageUrl: 's3://bucket/crop.jpg' } },
        }),
      ).toBe('trigger.context.cropImageUrl');
    });

    it('finds a media key inside arrays', () => {
      expect(
        findForbiddenMediaPath({ zones: [{ zoneId: 'z1' }, { frame: 7 }] }),
      ).toBe('zones[1].frame');
    });

    it('finds an inline data: URI smuggled under a harmless key', () => {
      expect(
        findForbiddenMediaPath({
          note: 'data:image/jpeg;base64,/9j/4AAQSkZJRg',
        }),
      ).toBe('note');
    });

    it.each([
      ['an s3 URL under an innocuous key', { cropId: 's3://bucket/frame.jpg' }, 'cropId'],
      ['an https media URL', { reference: 'https://host/frame.jpg' }, 'reference'],
      ['a stream URL without an extension', { ref: 'rtsp://cam.local/stream' }, 'ref'],
      ['a gs URL', { pointer: 'gs://bucket/object' }, 'pointer'],
      ['a bare media filename', { name: 'frame.jpg' }, 'name'],
      ['a nested media filename value', { zones: [{ hint: 'aisle3.mp4' }] }, 'zones[0].hint'],
      [
        'AWS presigned signature params',
        { token: 'X-Amz-Signature=abc&X-Amz-Credential=xyz' },
        'token',
      ],
      [
        'an Azure SAS fragment',
        { token: 'sv=2024-01-01&se=2026-08-01&sig=abc123' },
        'token',
      ],
      ['a single-slash file: path', { ref: 'file:/tmp/clip001' }, 'ref'],
      ['a single-slash s3: path', { ref: 's3:/bucket/object' }, 'ref'],
      [
        'a protocol-relative reference',
        { ref: '//cdn.host/frames/1' },
        'ref',
      ],
      [
        'a percent-encoded media extension',
        { name: 'frame%2Ejpg' },
        'name',
      ],
      [
        'a percent-encoded scheme',
        { ref: 's3%3A%2F%2Fbucket%2Fframe' },
        'ref',
      ],
      [
        'a DOUBLY percent-encoded scheme',
        { ref: 's3%253A%252F%252Fbucket%252Fframe' },
        'ref',
      ],
      [
        'a TRIPLY percent-encoded scheme',
        { ref: 's3%25253A%25252F%25252Fbucket%25252Fframe' },
        'ref',
      ],
      [
        'a doubly percent-encoded media extension',
        { name: 'frame%252Ejpg' },
        'name',
      ],
    ])('rejects %s by VALUE', (_label, descriptor, path) => {
      expect(findForbiddenMediaPath(descriptor)).toBe(path);
    });

    it.each([
      ['plain opaque ids', { cropId: 'crop-8f3a', zoneId: 'TRIGGER_ZONE_A' }],
      ['dotted ids without a media extension', { source: 'shelf.cam.7' }],
      ['a numeric value under a rate-style key', { framerate: 30 }],
      ['a version-style dotted value', { contract: 'v2.1.0' }],
      ['a namespaced id with one slash', { ref: 'v2:zone/7' }],
      ['a bare percent sign', { discount: '15% off shelf 3' }],
      ['an encoded literal percent', { discount: '100%25' }],
    ])('keeps %s', (_label, descriptor) => {
      expect(findForbiddenMediaPath(descriptor)).toBeNull();
    });
  });
});
