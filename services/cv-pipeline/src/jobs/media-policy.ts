/**
 * The media policy, applied on the WAY OUT.
 *
 * The API screens every inference-job descriptor it receives and rejects
 * media-shaped keys and values with a controlled 400. That screen is the
 * authority and this one does not replace it. This is the sending half:
 * the pipeline refuses to PUT a media reference on the wire in the first
 * place, so a descriptor bug shows up here as a dropped trigger and a
 * counter, not as a stream of 400s against the API and — worse — not as a
 * camera address sitting in an HTTP client's retry log.
 *
 * The rules are deliberately the same rules, restated rather than
 * imported: this package cannot depend on the API's internals, and two
 * independent screens that must both pass is a stronger position than one
 * shared screen that can be weakened in a single place. The API's copy
 * stays authoritative; if the two ever disagree, the API wins and the
 * disagreement is the bug.
 */

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

/** Suffix matches catch qualified aliases (cropImageUrl, frameSignedUrl)
 *  without enumerating every prefix somebody might invent. */
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

/** Inline media under a harmless key: any data: URI with a real media
 *  type is the media itself. */
const DATA_URI_VALUE = /\bdata:[a-z0-9.+-]+\/[a-z0-9.+-]+[;,]/i;

/** Any URI scheme is a fetchable address. Descriptors reference things by
 *  opaque id, never by location — and the camera source is a location. */
const URI_SCHEME_VALUE = /[a-z][a-z0-9+.-]*:\/\//i;
const SINGLE_SLASH_SCHEME_VALUE = /\b(?:file|s3|gs|https?|rtsp|rtmp|ftp):\//i;
const PROTOCOL_RELATIVE_VALUE = /(?:^|[\s"'(,=;:[{])\/\/[^/\s]+(?:\/|$)/;

/** A bare frame.jpg is a media reference even without a scheme. */
const MEDIA_FILE_EXTENSION_VALUE =
  /\.(jpe?g|png|gif|bmp|webp|tiff?|heic|mp4|m4v|avi|mov|mkv|webm|h264|h265|hevc|m3u8|mjpeg|yuv|dng|raw)\b/i;

const SIGNED_URL_PARAM_VALUES = [
  /x-amz-signature=/i,
  /x-amz-credential=/i,
  /x-goog-signature=/i,
  /\bsignature=/i,
];

const AZURE_SAS_SIG = /\bsig=/i;
const AZURE_SAS_CONTEXT = /\bs[ve]=/i;

const MAX_PERCENT_DECODE_DEPTH = 5;

/**
 * The raw value plus every bounded percent-decode stage. Repeated
 * encoding ("s3%253A%252F%252F…") must not hide a location, so screening
 * runs on every stage rather than on the surface string.
 */
export function percentDecodeStages(value: string): string[] {
  const stages = [value];
  let current = value;
  for (let depth = 0; depth < MAX_PERCENT_DECODE_DEPTH; depth += 1) {
    if (!current.includes('%')) {
      break;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      // One malformed escape must not veto screening of the valid pairs
      // around it — lenient decoders downstream would decode them anyway.
      decoded = current.replace(/%([0-9a-f]{2})/gi, (_match, hex: string) =>
        String.fromCharCode(parseInt(hex, 16)),
      );
    }
    if (decoded === current) {
      break;
    }
    stages.push(decoded);
    current = decoded;
  }
  return stages;
}

function matchesForbiddenShape(value: string): boolean {
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

function isForbiddenKeyAtAnyStage(key: string): boolean {
  return percentDecodeStages(key).some(isForbiddenMediaKey);
}

function isForbiddenValue(value: string): boolean {
  return percentDecodeStages(value).some(matchesForbiddenShape);
}

/**
 * The dotted path of the first media-shaped key or value, or null when
 * the descriptor is clean. Returning the PATH and not the value is
 * deliberate: the offending value may be the very thing that must not be
 * logged.
 */
export function findForbiddenMediaPath(
  value: unknown,
  path = '',
): string | null {
  if (typeof value === 'string') {
    return isForbiddenValue(value) ? path || '(value)' : null;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findForbiddenMediaPath(value[index], `${path}[${index}]`);
      if (found !== null) {
        return found;
      }
    }
    return null;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      const keyPath = path === '' ? key : `${path}.${key}`;
      if (isForbiddenKeyAtAnyStage(key)) {
        return keyPath;
      }
      const found = findForbiddenMediaPath(nested, keyPath);
      if (found !== null) {
        return found;
      }
    }
  }
  return null;
}
