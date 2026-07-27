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
  /** Audited screening decision rejected a QUARANTINED upload (media removed). */
  SCREENING_REJECTED: 'SCREENING_REJECTED',
  /**
   * DB-first staging: the asset row committed but the subsequent media
   * write failed — the row is transitioned QUARANTINED → FAILED with this
   * code so it remains durable evidence of the staged upload (satisfying
   * the error_only_terminal_check constraint: error codes exist exactly on
   * REJECTED/FAILED assets).
   */
  UPLOAD_INCOMPLETE: 'UPLOAD_INCOMPLETE',
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
 * PAN detection tuned for REAL-WORLD text (filenames, container metadata).
 *
 * GOVERNING POLICY — the Luhn verdict ALWAYS wins. Any 13-19 digit window
 * whose digits are Luhn-valid is rejected, and NO exemption — epoch range,
 * timestamp key context, calendar shape, GPS/ISO 6709 shape, version-string
 * shape — may override a Luhn-valid window. Shape/context heuristics may
 * only influence WHICH digit chains become candidates; they must never act
 * as barriers that skip the Luhn test on a candidate window. The module's
 * documented reject-on-write overbreadth policy accepts the resulting
 * false positives (~10% of context-free digit shapes are Luhn-valid by
 * chance): a Luhn-valid camera timestamp (VID_20260701_003531) or a
 * Luhn-valid GPS digit join rejecting is acceptable — operators rename the
 * file or strip the metadata. The alternative — context exemptions — was
 * rejected three review cycles in a row because every exemption is a
 * laundering channel ("timestamp=4000000000006", a PAN dressed as
 * coordinates).
 *
 * COVERAGE:
 *   - every CONTIGUOUS digit run of 13+ digits (no upper bound) has every
 *     13-19-digit window inside it Luhn-tested, so a PAN padded with extra
 *     digits (04111111111111111000) cannot hide inside an overlong run;
 *   - every SEPARATED digit chain — groups joined by maximal runs of
 *     non-alphanumeric characters ("4111 - 1111 -- 1111 __ 1111"), whatever
 *     the grouping (4-4-4-4, 8-8, 4-6-5, digit pairs, single digits) and
 *     whether the separators stay consistent or change mid-chain — has
 *     EVERY window of consecutive groups whose joined digits are PAN-length
 *     Luhn-tested, so decoy digit groups before/after a card
 *     (4111-1111-1111-1111-9) never launder it either.
 * Separator placement never launders raw card data, and no digit shape
 * (calendar, epoch, coordinate, version) ever rescues a Luhn-valid window.
 */
const CONTIGUOUS_DIGIT_RUN = /(?<!\d)\d{13,}(?!\d)/g;
// Up to 26 separator-joined digit groups: covers a 19-digit PAN split into
// single digits (19 groups) with margin for decoy groups around it. Each
// separator is a MAXIMAL run of non-alphanumeric characters, so
// "4111 - 1111" chains exactly like "4111-1111".
const GROUPED_PAN = /(?<!\d)\d+(?:[^0-9A-Za-z]+\d+){1,25}(?!\d)/g;

/** Pure Luhn verdict on an exact 13-19-digit window — no shape exemptions. */
function isLuhnValidPanWindow(digits: string): boolean {
  return (
    digits.length >= 13 &&
    digits.length <= 19 &&
    containsPaymentCardValue(digits)
  );
}

export function carriesLikelyPan(text: string): boolean {
  for (const match of text.matchAll(CONTIGUOUS_DIGIT_RUN)) {
    if (digitWindowsCarryPan(match[0])) {
      return true;
    }
  }
  for (const match of text.matchAll(GROUPED_PAN)) {
    // Window-scan the FULL separated digit chain regardless of separator
    // changes — "4111-1111 1111-1111" joins to a PAN even though no
    // consistent-separator sub-run reaches 13 digits.
    const groups = match[0].split(/\D+/).filter((group) => group.length > 0);
    if (groupWindowsCarryPan(groups)) {
      return true;
    }
  }
  return false;
}

/**
 * Luhn-tests EVERY 13-19-digit window inside a contiguous digit run of any
 * length: a PAN embedded in an overlong run (04111111111111111000) or a
 * 13-digit card inside a 14-digit run must not hide behind the full run's
 * length or Luhn verdict.
 */
