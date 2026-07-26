/**
 * Phase 9 raw-media/evidence-artifact policy for the job input descriptor:
 * inference jobs carry SAFE, TYPED references only (zone ids, crop ids,
 * frame counts) — never raw media, media/storage URLs, signed URLs, or
 * artifact descriptors. This complements the shared credential/payment
 * screening in common/sensitive-keys.ts (which rejects secrets); this
 * policy rejects media-shaped content. Both are REJECT-on-write policies
 * (controlled 400), not redaction: media references belong in the future
 * evidence storage phase, and app-database rows must never carry them.
 */

// Normalized (lowercase alphanumeric) key names that are media/artifact
// channels regardless of nesting depth. Includes the Phase 8 mapper's
// FORBIDDEN_FIELDS media set so the two policies cannot drift apart.
const FORBIDDEN_MEDIA_KEYS = new Set([
  'image',
  'images',
  'imagedata',
  'imagebytes',
  'imageuri',
  'imageuris',
  'imageurl',
  'frame',
  'frames',
  'framedata',
  'media',
  'rawmedia',
  'mediaurl',
  'mediauri',
  'video',
  'videourl',
  'videouri',
  'clip',
  'clips',
  'signedurl',
  'presignedurl',
  'storagekey',
  'storagekeys',
  'storageurl',
  'artifact',
  'artifacts',
  'artifacturl',
  'artifacturi',
  'evidenceuri',
  'bytes',
  'base64',
  'pixels',
]);

// Suffix matches catch qualified aliases (cropImageUrl, frameSignedUrl,
// clipStorageKey, ...) without enumerating every prefix.
const FORBIDDEN_MEDIA_SUFFIXES = [
  'imagedata',
  'imagebytes',
  'imageurl',
  'imageuri',
  'mediaurl',
  'mediauri',
  'videourl',
  'videouri',
  'signedurl',
  'presignedurl',
  'storagekey',
  'storageurl',
  'artifacturl',
  'artifacturi',
  'base64',
];

// Inline media smuggled as a VALUE under a harmless key: data: URIs with a
// base64 payload are rejected wherever they appear.
const DATA_URI_VALUE = /data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,/i;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function isForbiddenMediaKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return (
    FORBIDDEN_MEDIA_KEYS.has(normalized) ||
    FORBIDDEN_MEDIA_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
  );
}

/**
 * Recursively searches a JSON-shaped value for a media/artifact-shaped KEY
 * or an inline data:-URI VALUE. Returns the dotted path of the FIRST
 * offense ("trigger.cropImageUrl", "zones[0].frame"), or null when clean.
 */
export function findForbiddenMediaPath(
  value: unknown,
  path = '',
): string | null {
  if (typeof value === 'string') {
    return DATA_URI_VALUE.test(value) ? path || '(value)' : null;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findForbiddenMediaPath(value[index], `${path}[${index}]`);
      if (found) {
        return found;
      }
    }
    return null;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      const keyPath = path ? `${path}.${key}` : key;
      if (isForbiddenMediaKey(key)) {
        return keyPath;
      }
      const found = findForbiddenMediaPath(nested, keyPath);
      if (found) {
        return found;
      }
    }
  }
  return null;
}
