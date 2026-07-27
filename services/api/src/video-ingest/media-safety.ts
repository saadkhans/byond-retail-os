import {
  containsCredentialValue,
  containsKnownSecretToken,
  containsPaymentCardValue,
  isSensitiveKey,
} from '../common/sensitive-keys';

/**
 * Phase 10 upload-safety policy: controlled TEST videos only. A closed
 * allowlist of container types (extension + declared MIME + magic bytes),
 * strict filename hygiene (basename only, safe charset, no traversal), and
 * conservative bounds. Everything not explicitly allowed is a controlled
 * 400 — executables, scripts, images-as-videos, and unknown containers are
 * rejected, not sniffed into acceptance.
 */

/** Stable UPPER_SNAKE error codes persisted on REJECTED/FAILED assets. */
export const VIDEO_ERROR_CODES = {
  PROBE_FAILED: 'PROBE_FAILED',
  EXTRACTION_FAILED: 'EXTRACTION_FAILED',
  EXTRACTOR_UNAVAILABLE: 'EXTRACTOR_UNAVAILABLE',
} as const;

/**
 * Allowed video containers: extension → declared MIME types accepted for it.
 * Small and explicit — Phase 10 ingests short controlled test clips, so
 * there is no reason to accept exotic containers.
 */
const ALLOWED_CONTAINERS: ReadonlyMap<string, readonly string[]> = new Map([
  ['.mp4', ['video/mp4']],
  ['.m4v', ['video/mp4', 'video/x-m4v']],
  ['.mov', ['video/quicktime']],
  ['.webm', ['video/webm']],
  ['.mkv', ['video/x-matroska']],
  ['.avi', ['video/x-msvideo', 'video/avi']],
  ['.mpg', ['video/mpeg']],
  ['.mpeg', ['video/mpeg']],
]);

export const ALLOWED_VIDEO_EXTENSIONS: readonly string[] = [
  ...ALLOWED_CONTAINERS.keys(),
];

// eslint-disable-next-line no-control-regex -- matching control chars IS the guard
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/;

/**
 * Path traversal / path-shaped filenames are REJECTED outright (controlled
 * 400), never repaired: a client that sends "..\\..\\x.mp4" or an absolute
 * path is not confused, it is probing. Windows drive/UNC forms and ADS
 * colons are rejected too.
 */
export function isUnsafeUploadFilename(filename: string): boolean {
  return (
    filename.length === 0 ||
    CONTROL_CHARACTERS.test(filename) ||
    filename.includes('/') ||
    filename.includes('\\') ||
    filename.includes(':') ||
    filename.includes('..') ||
    filename.startsWith('.') ||
    filename.trim() !== filename
  );
}

/**
 * Display-only sanitation for a filename that already passed the traversal
 * rejection: anything outside a conservative charset becomes '_' and the
 * result is length-capped. The sanitized name is NEVER used to build a
 * storage path — storage keys are server-generated.
 */
export function sanitizeOriginalFilename(filename: string): string {
  const sanitized = filename.replace(/[^A-Za-z0-9._-]/g, '_');
  return sanitized.length > 160 ? sanitized.slice(-160) : sanitized;
}

/** Lowercased ".ext" (last dot), or null when the name has no extension. */
export function fileExtensionOf(filename: string): string | null {
  const dot = filename.lastIndexOf('.');
  if (dot <= 0 || dot === filename.length - 1) {
    return null;
  }
  return filename.slice(dot).toLowerCase();
}

export function isAllowedVideoUpload(
  extension: string | null,
  mimeType: string,
): boolean {
  if (!extension) {
    return false;
  }
  const allowedMimes = ALLOWED_CONTAINERS.get(extension);
  return (
    allowedMimes !== undefined && allowedMimes.includes(mimeType.toLowerCase())
  );
}

