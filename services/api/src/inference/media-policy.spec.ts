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
  });
});
