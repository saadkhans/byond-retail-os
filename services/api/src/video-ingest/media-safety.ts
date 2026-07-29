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
  /**
   * PRE-STORAGE frame screening (OCR text recognition over sampled frames
   * of the STAGED upload) found credential- or payment-bearing content
   * BEFORE any media reached durable storage: the PENDING_MEDIA staging
   * row transitions directly to REJECTED with this code (error codes exist
   * exactly on REJECTED/FAILED — error_only_terminal_check). The
   * recognized text itself is NEVER stored, echoed, or audited — only the
   * index of the frame that tripped the screen.
   */
  PRESTORE_SCREENING_REJECTED: 'PRESTORE_SCREENING_REJECTED',
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
 *     (4111-1111-1111-1111-9) never launder it either;
 *   - every OVERFLOW chain — one whose full digit join exceeds 19 digits,
 *     i.e. where some aligned join of consecutive groups overruns the PAN
 *     length bound — is ADDITIONALLY char-level windowed over its full
 *     concatenated digits (every 13-19-digit substring Luhn-tested), because
 *     the group-aligned scan abandons overrunning joins and is therefore
 *     blind to PAN windows that START mid-group and cross a group boundary
 *     ("000000014111111111-111111": 18-digit group carrying 8 zeros + the
 *     first 10 card digits, then the remaining 6 — the aligned join is 24
 *     digits, but offset 8 starts a Luhn-valid 16-digit card). Chains whose
 *     full join is <=19 digits keep aligned-only windowing — no aligned join
 *     ever overruns there, so the scan has no blind spot — which is what
 *     lets Luhn-invalid ISO datetimes (14-digit join) and camera stamps
 *     (14/17) keep their adjudicated accepts.
 * Separator placement never launders raw card data, and no digit shape
 * (calendar, epoch, coordinate, version) ever rescues a Luhn-valid window.
 *
 * BOUNDED WORK, FAIL CLOSED: char-level windowing costs O(digits x 7) Luhn
 * checks, so a pathological chain (1 MiB of "1-" joins to 500k digits)
 * would burn seconds per view. Any single run/chain carrying more than
 * MAX_WINDOW_SCAN_DIGITS digits is therefore REJECTED outright instead of
 * scanned: an unbroken digit-and-separator stretch that long is not
 * plausible video metadata (real binary payloads break every few bytes on
 * an ASCII letter), and a truncated scan could not prove the absence of a
 * card anyway. Same policy as the chunk-boundary carry overflow below —
 * bounded state, overflow rejects, never unbounded work.
 */
const CONTIGUOUS_DIGIT_RUN = /(?<!\d)\d{13,}(?!\d)/g;
// The COMPLETE maximal separated digit chain, with NO group cap: a fixed
// repetition bound (an earlier {1,25}) split longer chains into a first
// match plus a remainder, so a PAN whose window crossed the cap boundary
// (11 decoy single-digit groups + a 16-digit card split into single digits
// = 27 groups) was never Luhn-tested. Each separator is a MAXIMAL run of
// non-alphanumeric characters, so "4111 - 1111" chains exactly like
// "4111-1111". The separator class is "any code unit that is not an ASCII
// alphanumeric": whitespace (space, tab, CR, LF), punctuation, AND every
// non-ASCII code unit — em/en dash, bullet, NBSP, ideographic space, or the
// individual bytes of a multi-byte UTF-8 separator seen through a latin1
// decode — so separator choice never splits a chain; only ASCII letters or
// end-of-digit-chain break it. The pattern is linear-time — the digit and
// separator character classes are disjoint, so there is no backtracking
// ambiguity — and the window scan below is O(groups x 7) because each
// window join is abandoned past 19 digits.
const GROUPED_PAN = /(?<!\d)\d+(?:[^0-9A-Za-z]+\d+)+(?!\d)/g;

/**
 * Work bound for the char-level window scans (see the policy note above).
 * 4096 digits covers any realistic metadata atom by orders of magnitude
 * (the longest legitimate shapes here are timestamps, GPS chains, and
 * version strings — tens of digits); anything longer rejects unscanned.
 */
