/**
 * Credential/payment-shaped KEY detection and credential/payment-bearing
 * VALUE detection — the single source of truth shared by audit-snapshot
 * redaction (AuditLogService) and device-metadata validation
 * (DevicesService).
 *
 * Key detection runs three checks, all on consistently normalized input
 * (snake_case, kebab-case, dots, spaces, and camelCase all match):
 * 1. Exact match on the lowercase-alphanumeric form (api_key → apikey).
 * 2. Suffix match, so qualified aliases like apiToken, paymentToken,
 *    clientSecret, creditCardNumber, payment_pan_number, terminalCvv2,
 *    readerTrack2, and encrypted_pin_block are caught without enumerating
 *    every prefix.
 * 3. Standalone-token match for short card words (pan, pin, cvv, cvv2,
 *    cvc, cvc2, iban): the key is split into words on separators AND
 *    camelCase boundaries, and a bare "pan"/"cvv2" word (customer_pan,
 *    paymentCvv2) matches — while single words that merely contain the
 *    letters (panel, pinpoint, timespan, pushpin, pinned) never do.
 *
 * Value detection covers three shapes that must never be persisted or
 * audited even under a harmless key:
 * 1. URLs/connection strings with userinfo (rtsp://user:pass@cam.local).
 * 2. URLs whose query string carries a credential parameter
 *    (?access_token=..., ?api_key=..., ?signature=...), plus bare
 *    key=value credential fragments outside parseable URLs.
 * 3. Payment-card numbers (PANs): 13–19 digit runs, optionally space/dash
 *    separated, that pass the Luhn check — which includes all common test
 *    PANs (4111 1111 1111 1111, 4242..., 3782 822463 10005, ...).
 *
 * Conservative over-matching of credential-shaped names is acceptable for
 * both call sites.
 */
const SENSITIVE_EXACT = new Set([
  'password',
  'passwordhash',
  'secret',
  'secretkey',
  'clientsecret',
  'privatekey',
  'token',
  'accesstoken',
  'refreshtoken',
  'sessiontoken',
  'idtoken',
  'bearer',
  'bearertoken',
  'apikey',
  'authorization',
  'cardnumber',
  'creditcard',
  'creditcardnumber',
  'cvv',
  'cvv2',
  'cvc',
  'cvc2',
  // Amex card identification number; exact-only — as a suffix or token it
  // would swallow correlation-id style "cid" qualifiers.
  'cid',
  'cardverificationvalue',
  'cardverificationcode',
  'cardsecuritycode',
  'primaryaccountnumber',
  'iban',
  // Magnetic stripe track data (AGENTS.md payments invariant).
  'track1',
  'track2',
  'track3',
  'trackdata',
  'magstripe',
  'magstripedata',
  'magneticstripe',
  'magneticstripedata',
]);

// A normalized key ENDING in any of these matches, whatever the prefix:
// apitoken, paymenttoken, appsecret, webhooksecret, bankaccountnumber,
// paymentpannumber, encryptedpinblock, devicecardpin, terminalcvv2,
// readertrack2, magstripetrack2, readermagneticstripedata, ...
// Bare 'pan'/'pin' are handled by the token check instead — as suffixes they
// would swallow harmless words like timespan or pushpin.
const SENSITIVE_SUFFIXES = [
  'token',
  'secret',
  'password',
  'apikey',
  'cardnumber',
  'accountnumber',
  'pannumber',
  'panno',
  'cardpan',
  'accountpan',
  'paymentpan',
  'pinnumber',
  'pinno',
  'pinblock',
  'cardpin',
  'paymentpin',
  'debitpin',
  'encryptedpin',
  // Card verification values/codes: terminalCvv2, payment_cvv, cardCvc, ...
  'cvv',
  'cvv2',
  'cvc',
  'cvc2',
  'verificationvalue',
  'verificationcode',
  'securitycode',
  // Magnetic stripe track data: readerTrack2, magstripeTrack1,
  // readerTrackData, magneticStripeData, posMagstripeData, ...
  'track1',
  'track2',
  'track3',
  'trackdata',
  'magstripe',
  'magstripedata',
  'magneticstripe',
  'magneticstripedata',
];

// Words that are sensitive on their own once the key is split into tokens:
// customer_pan → [customer, pan] matches; panel → [panel] does not.
// terminalCvv2 → [terminal, cvv2]; readerTrack2 → [reader, track2]. Bare
// 'track' is NOT a token — audio_track/tracking_number must stay harmless.
const SENSITIVE_TOKENS = new Set([
  'pan',
  'pin',
  'cvv',
  'cvv2',
  'cvc',
  'cvc2',
  'iban',
  'track1',
  'track2',
  'track3',
  'magstripe',
]);

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Splits on separators AND camelCase boundaries: paymentPanNumber → [payment, pan, number]. */
function tokenizeKey(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .filter((token) => token.length > 0)
    .map((token) => token.toLowerCase());
}

