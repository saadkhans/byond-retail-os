/**
 * Redaction for everything the edge runtime logs or persists.
 *
 * Three classes of content must never leave this process in readable form:
 * - Card data. SECURITY.md forbids PANs, CVVs and track data in databases,
 *   logs, caches, queues and error reports. The runtime never handles cards
 *   deliberately, so anything card-shaped is a bug — redact it rather than
 *   trust that it cannot arrive.
 * - Secrets. Tokens and credentials arrive through configuration; a stray
 *   object spread must not carry one into a log line.
 * - Filesystem paths and media locators. The media policy the cloud enforces
 *   on inference descriptors applies here too: references are opaque ids.
 */

export const REDACTED = '[redacted]';

const SECRET_KEY_PATTERN =
  /(pass(word|phrase)?|secret|token|credential|authorization|apikey|api[-_]?key|private[-_]?key|cvv|cvc|pan|cardnumber|card[-_]?number|track[12])/i;

const MEDIA_KEY_PATTERN =
  /(storagekey|storage[-_]?key|filepath|file[-_]?path|localpath|local[-_]?path|absolutepath|signedurl|signed[-_]?url|downloadurl|download[-_]?url)/i;

/** 13–19 digits, optionally separated by single spaces or hyphens. */
const CARD_CANDIDATE_PATTERN = /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g;

/** Absolute POSIX paths, Windows drive paths, UNC paths and file URIs. */
const PATH_PATTERN =
  /(?:file:\/\/\S+|[A-Za-z]:[\\/][^\s"']+|\\\\[^\s"']+|(?:^|\s)\/(?:[\w.-]+\/){2,}[\w.-]+)/g;

/** Data URIs and anything that looks like inlined media bytes. */
const DATA_URI_PATTERN = /data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi;

/**
 * Issuer prefixes and the lengths each network actually uses.
 *
 * Luhn alone is not enough to identify a card here. Retail payloads are full
 * of long digit runs — EAN-13 and GTIN-14 barcodes, millisecond timestamps —
 * and roughly one in ten of them passes Luhn by coincidence. A guard that
 * REFUSES to persist cannot afford that: it would drop legitimate facts at
 * random. Requiring a real issuer prefix at a real length keeps barcodes and
 * timestamps out while still catching every card a payment flow could leak.
 */
const CARD_NETWORKS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly lengths: readonly number[];
}> = [
  { pattern: /^4/, lengths: [16, 19] }, // Visa
  { pattern: /^(?:5[1-5]|2[2-7])/, lengths: [16] }, // Mastercard
  { pattern: /^3[47]/, lengths: [15] }, // American Express
  { pattern: /^(?:6011|65|64[4-9])/, lengths: [16, 19] }, // Discover
  { pattern: /^(?:30[0-5]|36|38)/, lengths: [14] }, // Diners Club
  { pattern: /^35(?:2[89]|[3-8])/, lengths: [16] }, // JCB
];

function isCardNumber(digits: string): boolean {
  const networkMatch = CARD_NETWORKS.some(
    (network) =>
      network.lengths.includes(digits.length) && network.pattern.test(digits),
  );
  return networkMatch && luhnValid(digits);
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let value = digits.charCodeAt(index) - 48;
    if (double) {
      value *= 2;
      if (value > 9) {
        value -= 9;
      }
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

/** True when the string contains a digit run that is a real card number. */
export function containsCardNumber(value: string): boolean {
  const matches = value.match(CARD_CANDIDATE_PATTERN);
  if (matches === null) {
    return false;
  }
  return matches.some((match) => isCardNumber(match.replace(/[ -]/g, '')));
}

export function redactString(value: string): string {
  let result = value.replace(DATA_URI_PATTERN, REDACTED);
  result = result.replace(CARD_CANDIDATE_PATTERN, (match) =>
    isCardNumber(match.replace(/[ -]/g, '')) ? REDACTED : match,
  );
  result = result.replace(PATH_PATTERN, (match) => {
    const leading = /^\s/.test(match) ? match[0] : '';
    return `${leading}${REDACTED}`;
  });
  return result;
}

/**
 * Deep-redacts a value for logging. Keys whose NAME marks them as secret or
 * as a media locator are replaced wholesale; remaining strings are scanned by
 * value. Cycles are broken rather than throwing — a logger must not be able
 * to take the runtime down.
 */
export function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') {
    return redactString(value);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (seen.has(value)) {
    return '[circular]';
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((entry) => redact(entry, seen));
  }
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_PATTERN.test(key) || MEDIA_KEY_PATTERN.test(key)) {
      output[key] = REDACTED;
      continue;
    }
    output[key] = redact(entry, seen);
  }
  return output;
}

/**
 * Guard for anything about to be PERSISTED (store records, log entries,
 * outbox payloads). Unlike logging, persistence must refuse rather than
 * silently mask: a caller trying to put card data or media bytes into the
 * local store has a defect that masking would hide.
 */
export function assertPersistable(value: unknown, where: string): void {
  const offence = findUnpersistable(value, new WeakSet<object>());
  if (offence !== null) {
    throw new Error(`${where} rejected: ${offence}`);
  }
}

function findUnpersistable(
  value: unknown,
  seen: WeakSet<object>,
): string | null {
  if (typeof value === 'string') {
    if (containsCardNumber(value)) {
      return 'value looks like a payment card number';
    }
    if (DATA_URI_PATTERN.test(value)) {
      DATA_URI_PATTERN.lastIndex = 0;
      return 'value embeds media bytes as a data URI';
    }
    DATA_URI_PATTERN.lastIndex = 0;
    return null;
  }
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    return 'value is a raw byte buffer';
  }
  if (value === null || typeof value !== 'object') {
    return null;
  }
  if (seen.has(value)) {
    return null;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      const offence = findUnpersistable(entry, seen);
      if (offence !== null) {
        return offence;
      }
    }
    return null;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      return `key "${key}" names a secret`;
    }
    if (MEDIA_KEY_PATTERN.test(key)) {
      return `key "${key}" names a media locator`;
    }
    const offence = findUnpersistable(entry, seen);
    if (offence !== null) {
      return offence;
    }
  }
  return null;
}