const MAX_WINDOW_SCAN_DIGITS = 4096;

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
    // Fail closed rather than scan an implausibly long run (see policy).
    if (match[0].length > MAX_WINDOW_SCAN_DIGITS) {
      return true;
    }
    if (digitWindowsCarryPan(match[0])) {
      return true;
    }
  }
  for (const match of text.matchAll(GROUPED_PAN)) {
    // Window-scan the FULL separated digit chain regardless of separator
    // changes — "4111-1111 1111-1111" joins to a PAN even though no
    // consistent-separator sub-run reaches 13 digits.
    const groups = match[0].split(/\D+/).filter((group) => group.length > 0);
    // Fail closed rather than scan an implausibly long chain (see policy).
    // Checked BEFORE either window pass: both are per-digit, so the bound
    // is what keeps a 500k-digit chain from burning seconds per view.
    if (totalDigits(groups) > MAX_WINDOW_SCAN_DIGITS) {
      return true;
    }
    if (groupWindowsCarryPan(groups)) {
      return true;
    }
    // OVERFLOW chains: when the chain's full digit join exceeds 19, some
    // aligned join hit groupWindowsCarryPan's >19 abandon, so windows that
    // START mid-group and cross into later groups were never tested
    // ("000000014111111111-111111"). Char-level windowing over the
    // concatenated chain digits closes exactly that blind spot; <=19-join
    // chains skip it and keep the aligned-only adjudicated behavior.
    // Still linear-ish: O(chain digits x 7 window lengths).
    const joined = groups.join('');
    if (joined.length > 19 && digitWindowsCarryPan(joined)) {
      return true;
    }
  }
  return false;
}

/** Total digits carried by a separated chain's groups. */
function totalDigits(groups: readonly string[]): number {
  let total = 0;
  for (const group of groups) {
    total += group.length;
  }
  return total;
}

/**
 * Luhn-tests EVERY 13-19-digit window inside a contiguous digit run of any
 * length: a PAN embedded in an overlong run (04111111111111111000) or a
 * 13-digit card inside a 14-digit run must not hide behind the full run's
 * length or Luhn verdict. Callers bound the input by
 * MAX_WINDOW_SCAN_DIGITS, so the O(digits x 7) cost stays bounded.
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
 *
 * GROUP-ALIGNED ONLY: a join that overruns 19 digits is abandoned, so this
 * scan never sees windows starting MID-group. carriesLikelyPan compensates
 * by char-level windowing the full concatenated digits of any chain whose
 * join exceeds 19 (the only case where the abandon can hide a window).
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

// Numeric credential labels SEPARATED from their digits by whitespace — the
// shape OCR emits when a label and its value sit apart on a card or keypad
// ("CVV 123", "PIN 1234", and "cvv\n123" across an OCR line break: \s
// covers space/tab/CR/LF and nothing is anchored, so multi-line OCR text
// matches wherever the pair occurs). The label list mirrors the fused-label
// card words above minus iban (IBAN values start with letters, never bare
// digits). The left word boundary keeps "coupon 123" / "napkin 42" clean
// (the label letters sit inside a word), and the mandatory whitespace keeps
// "pinch 4" clean ('pin' is followed by a letter, not \s). 'pan' is
// included deliberately: "pan 45" (a camera pan angle) rejecting is
// accepted reject-on-write overbreadth, the same policy that rejects
// Luhn-valid timestamps.
const SPACED_NUMERIC_CREDENTIAL_LABEL =
  /(?<![A-Za-z0-9])(?:cvv|cvc|cvn|csc|pin|pan)\s+\d/i;

// Secret-word labels followed by a whitespace-separated value TOKEN
// ("password hunter2", "pwd\nhunter2" across an OCR line break). The shared
// '='/':' screens (KEY_VALUE_CREDENTIAL / KEY_COLON_CREDENTIAL) accept ANY
// single value character after the separator; whitespace is a far weaker
// binding signal, so the value token here must LOOK like a value — contain
// a digit OR run 6+ characters. That bound keeps short prose clean
// ("password ok", "password reset") while "password redacted" REJECTS
// (pinned): the same words with '=' or ':' already reject via
// containsCredentialValue, and mirroring that verdict beats trying to
// whitelist prose.
//
// The value TOKEN is captured with a BOUNDED quantifier and judged in code
// rather than by an in-regex alternation. An unbounded `\S*\d\S*` after
// `\s+` backtracks catastrophically on a megabyte-scale binary view — the
// engine retries every give-back of the whitespace run against every
// prefix of a long non-whitespace blob — which hung the payload scan.
// `\S{1,64}` is linear, and a token longer than 64 characters already
// satisfies the 6+ length rule, so nothing is lost.
const SPACED_SECRET_LABEL =
  /(?<![A-Za-z0-9])(?:password|passwd|pwd)\s+(\S{1,64})/i;

/** A whitespace-separated secret-label value: has a digit, or runs 6+. */
function carriesSpacedSecretLabel(text: string): boolean {
  const match = SPACED_SECRET_LABEL.exec(text);
  if (match === null) {
    return false;
  }
  const value = match[1];
  return value.length >= 6 || /\d/.test(value);
}

