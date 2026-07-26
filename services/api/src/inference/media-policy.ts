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

// A media/storage reference is rejected by its VALUE shape too, so an
// innocuous key ({"cropId": "s3://bucket/frame.jpg"}) cannot smuggle one
// past the key policy. Any URI scheme is a fetchable-location channel
// (s3://, gs://, https://, rtsp://, file://, ...): descriptors reference
// crops/zones/frames by OPAQUE ID, never by address.
const URI_SCHEME_VALUE = /[a-z][a-z0-9+.-]*:\/\//i;

// Single-slash scheme forms (file:/tmp/clip, s3:/bucket/x) and protocol-
// relative references (//cdn.host/frames/1) are addresses too; the scheme
// list is explicit so dotted opaque ids ("v2:zone/7") are not caught.
const SINGLE_SLASH_SCHEME_VALUE = /\b(?:file|s3|gs|https?|rtsp|rtmp|ftp):\//i;
const PROTOCOL_RELATIVE_VALUE = /^\/\/[^/\s]+\//;

// Media file extensions as ".ext" occurrences (word-bounded, case-
// insensitive): a bare "frame.jpg" is a media reference even without a
// scheme. Dotted opaque ids without a media extension (shelf.cam.7) pass.
const MEDIA_FILE_EXTENSION_VALUE =
  /\.(jpe?g|png|gif|bmp|webp|tiff?|heic|mp4|m4v|avi|mov|mkv|webm|h264|h265|hevc|m3u8|mjpeg|yuv|dng|raw)\b/i;

// Presigned/signature query fragments (explicit list, mirroring the
// explicit-provider stance of sensitive-keys.ts): even a value that dodged
// the scheme/extension checks is rejected when it carries signing params.
const SIGNED_URL_PARAM_VALUES = [
  /x-amz-signature=/i,
  /x-amz-credential=/i,
  /x-goog-signature=/i,
  /\bsignature=/i,
];

// Azure SAS tokens: sig= alone is too generic, but combined with the SAS
// version/expiry params it is unambiguous.
const AZURE_SAS_SIG = /\bsig=/i;
const AZURE_SAS_CONTEXT = /\bs[ve]=/i;

function matchesForbiddenMediaShape(value: string): boolean {
  return (
    DATA_URI_VALUE.test(value) ||
    URI_SCHEME_VALUE.test(value) ||
    SINGLE_SLASH_SCHEME_VALUE.test(value) ||
    PROTOCOL_RELATIVE_VALUE.test(value) ||
    MEDIA_FILE_EXTENSION_VALUE.test(value) ||
    SIGNED_URL_PARAM_VALUES.some((pattern) => pattern.test(value)) ||
    (AZURE_SAS_SIG.test(value) && AZURE_SAS_CONTEXT.test(value))
  );
}

function isForbiddenMediaValue(value: string): boolean {
  if (matchesForbiddenMediaShape(value)) {
    return true;
  }
  // Percent-encoding must not hide a media shape ("frame%2Ejpg").
  if (value.includes('%')) {
    try {
      return matchesForbiddenMediaShape(decodeURIComponent(value));
    } catch {
      // Not valid percent-encoding; the raw-value checks above stand.
    }
  }
  return false;
}

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
 * or a media-shaped VALUE (inline data: URI, any URI scheme, media file
 * extension, presigned-URL signature params). Returns the dotted path of
 * the FIRST offense ("trigger.cropImageUrl", "zones[0].frame"), or null
 * when clean.
 */
export function findForbiddenMediaPath(
  value: unknown,
  path = '',
): string | null {
  if (typeof value === 'string') {
    return isForbiddenMediaValue(value) ? path || '(value)' : null;
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
