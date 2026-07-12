/**
 * Credential/payment-shaped key detection — the single source of truth shared
 * by audit-snapshot redaction (AuditLogService) and device-metadata
 * validation (DevicesService). Keys are reduced to lowercase alphanumerics
 * before comparison, so every separator style matches: api_key, access-token,
 * access:token, refresh/token, credit_card_number, "Card Number", secret.key.
 *
 * Detection is exact-match PLUS suffix-match, so qualified aliases like
 * apiToken, paymentToken, cardToken, clientSecret, creditCardNumber, and
 * primary_account_number are caught without enumerating every prefix.
 * Conservative over-matching of credential-shaped names is acceptable for
 * both call sites; suffixes are chosen so common harmless fields (timespan,
 * tokenized, description, ...) never match.
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
  // PAN/PIN variants stay exact-match: generic "pan"/"pin" suffixes would
  // catch harmless fields like timespan or pushpin. Common qualified
  // aliases (pan_number, panNumber, card_pin, pin_block, ...) are
  // enumerated explicitly instead.
  'pan',
  'panno',
  'pannumber',
  'cardpan',
  'primaryaccountnumber',
  'accountpan',
  'pin',
  'pinno',
  'pinnumber',
  'cardpin',
  'debitpin',
  'pinblock',
  'encryptedpin',
  'iban',
  // Magnetic stripe track data (AGENTS.md payments invariant).
  'track1',
  'track2',
  'track3',
  'trackdata',
  'magstripe',
  'magneticstripe',
]);

// A normalized key ENDING in any of these matches: apitoken, paymenttoken,
// cardtoken, appsecret, webhooksecret, bankaccountnumber, ...
const SENSITIVE_SUFFIXES = [
  'token',
  'secret',
  'password',
  'apikey',
  'cardnumber',
  'accountnumber',
];

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return (
    SENSITIVE_EXACT.has(normalized) ||
    SENSITIVE_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
  );
}

/**
 * Recursively searches an arbitrary JSON-shaped value for a credential/
 * payment-shaped key. Returns the dotted path of the FIRST offending key
 * ("config.auth.apiKey"), or null when the value is clean. Used to REJECT
 * persistence (not merely redact): sensitive material must never be stored
 * in free-form JSON columns like Device.metadata.
 */
export function findSensitiveKeyPath(
  value: unknown,
  path = '',
): string | null {
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