/**
 * PAN detection tuned for REAL-WORLD text (filenames, container metadata):
 * a card number appears either as a contiguous 13-19 digit run or as digit
 * GROUPS in a KNOWN card grouping (4-4-4-4, 4-6-5, ...) joined by ONE
 * consistent separator ("4111_1111_1111_1111", "4111.1111.1111.1111").
 * Deliberately NOT a strip-all-separators join and NOT an any-separator
 * digit chain: those fabricate Luhn-valid runs from timestamped camera
 * filenames (VID_20260701_003531 → 10% Luhn hit rate) and from ISO 6709
 * GPS strings in phone-video metadata (-26.2050-67.9749+14.431/) —
 * deterministically rejecting ~1 in 10 legitimate real test clips. Date/
 * time groupings (8-6, 8-9) and coordinate shapes (mixed separators,
 * 2/3-digit groups) never match a card grouping, while every standard PAN
 * grouping still Luhn-tests.
 */
const CONTIGUOUS_PAN = /(?<!\d)\d{13,19}(?!\d)/g;
const GROUPED_PAN = /(?<!\d)\d{1,6}(?:([^0-9A-Za-z])\d{1,6}){2,5}(?!\d)/g;
const PAN_GROUP_SHAPES = new Set([
  '4,4,4,4', // 16 — Visa/MC/Discover
  '4,4,4,1', // 13 — legacy Visa grouping variant
  '4,3,3,3', // 13 — legacy Visa
  '4,6,4', // 14 — Diners
  '4,6,5', // 15 — Amex
  '4,4,4,4,1', // 17
  '4,4,4,4,2', // 18
  '4,4,4,4,3', // 19
]);

export function carriesLikelyPan(text: string): boolean {
  for (const candidate of text.match(CONTIGUOUS_PAN) ?? []) {
    if (containsPaymentCardValue(candidate)) {
      return true;
    }
  }
  for (const candidate of text.match(GROUPED_PAN) ?? []) {
    const separators = new Set(candidate.match(/[^0-9]/g) ?? []);
    if (separators.size !== 1) {
      continue; // mixed separators — coordinates/prose, never a card
    }
    const groups = candidate
      .split(/[^0-9]/)
      .filter((group) => group.length > 0);
    if (!PAN_GROUP_SHAPES.has(groups.map((group) => group.length).join(','))) {
      continue; // date/time/coordinate grouping, not a card grouping
    }
    if (containsPaymentCardValue(groups.join(''))) {
      return true;
    }
  }
  return false;
}

/** Credential shapes + known secret tokens + grouped/contiguous PANs. */
function carriesSensitiveRun(text: string): boolean {
  return (
    containsCredentialValue(text) ||
    containsKnownSecretToken(text) ||
    carriesLikelyPan(text)
  );
}

/**
 * Filename-specific sensitive-content policy. The shared value screen
 * recognizes `key=value` credential shapes; filenames additionally carry
 * PANs behind arbitrary single separators ("4111_1111_1111_1111.mp4") and
 * credential-channel words as tokens ("password_hunter2.mp4"):
 *   1. the raw name runs through the credential/secret-token screens plus
 *      the grouping-aware PAN detector above (which stays quiet on
 *      VID_/PXL_-style timestamp names);
 *   2. each alphanumeric token — and each adjacent pair joined ("api"+
 *      "key" → apikey) — is classified with the shared sensitive-KEY list,
 *      so a credential-channel word in a filename is rejected outright.
 * Deliberate overbreadth on the KEY side for a reject-on-write policy on
 * operator-supplied TEST clips.
 */
export function filenameCarriesSensitiveContent(filename: string): boolean {
  if (carriesSensitiveRun(filename)) {
    return true;
  }
  const tokens = filename
    .split(/[^A-Za-z0-9]+/)
    .filter((token) => token.length > 0);
  return tokens.some(
    (token, index) =>
      isSensitiveKey(token) ||
      (index + 1 < tokens.length &&
        isSensitiveKey(token + tokens[index + 1])),
  );
}

// Chunked scan parameters for the payload text screen below. The overlap
// exceeds the longest separator-grouped PAN (19 digits + 18 separators) and
// every KEY_VALUE credential fragment we screen for, so a sensitive run can
// never hide across a chunk boundary.
const PAYLOAD_SCAN_CHUNK_BYTES = 1024 * 1024;
const PAYLOAD_SCAN_OVERLAP_BYTES = 256;
// Printable ASCII runs of at least this length are treated as embedded
// text; shorter runs are overwhelmingly codec noise.
const MIN_PRINTABLE_RUN = 8;
const PRINTABLE_RUN = /[\x20-\x7e]{8,}/g;