function digitWindowsCarryPan(run: string): boolean {
  for (let start = 0; start < run.length; start += 1) {
    const maxLength = Math.min(19, run.length - start);
    for (let length = 13; length <= maxLength; length += 1) {
      if (isLuhnValidPanWindow(run.slice(start, start + length))) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Luhn-tests EVERY window of consecutive digit groups whose joined digits
 * are PAN-length (13-19): a card padded with decoy digit groups, or split
 * into many small groups, must not hide behind the full join being
 * over-length or Luhn-invalid. The Luhn verdict is final per window — no
 * timestamp/GPS shape rescues a Luhn-valid join (see policy above).
 */
function groupWindowsCarryPan(groups: readonly string[]): boolean {
  for (let start = 0; start < groups.length; start += 1) {
    let digits = '';
    for (let end = start; end < groups.length; end += 1) {
      digits += groups[end];
      if (digits.length > 19) {
        break;
      }
      if (digits.length >= 13 && isLuhnValidPanWindow(digits)) {
        return true;
      }
    }
  }
  return false;
}

// Card credential labels FUSED with their value in one token: "cvv123",
// "pin1234", "pan4111111111111111" — no '='/':' for the shared value screen
// and no separator for the token/key screens. The label must sit on a token
// boundary and be followed DIRECTLY by a digit: ordinary words that merely
// start with the letters (pinch, pink, panorama, pancake, csch...) never
// match. Label list mirrors the short card words in sensitive-keys.ts
// (SENSITIVE_TOKENS): cvv/cvc/cvn/csc/pin/pan/iban (cvv2/cvc2 fused values
// are covered by the cvv/cvc prefixes).
const FUSED_CREDENTIAL_LABEL = /(?<![A-Za-z0-9])(?:cvv|cvc|cvn|csc|pin|pan|iban)\d/i;

/**
 * Free-text sensitive-content screen — the single predicate for screening
 * ANY operator-supplied free text (audit/screening notes, metadata text
 * runs, filenames) before it is persisted:
 *   - `key=value` / `key: value` credential fragments and credential-bearing
 *     URLs (containsCredentialValue);
 *   - bare well-known secret tokens (sk_live_..., JWTs, AKIA..., ghp_...);
 *   - credential labels FUSED with their value in one token (cvv123,
 *     pin1234, pan4111111111111111);
 *   - grouping-aware PAN windows under the Luhn-verdict-wins policy above.
 * Returns true when the text must be REJECTED (reject-on-write policy).
 */
export function containsSensitiveFreeText(text: string): boolean {
  return (
    containsCredentialValue(text) ||
    containsKnownSecretToken(text) ||
    FUSED_CREDENTIAL_LABEL.test(text) ||
    carriesLikelyPan(text)
  );
}

/**
 * Filename-specific sensitive-content policy. The shared value screen
 * recognizes `key=value` credential shapes; filenames additionally carry
 * PANs behind arbitrary single separators ("4111_1111_1111_1111.mp4") and
 * credential-channel words as tokens ("password_hunter2.mp4"):
 *   1. the raw name runs through the credential/secret-token screens, the
 *      fused label+value screen ("cvv123.mp4"), and the grouping-aware PAN
 *      detector above (Luhn verdict wins: the ~10% of VID_/PXL_-style
 *      timestamp names whose digit joins are Luhn-valid by chance reject —
 *      accepted overbreadth, operators rename the file);
 *   2. each alphanumeric token — and each adjacent pair joined ("api"+
 *      "key" → apikey) — is classified with the shared sensitive-KEY list,
 *      so a credential-channel word in a filename is rejected outright.
 * Deliberate overbreadth on the KEY side for a reject-on-write policy on
 * operator-supplied TEST clips.
 */
export function filenameCarriesSensitiveContent(filename: string): boolean {
  if (containsSensitiveFreeText(filename)) {
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
// exceeds every single-character-separated PAN grouping (19 digits + 18
// separators) and every KEY_VALUE credential fragment we screen for, so a
// sensitive run cannot hide across a chunk boundary. (A PAN stretched past
// 256 bytes with multi-character separator runs COULD straddle a boundary
// undetected — an accepted bound: chunks are 1 MiB, so the straddle window
// is ~0.025% of positions, and every non-straddling occurrence still
// rejects.)
const PAYLOAD_SCAN_CHUNK_BYTES = 1024 * 1024;
const PAYLOAD_SCAN_OVERLAP_BYTES = 256;
// Printable ASCII runs of at least this length are treated as embedded
// text; shorter runs are overwhelmingly codec noise. The floor is FIVE, not
// eight: the shortest credential fragment the shared screen classifies is
// `cvv=1`/`pin=1` (5 chars) — a higher floor would discard `cvv=123` before
// containsCredentialValue ever saw it.
const MIN_PRINTABLE_RUN = 5;
const PRINTABLE_RUN = /[\x20-\x7e]{5,}/g;

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
        if (containsSensitiveFreeText(run)) {
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