export function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return (
    SENSITIVE_EXACT.has(normalized) ||
    SENSITIVE_SUFFIXES.some((suffix) => normalized.endsWith(suffix)) ||
    tokenizeKey(key).some((token) => SENSITIVE_TOKENS.has(token))
  );
}

/**
 * Credential-bearing VALUE detection: URLs/connection strings that embed
 * userinfo (rtsp://user:pass@camera.local/feed, postgres://sa:pw@db, ...)
 * or carry credential query parameters (?access_token=..., ?api_key=...)
 * must never be persisted or audited. The WHATWG URL parser reports
 * username/password/searchParams for ANY scheme (http, https, rtsp, rtmp,
 * mqtt, amqp, redis, postgres/postgresql, mysql, mongodb, custom); regex
 * backstops catch scheme://user:pass@host forms the parser rejects and
 * bare key=value credential fragments (password=x, token=y, sig=z) that
 * are not part of a parseable URL at all.
 */
const URL_CANDIDATE = /[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s"'<>]+/g;
const USERINFO_BACKSTOP = /[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/\s@]+:[^/\s@]*@/;
// key=value credential fragments, valid-URL or not. The leading boundary
// keeps innocent substrings out: "monkey=1" and "oauth=..." never match
// because 'key'/'auth' are preceded by a word character.
const KEY_VALUE_CREDENTIAL =
  /(?:^|[?&;#,\s])(?:access[-_ ]?token|refresh[-_ ]?token|session[-_ ]?token|id[-_ ]?token|api[-_ ]?key|client[-_ ]?secret|token|secret|password|passwd|pwd|signature|sig|auth|authorization|bearer|key)\s*=\s*[^;&\s]/i;

// Credential query-parameter names checked on parsed URLs, on top of the
// shared key detection (which already flags *token, *secret, *apikey,
// password, authorization, bearer, ...). Bare 'key'/'sig'/'auth' are only
// sensitive as PARAMETER names — as metadata keys they stay harmless.
const SENSITIVE_PARAM_EXTRA = new Set([
  'key',
  'pwd',
  'passwd',
  'sig',
  'signature',
  'auth',
]);

function isSensitiveParamName(name: string): boolean {
  return SENSITIVE_PARAM_EXTRA.has(normalizeKey(name)) || isSensitiveKey(name);
}

export function containsCredentialValue(text: string): boolean {
  for (const candidate of text.match(URL_CANDIDATE) ?? []) {
    try {
      const url = new URL(candidate);
      if (url.username !== '' || url.password !== '') {
        return true;
      }
      for (const name of url.searchParams.keys()) {
        if (isSensitiveParamName(name)) {
          return true;
        }
      }
    } catch {
      // Not WHATWG-parseable — the backstops below still apply.
    }
  }
  return USERINFO_BACKSTOP.test(text) || KEY_VALUE_CREDENTIAL.test(text);
}

/**
 * Payment-card (PAN) VALUE detection: digit runs of 13–19 digits, allowing
 * space/dash grouping (4111 1111 1111 1111, 4111-1111-1111-1111), validated
 * with the Luhn checksum so ordinary serial/order numbers and version
 * strings pass through. Test PANs are Luhn-valid by design, so they are
 * rejected exactly like live ones (AGENTS.md payments invariant).
 */
const PAN_CANDIDATE = /\d(?:[ -]?\d){11,}/g;

function passesLuhn(digits: string): boolean {
  let sum = 0;
  for (let index = 0; index < digits.length; index += 1) {
    let digit = digits.charCodeAt(digits.length - 1 - index) - 48;
    if (index % 2 === 1) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

export function containsPaymentCardValue(text: string): boolean {
  for (const candidate of text.match(PAN_CANDIDATE) ?? []) {
    const digits = candidate.replace(/[ -]/g, '');
    if (digits.length >= 13 && digits.length <= 19 && passesLuhn(digits)) {
      return true;
    }
  }
  return false;
}

/** Combined VALUE check: credential-bearing strings OR raw card numbers. */
export function containsSensitiveValue(text: string): boolean {
  return containsCredentialValue(text) || containsPaymentCardValue(text);
}

/**
 * Recursively searches an arbitrary JSON-shaped value for a credential/
 * payment-shaped KEY or a credential/PAN-bearing string VALUE. Returns the
 * dotted path of the FIRST offense ("config.auth.apiKey",
 * "stream.url"), or null when the value is clean. Used to REJECT
 * persistence (not merely redact): sensitive material must never be stored
 * in free-form JSON columns like Device.metadata.
 */
export function findSensitiveKeyPath(
  value: unknown,
  path = '',
): string | null {
  if (typeof value === 'string') {
    return containsSensitiveValue(value) ? path || '(value)' : null;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findSensitiveKeyPath(value[index], `${path}[${index}]`);
      if (found) {
        return found;
      }
    }
    return null;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      const keyPath = path ? `${path}.${key}` : key;
      if (isSensitiveKey(key)) {
        return keyPath;
      }
      const found = findSensitiveKeyPath(nested, keyPath);
      if (found) {
        return found;
      }
    }
  }
  return null;
}
