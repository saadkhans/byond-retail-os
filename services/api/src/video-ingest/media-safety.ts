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
 * COVERAGE: every 13-19 digit sequence that is contiguous OR split by ANY
 * mix of single-character separators — whatever the grouping (4-4-4-4,
 * 8-8, 4-6-5, digit pairs, single digits) and whether the separators stay
 * consistent ("4111-1111-1111-1111") or change mid-chain
 * ("4111-1111 1111-1111") — is digit-joined and Luhn-tested. Within a
 * separated chain EVERY window of consecutive groups whose joined digits
 * are PAN-length is tested, so decoy digit groups before/after a card
 * (4111-1111-1111-1111-9) never launder it either. Separator placement
 * never launders raw card data.
 * PRECISION: the digit shapes that saturate real video uploads are
 * exempted by STRUCTURE or KEY CONTEXT, never by a bare numeric range:
 *   - calendar timestamps (VID_20260701_003531, modify dates, 20260701003531
 *     contiguous) — a valid YYYYMMDD[HHMMSS[mmm]] reading is a timestamp,
 *     not a card;
 *   - 13-digit epoch milliseconds ONLY when attached to a timestamp-like
 *     key (creation_time=1753622627001, "modify date 1753622627001"). A
 *     BARE Luhn-valid 13-digit run is rejected: 4000000000006 — the
 *     standard 13-digit Visa test PAN — sits inside the epoch numeric
 *     range, so a range-only exemption would wave real card data through.
 *     The documented reject-on-write overbreadth accepts the ~10% Luhn
 *     false-positive rate on context-free epoch values instead;
 *   - ISO 6709 GPS chains (-26.2050-67.9749+14.431/) are recognized
 *     STRUCTURALLY — signed 2-digit latitude and 2-3 digit longitude with
 *     fractional degrees, optional signed altitude — and their digit
 *     groups are excluded from windowing (a coordinate chain is never a
 *     card grouping, while a PAN reformatted as fake coordinates still has
 *     to fit real lat/lon ranges to hide).
 */
const CONTIGUOUS_PAN = /(?<!\d)\d{13,19}(?!\d)/g;
// Up to 26 separator-joined digit groups: covers a 19-digit PAN split into
// single digits (19 groups) with margin for decoy groups around it.
const GROUPED_PAN = /(?<!\d)\d{1,19}(?:[^0-9A-Za-z]\d{1,19}){1,25}(?!\d)/g;

// ISO 6709 coordinate chain as written by phone cameras into location
// atoms: ±DD.D{1,6} latitude (00-90), ±DDD.D{1,6} longitude (000-180),
// optional ±altitude, optional trailing '/'. Fractional degrees are
// REQUIRED on lat/lon — that is what real GPS metadata carries, and it
// keeps plain dashed/spaced digit chains (i.e. separated PANs) from ever
// matching the shape.
const ISO6709_CHAIN =
  /[+-](?:[0-8]\d|90)\.\d{1,6}[+-](?:180|1[0-7]\d|0\d\d|\d\d)\.\d{1,6}(?:[+-]\d{1,4}(?:\.\d{1,6})?)?\/?/g;

/** [start, end) spans of structurally recognized ISO 6709 GPS chains. */
function coordinateChainSpans(text: string): Array<readonly [number, number]> {
  const spans: Array<readonly [number, number]> = [];
  for (const match of text.matchAll(ISO6709_CHAIN)) {
    const start = match.index ?? 0;
    spans.push([start, start + match[0].length]);
  }
  return spans;
}

function insideAnySpan(
  spans: ReadonlyArray<readonly [number, number]>,
  start: number,
  end: number,
): boolean {
  return spans.some(([from, to]) => start >= from && end <= to);
}

/** 13-digit epoch milliseconds for the 2001-2099 era (0.98e12 .. 4.1e12). */
function isPlausibleEpochMillis(digits: string): boolean {
  if (digits.length !== 13) {
    return false;
  }
  const epochMs = Number(digits);
  return epochMs >= 978_307_200_000 && epochMs <= 4_102_444_800_000;
}

// Key-ish token (with trailing '='/':'/'whitespace' separators) directly
// preceding a digit run, e.g. "creation_time=", "modify date ", "ts ".
const KEY_BEFORE_DIGITS = /([A-Za-z][A-Za-z0-9_.-]{0,39})[\s=:]{0,3}$/;
const TIMESTAMP_KEY_WORDS = new Set([
  'time',
  'timestamp',
  'datetime',
  'date',
  'ts',
  'dts',
  'pts',
  'stamp',
  'epoch',
  'created',
  'creation',
  'create',
  'modified',
  'modify',
  'utc',
]);