/**
 * Free-text sensitive-content screen — the single predicate for screening
 * ANY operator-supplied free text (OCR frame text, audit/screening notes,
 * metadata text runs, filenames, idempotency keys) before it is persisted
 * or acted on:
 *   - `key=value` / `key: value` credential fragments and credential-bearing
 *     URLs (containsCredentialValue);
 *   - bare well-known secret tokens (sk_live_..., JWTs, AKIA..., ghp_...);
 *   - credential labels FUSED with their value in one token (cvv123,
 *     pin1234, pan4111111111111111);
 *   - credential labels SEPARATED from their value by OCR whitespace —
 *     numeric card labels before digits ("CVV 123", "pin\n1234") and
 *     secret-word labels before a value-shaped token ("password hunter2");
 *   - grouping-aware PAN windows under the Luhn-verdict-wins policy above.
 * Returns true when the text must be REJECTED (reject-on-write policy).
 */
export function containsSensitiveFreeText(text: string): boolean {
  return (
    containsCredentialValue(text) ||
    containsKnownSecretToken(text) ||
    FUSED_CREDENTIAL_LABEL.test(text) ||
    SPACED_NUMERIC_CREDENTIAL_LABEL.test(text) ||
    carriesSpacedSecretLabel(text) ||
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

// Chunked scan parameters for the payload text screen below. Chunks are
// 1 MiB. At each chunk boundary a CONTENT-AWARE CARRY is prepended to the
// NEXT chunk (replacing the earlier fixed 2 KiB overlap appended to the
// previous one): the carry is the longest suffix of the bytes before the
// boundary that could still be part of a separated digit chain, plus a
// bounded LABEL CAPTURE. The backward chain scan carries every byte that
// is NOT an ASCII letter — digits, punctuation, whitespace, control bytes,
// the 0x00 interleave of UTF-16 ASCII text, and every byte of a multi-byte
// UTF-8 separator (all >= 0x80) — because GROUPED_PAN's separator class is
// "not an ASCII alphanumeric": in every decode view only an ASCII letter
// breaks a digit chain, so a suffix containing no letter byte is exactly
// the region a straddling chain could extend through.
// LABEL CAPTURE: when the chain scan stops at an ASCII letter, the carry
// is EXTENDED backward through the contiguous run of bytes that are an
// ASCII letter OR 0x00, capped at LABEL_CARRY_MAX_BYTES (32). This pulls a
// credential label sitting immediately before a long whitespace run into
// the carry ("password" + 3 KiB of spaces + boundary + "hunter2"), so the
// SPACED_* label detectors see label and value together in the next
// chunk's decode. Including 0x00 covers the UTF-16 interleaved label form
// (p\0a\0s\0s\0w\0o\0r\0d), where label letters alternate with NUL high
// bytes; 32 bytes covers the longest label ('password' = 8 letters = 16
// interleaved bytes) with headroom. Cap truncation mid-word can only
// CREATE a word boundary at the carry start (over-detection — the safe
// direction); it can never hide a label the full text would have matched,
// because a label preceded by more letters fails the detectors' left
// word-boundary lookbehind in the full text too.
// FAIL CLOSED ON OVERFLOW: the chain carry is capped at 64 KiB (memory
// and rescan bound). If the backward scan hits the cap while the byte
// beyond it is STILL chain-relevant (no letter terminated the run), the
// carry is necessarily TRUNCATED — bounded state can no longer prove the
// absence of a digit chain straddling the boundary (the dropped bytes may
// hold the chain's leading digits) — so bufferCarriesSensitiveText
// REJECTS outright. A >64 KiB unbroken letter-free run straddling a 1 MiB
// boundary is pathological for controlled test-clip metadata
// (compressed-video bytes hit an ASCII letter every ~5 bytes on average),
// and the module's reject-on-write policy prefers a false reject over
// silently truncated detector state. The decision is per-boundary and
// O(1) once the scan stops; no unbounded buffering ever occurs.
// The carry is FLOORED at the old 2 KiB overlap: the floor covers UTF-16
// straddles generally and short mixed fragments whose letters stop the
// content-aware scan early. UTF-16 parity: prepending an ODD-length carry
// flips the UTF-16 byte alignment of the concatenated text relative to
// the raw chunk, which is safe because BOTH UTF-16LE byte offsets are
// always decoded and scanned — a straddling UTF-16 string lands on the
// correct alignment in one of the two views whatever the carry length.
// The carried region is rescanned once per boundary (<= 64 KiB per 1 MiB
// chunk — bounded, ~6% extra in the worst case, ~0.2% typical).
// RESIDUALS: (1) a LEGITIMATE letter-free byte run longer than 64 KiB
// straddling a chunk boundary — e.g. a large all-NUL free/padding region —
// now FALSE-REJECTS via the overflow rule (pinned in the spec): accepted
// fail-closed overbreadth, replacing the earlier silent-evasion residual
// where a chain stretched past the cap was truncated and MISSED;
// (2) exotic UTF-16 separators whose code-unit bytes coincide with ASCII
// letters (e.g. U+2041 = 0x41 0x20 LE) stop the backward scan early — the
// 2 KiB floor still covers those within its bound, and non-straddling
// occurrences always reject.
const PAYLOAD_SCAN_CHUNK_BYTES = 1024 * 1024;
const PAYLOAD_SCAN_OVERLAP_BYTES = 2048;
const PAYLOAD_SCAN_CARRY_MAX_BYTES = 64 * 1024;
const LABEL_CARRY_MAX_BYTES = 32;
// Printable ASCII runs of at least this length are treated as embedded
// text; shorter runs are overwhelmingly codec noise. The floor is FIVE, not
// eight: the shortest credential fragment the shared screen classifies is
// `cvv=1`/`pin=1` (5 chars) — a higher floor would discard `cvv=123` before
// containsCredentialValue ever saw it.
const MIN_PRINTABLE_RUN = 5;
const PRINTABLE_RUN = /[\x20-\x7e]{5,}/g;

/** ASCII A-Z / a-z — the only bytes that break a digit chain in every view. */
function isAsciiLetterByte(byte: number): boolean {
  return (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a);
}

/**
 * Label-capture extension class (see the parameter doc above): ASCII
 * letters carry a credential label whose letters stopped the chain scan;
 * 0x00 additionally carries the NUL interleave of a UTF-16 label.
 */
function isLabelCarryByte(byte: number): boolean {
  return byte === 0x00 || isAsciiLetterByte(byte);
}

interface BoundaryCarry {
  /** Bytes immediately BEFORE `boundary` to prepend to the next chunk. */
  readonly carried: number;
  /**
   * The backward chain scan hit the 64 KiB cap with the chain-relevant run
   * still open — the carry is truncated and the caller must FAIL CLOSED.
   */
  readonly truncated: boolean;
}

/**
 * Content-aware boundary carry (see the parameter doc above). The carry is
 * computed on RAW BYTES, before any decoding, so one decision serves the
 * latin1 view and both UTF-16LE byte offsets alike: the chain-relevant
 * class (every non-letter byte) is a superset of digit/separator bytes in
 * every view, and the truncation verdict is view-independent.
 *
 * Three phases:
 *   1. backward chain scan while bytes are chain-relevant (not an ASCII
 *      letter), capped at PAYLOAD_SCAN_CARRY_MAX_BYTES;
 *   2. TRUNCATION check — cap hit with the run still open means bounded
 *      state cannot prove safety: report `truncated` so the caller rejects
 *      (fail closed) instead of scanning with silently dropped context;
 *   3. LABEL CAPTURE — the scan stopped at a letter, so additionally carry
 *      the contiguous letter-or-NUL run before it (cap 32 bytes): a
 *      credential label directly preceding the carried whitespace travels
 *      with it, in both plain-ASCII and NUL-interleaved UTF-16 forms.
 * The result is floored at the old 2 KiB overlap and never reaches past
 * the start of the buffer.
 */
function boundaryCarry(buffer: Buffer, boundary: number): BoundaryCarry {
  let chain = 0;
  while (
    chain < PAYLOAD_SCAN_CARRY_MAX_BYTES &&
    chain < boundary &&
    !isAsciiLetterByte(buffer[boundary - 1 - chain])
  ) {
    chain += 1;
  }
  if (
    chain === PAYLOAD_SCAN_CARRY_MAX_BYTES &&
    chain < boundary &&
    !isAsciiLetterByte(buffer[boundary - 1 - chain])
  ) {
    return { carried: chain, truncated: true };
  }
  let label = 0;
  while (
    label < LABEL_CARRY_MAX_BYTES &&
    chain + label < boundary &&
    isLabelCarryByte(buffer[boundary - 1 - chain - label])
  ) {
    label += 1;
  }
  return {
    carried: Math.min(
      boundary,
      Math.max(chain + label, PAYLOAD_SCAN_OVERLAP_BYTES),
    ),
    truncated: false,
  };
}

/**
 * Payload-level sensitive-text screen: container METADATA (title/comment
 * atoms, subtitle tracks, XMP/ID3 text) is plain bytes inside the upload,
 * so a PAN or credential embedded there would otherwise reach durable
 * storage having passed every filename/magic check. Printable ASCII/UTF-8
 * runs are extracted chunk-by-chunk (bounded memory, content-aware boundary
 * carry) and screened with the shared credential/PAN detectors — both raw
 * and with separators stripped, so grouped digits match too.
 *
 * PAN chains are ADDITIONALLY windowed over each FULL decoded view, not
 * only inside printable-ASCII runs: separators outside printable ASCII —
 * newlines/CR/tab, NUL interleave, and multi-byte UTF-8 separators such as
 * em dashes or NBSP (which appear in the latin1 view as a short run of
 * non-alphanumeric bytes between the digit groups) — would otherwise split
 * a grouped PAN into sub-5-char digit fragments the printable-run
 * extraction never surfaces (4111\n1111\n1111\n1111). GROUPED_PAN's
 * separator class is "anything that is not an ASCII alphanumeric", so at
 * the decoded-text level every such run, whatever bytes produced it, chains
 * digit groups exactly like a dash does — in every view.
 *
 * SPACED credential labels are ALSO screened over each full decoded view:
 * a label split from its value by a REAL line break in the raw bytes
 * ("cvv\n123", "password\nhunter2" inside a comment/subtitle atom) lands
 * in two separate printable runs, so the run-level screen alone would
 * never see the pair. Only the two spaced-label detectors run at full-view
 * level — fused labels, key=value fragments, and secret tokens are
 * contiguous printable tokens already covered by the run screen.
 * FALSE-POSITIVE SURFACE (assessed): a binary FP needs the exact letter
 * bytes of a label (case-insensitive 'cvv'/'pin'/... = (2/256)^3 per
 * position) followed by \s bytes (~14/256, incl. 0xA0→NBSP in latin1) and
 * a digit (10/256) — about 1e-9 per byte per 3-letter label, ~6e-9 across
 * all labels, i.e. roughly one expected hit per ~50-100 MiB of uniformly
 * random (compressed-video-entropy) bytes per view; the UTF-16 views are
 * far rarer (letters need interleaved 0x00 high bytes). For bounded,
 * controlled TEST clips that is well under one expected FP per upload —
 * accepted reject-on-write overbreadth, same policy as Luhn-valid
 * timestamps (a false reject means re-encode/strip metadata).
 *
 * Both single-byte text (ASCII/UTF-8/latin1) AND UTF-16 text are screened:
 * MP4 ilst data atoms (type 2) and ID3v2 frames (encoding 0x01) store text
 * as UTF-16, where every ASCII code unit pairs with a 0x00 byte — a latin1
 * decode alone would never see it. Each chunk is additionally decoded as
 * UTF-16LE at both byte offsets, which also covers UTF-16BE ASCII (its
 * code units read as LE at the shifted offset).
 *
 * CHUNK BOUNDARIES use the content-aware carry documented at the scan
 * parameters above: each chunk after the first is prepended with the
 * longest letter-free suffix of the preceding bytes plus a bounded label
 * capture (floor 2 KiB, chain cap 64 KiB, label cap 32 bytes), so a
 * separated PAN chain of any length up to 64 KiB straddling a 1 MiB
 * boundary — and a credential label separated from its value by up to
 * 64 KiB of whitespace — is decoded and scanned whole in the following
 * chunk. When the letter-free run before a boundary EXCEEDS the 64 KiB
 * cap, the carry cannot contain the whole potential chain and this
 * function FAILS CLOSED (returns true) instead of scanning with truncated
 * state — bounded streaming state, overflow → reject, never unbounded
 * buffering.
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
    const end = Math.min(buffer.length, offset + PAYLOAD_SCAN_CHUNK_BYTES);
    // Content-aware carry: prepend the longest letter-free suffix of the
    // bytes before this chunk plus the bounded label capture (floor 2 KiB,
    // chain cap 64 KiB) so a separated digit chain — or a spaced
    // credential label — straddling the boundary is seen whole. subarray
    // is a view: the carry costs no copy, only a bounded rescan.
    const boundary = offset === 0 ? null : boundaryCarry(buffer, offset);
    if (boundary !== null && boundary.truncated) {
      // FAIL CLOSED (see the carry doc): the letter-free run before this
      // boundary exceeds the 64 KiB carry cap, so the truncated carry can
      // no longer prove no digit chain straddles the boundary — the
      // dropped bytes may hold the chain's leading digits. Reject rather
      // than scan with silently lost detector state.
      return true;
    }
    const carry = boundary === null ? 0 : boundary.carried;
    const chunk = buffer.subarray(offset - carry, end);
    const views = [
      chunk.toString('latin1'),
      chunk.toString('utf16le'),
      chunk.subarray(1).toString('utf16le'),
    ];
    for (const text of views) {
      // Full-view PAN chain scan (see doc above): digit groups split by
      // NON-printable or non-ASCII separators never form printable runs,
      // so the grouped-PAN detector must see the whole decoded view.
      // Linear: the chain regex is unambiguous and each window join is
      // abandoned past 19 digits.
      if (carriesLikelyPan(text)) {
        return true;
      }
      // Full-view SPACED credential-label scan: a label split from its
      // value by a REAL line break in raw bytes ("cvv\n123",
      // "password\nhunter2") lands in TWO separate printable runs, so the
      // run-level screen below never sees the pair — the spaced-label
      // detectors must see the whole decoded view too. Only the two
      // spaced rules run here: the fused-label, key=value, and secret-token
      // shapes are single contiguous printable tokens and are already fully
      // covered by the printable-run screen, so re-running the whole
      // free-text predicate on binary views would only add FP surface.
      // Linear: both regexes are single-pass with disjoint char classes.
      if (
        SPACED_NUMERIC_CREDENTIAL_LABEL.test(text) ||
        carriesSpacedSecretLabel(text)
      ) {
        return true;
      }
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