/**
 * Payload-level sensitive-text screen: container METADATA (title/comment
 * atoms, subtitle tracks, XMP/ID3 text) is plain bytes inside the upload,
 * so a PAN or credential embedded there would otherwise reach durable
 * storage having passed every filename/magic check. Printable ASCII/UTF-8
 * runs are extracted chunk-by-chunk (bounded memory, boundary overlap) and
 * screened with the shared credential/PAN detectors — both raw and with
 * separators stripped, so grouped digits match too.
 *
 * Both single-byte text (ASCII/UTF-8/latin1) AND UTF-16 text are screened:
 * MP4 ilst data atoms (type 2) and ID3v2 frames (encoding 0x01) store text
 * as UTF-16, where every ASCII code unit pairs with a 0x00 byte — a latin1
 * decode alone would never see it. Each chunk is additionally decoded as
 * UTF-16LE at both byte offsets, which also covers UTF-16BE ASCII (its
 * code units read as LE at the shifted offset).
 *
 * SCOPE (documented limitation): this screens TEXT-ENCODED bytes. Sensitive
 * content that is only VISIBLE IN THE VIDEO FRAMES (a card filmed on
 * camera) is not decodable without real CV, which Phase 10 explicitly
 * excludes — the operational control is that uploads are staged,
 * controlled TEST clips (see README guidance), storage is local/dev only
 * and never served, and later CV phases add frame-content review.
 */
export function bufferCarriesSensitiveText(buffer: Buffer): boolean {
  for (
    let offset = 0;
    offset < buffer.length;
    offset += PAYLOAD_SCAN_CHUNK_BYTES
  ) {
    const end = Math.min(
      buffer.length,
      offset + PAYLOAD_SCAN_CHUNK_BYTES + PAYLOAD_SCAN_OVERLAP_BYTES,
    );
    const chunk = buffer.subarray(offset, end);
    const views = [
      chunk.toString('latin1'),
      chunk.toString('utf16le'),
      chunk.subarray(1).toString('utf16le'),
    ];
    for (const text of views) {
      for (const run of text.match(PRINTABLE_RUN) ?? []) {
        if (run.length < MIN_PRINTABLE_RUN) {
          continue;
        }
        if (carriesSensitiveRun(run)) {
          return true;
        }
      }
    }
  }
  return false;
}

function hasBytes(buffer: Buffer, offset: number, expected: number[]): boolean {
  if (buffer.length < offset + expected.length) {
    return false;
  }
  return expected.every((byte, index) => buffer[offset + index] === byte);
}

/**
 * Container magic-byte check: a script or executable renamed to ".mp4" must
 * not pass the extension/MIME allowlist. This is a cheap structural check
 * on the first bytes of the buffer, not media decoding:
 *   mp4/m4v/mov — "ftyp" at offset 4;
 *   webm/mkv    — EBML header 1A 45 DF A3;
 *   avi         — "RIFF" .... "AVI ";
 *   mpg/mpeg    — MPEG pack/sequence start code 00 00 01 BA / 00 00 01 B3.
 */
export function looksLikeVideoContent(
  buffer: Buffer,
  extension: string,
): boolean {
  switch (extension) {
    case '.mp4':
    case '.m4v':
    case '.mov':
      return hasBytes(buffer, 4, [0x66, 0x74, 0x79, 0x70]); // "ftyp"
    case '.webm':
    case '.mkv':
      return hasBytes(buffer, 0, [0x1a, 0x45, 0xdf, 0xa3]);
    case '.avi':
      return (
        hasBytes(buffer, 0, [0x52, 0x49, 0x46, 0x46]) && // "RIFF"
        hasBytes(buffer, 8, [0x41, 0x56, 0x49, 0x20]) // "AVI "
      );
    case '.mpg':
    case '.mpeg':
      return (
        hasBytes(buffer, 0, [0x00, 0x00, 0x01, 0xba]) ||
        hasBytes(buffer, 0, [0x00, 0x00, 0x01, 0xb3])
      );
    default:
      return false;
  }
}