/** Splits a key on separators and camelCase: creationTime → [creation, time]. */
function keyWordsOf(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase());
}

/**
 * CONTEXTUAL timestamp evidence for a digit run starting at `index`: the
 * run is attached to a timestamp-like key ("creation_time=...",
 * "modify date ...", "ts ..."). A bare epoch-shaped number has NO such
 * evidence and gets no exemption.
 */
function hasTimestampKeyContext(text: string, index: number): boolean {
  const tail = text.slice(Math.max(0, index - 48), index);
  const match = KEY_BEFORE_DIGITS.exec(tail);
  if (!match) {
    return false;
  }
  const words = keyWordsOf(match[1]);
  const last = words[words.length - 1];
  return last !== undefined && TIMESTAMP_KEY_WORDS.has(last);
}

/** YYYYMMDDHHMMSS[mmm] with real calendar/clock semantics (14-17 digits). */
function isPlausibleTimestampDigits(digits: string): boolean {
  if (digits.length < 14 || digits.length > 17) {
    return false;
  }
  const year = Number(digits.slice(0, 4));
  const month = Number(digits.slice(4, 6));
  const day = Number(digits.slice(6, 8));
  const hour = Number(digits.slice(8, 10));
  const minute = Number(digits.slice(10, 12));
  const second = Number(digits.slice(12, 14));
  return (
    year >= 1970 &&
    year <= 2099 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= 31 &&
    hour < 24 &&
    minute < 60 &&
    second < 60
  );
}

function isLuhnValidPanDigits(digits: string): boolean {
  return (
    digits.length >= 13 &&
    digits.length <= 19 &&
    !isPlausibleTimestampDigits(digits) &&
    containsPaymentCardValue(digits)
  );
}

export function carriesLikelyPan(text: string): boolean {
  const gpsSpans = coordinateChainSpans(text);
  for (const match of text.matchAll(CONTIGUOUS_PAN)) {
    const digits = match[0];
    // Epoch-milliseconds exemption requires CONTEXT: the run must be
    // attached to a timestamp-like key. A bare Luhn-valid 13-digit run
    // (4000000000006) is card data, however epoch-shaped its value is.
    if (
      isPlausibleEpochMillis(digits) &&
      hasTimestampKeyContext(text, match.index ?? 0)
    ) {
      continue;
    }
    if (isLuhnValidPanDigits(digits)) {
      return true;
    }
  }
  for (const match of text.matchAll(GROUPED_PAN)) {
    // Window-scan the FULL separated digit chain regardless of separator
    // changes — "4111-1111 1111-1111" joins to a PAN even though no
    // consistent-separator sub-run reaches 13 digits. Digit groups inside
    // a structurally recognized ISO 6709 GPS chain are barriers: windows
    // never extend across coordinate digits, so location atoms pass while
    // any non-coordinate 13-19 digit join is Luhn-tested.
    const base = match.index ?? 0;
    let run: string[] = [];
    for (const group of match[0].matchAll(/\d+/g)) {
      const start = base + (group.index ?? 0);
      if (insideAnySpan(gpsSpans, start, start + group[0].length)) {
        if (groupWindowsCarryPan(run)) {
          return true;
        }
        run = [];
      } else {
        run.push(group[0]);
      }
    }
    if (groupWindowsCarryPan(run)) {
      return true;
    }
  }
  return false;
}

/**
 * Luhn-tests EVERY window of consecutive digit groups whose joined digits
 * are PAN-length (13-19): a card padded with decoy digit groups, or split
 * into many small groups, must not hide behind the full join being
 * over-length or Luhn-invalid. Timestamp semantics apply per window.
 */
function groupWindowsCarryPan(groups: readonly string[]): boolean {
  for (let start = 0; start < groups.length; start += 1) {
    let digits = '';
    for (let end = start; end < groups.length; end += 1) {
      digits += groups[end];
      if (digits.length > 19) {
        break;
      }
      if (digits.length >= 13 && isLuhnValidPanDigits(digits)) {
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
 * Credential shapes + known secret tokens + fused credential-label tokens
 * + grouped/contiguous PANs.
 */
function carriesSensitiveRun(text: string): boolean {
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
 *      detector above (which stays quiet on VID_/PXL_-style timestamp
 *      names);
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
