/**
 * Credential/payment-shaped KEY detection and credential-bearing VALUE
 * detection — the single source of truth shared by audit-snapshot redaction
 * (AuditLogService) and device-metadata validation (DevicesService).
 *
 * Key detection runs three checks, all on consistently normalized input
 * (snake_case, kebab-case, dots, spaces, and camelCase all match):
 * 1. Exact match on the lowercase-alphanumeric form (api_key → apikey).
 * 2. Suffix match, so qualified aliases like apiToken, paymentToken,
 *    clientSecret, creditCardNumber, payment_pan_number, and
 *    encrypted_pin_block are caught without enumerating every prefix.
 * 3. Standalone-token match for PAN/PIN: the key is split into words on
 *    separators AND camelCase boundaries, and a bare "pan"/"pin" word
 *    (customer_pan, devicePin) matches — while single words that merely
 *    contain the letters (panel, pinpoint, timespan, pushpin, pinned)
 *    never do.
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
  'primaryaccountnumber',
  'iban',
  // Magnetic stripe track data (AGENTS.md payments invariant).
  'track1',
  'track2',
  'track3',
  'trackdata',
  'magstripe',
  'magneticstripe',
]);

// A normalized key ENDING in any of these matches, whatever the prefix:
// apitoken, paymenttoken, appsecret, webhooksecret, bankaccountnumber,
// paymentpannumber, encryptedpinblock, devicecardpin, ...
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
];

// Words that are sensitive on their own once the key is split into tokens:
// customer_pan → [customer, pan] matches; panel → [panel] does not.
const SENSITIVE_TOKENS = new Set(['pan', 'pin', 'cvv', 'cvc', 'iban']);

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
 * must never be persisted or audited — the WHATWG URL parser reports
 * username/password for ANY scheme (http, https, rtsp, rtmp, mqtt, amqp,
 * redis, postgres/postgresql, mysql, mongodb, custom), and a regex backstop
 * catches scheme://user:pass@host forms the parser rejects, plus obvious
 * `password=`/`pwd=` key-value connection strings.
 */
const URL_CANDIDATE = /[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s"'<>]+/g;
const USERINFO_BACKSTOP = /[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/\s@]+:[^/\s@]*@/;
const CONNECTION_STRING_PASSWORD = /\b(?:password|pwd)\s*=\s*[^;\s]/i;

export function containsCredentialValue(text: string): boolean {
  for (const candidate of text.match(URL_CANDIDATE) ?? []) {
    try {
      const url = new URL(candidate);
      if (url.username !== '' || url.password !== '') {
        return true;
      }
    } catch {
      // Not WHATWG-parseable — the backstop below still applies.
    }
  }
  return (
    USERINFO_BACKSTOP.test(text) || CONNECTION_STRING_PASSWORD.test(text)
  );
}

/**
 * Recursively searches an arbitrary JSON-shaped value for a credential/
 * payment-shaped KEY or a credential-bearing string VALUE. Returns the
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
    return containsCredentialValue(value) ? path || '(value)' : null;
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
