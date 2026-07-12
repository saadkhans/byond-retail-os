import {
  containsCredentialValue,
  containsPaymentCardValue,
  containsSensitiveValue,
  findSensitiveKeyPath,
  isSensitiveKey,
} from './sensitive-keys';

describe('sensitive key detection', () => {
  it.each([
    'password',
    'apiKey',
    'api_key',
    'access-token',
    'clientSecret',
    'cardNumber',
    'credit_card_number',
    'cvv',
    'cvv2',
    'pin',
    'pan',
    'pan_number',
    'panNumber',
    'panNo',
    'card_pin',
    'cardPin',
    'pinBlock',
    'pin_number',
    'encryptedPin',
    'primary_account_number',
    'track2',
    'trackData',
    'magStripe',
    'Authorization',
    'privateKey',
    'webhookSecret',
    'bankAccountNumber',
    'paymentToken',
  ])('flags credential/payment-shaped key %s', (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each([
    // Suffix matching catches qualified aliases whatever the prefix...
    'payment_pan_number',
    'paymentPanNumber',
    'encrypted_pin_block',
    'encryptedPinBlock',
    'device_pan_number',
    'card_pin_block',
    'cardPinBlock',
    'account_pan',
    'accountPan',
    'paymentPan',
    'pin_block',
    'paymentPin',
    // ...and the token check catches bare pan/pin words behind any prefix.
    'customer_pan',
    'customerPan',
    'devicePin',
    'terminal.pan',
    'user pin',
  ])('flags prefixed/qualified PAN/PIN alias %s', (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each([
    // Qualified card-verification aliases in every separator style.
    'terminalCvv2',
    'terminal_cvv',
    'terminal-cvv2',
    'payment_cvv2',
    'paymentCvc',
    'readerCvc2',
    'card_verification_value',
    'cardVerificationValue',
    'card_verification_code',
    'cardSecurityCode',
    'cid',
    // Qualified magstripe/track-data aliases.
    'track1',
    'track2',
    'readerTrack2',
    'reader_track_1',
    'magstripeTrack2',
    'readerTrackData',
    'pos_track_data',
    'magneticStripeData',
    'magnetic_stripe_data',
    'readerMagstripeData',
    'deviceMagneticStripe',
    // CVN/CSC synonyms and spelled-out verification numbers.
    'cvn',
    'csc',
    'cardCvn',
    'terminalCsc',
    'payment_cvn',
    'cardVerificationNumber',
    'card_verification_number',
    // EMV Track 2 Equivalent Data in every separator style.
    'track_2_equivalent_data',
    'track2EquivalentData',
    'track2equivalentdata',
    'track 1 equivalent data',
    // Cloud/API access-key identifiers.
    'accessKeyId',
    'access_key_id',
    'secretAccessKey',
    'sharedAccessKey',
    'storageAccountKey',
  ])('flags qualified CVV/track-data alias %s', (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each([
    'name',
    'mountPosition',
    'streamUrl',
    'timespan',
    'tokenized',
    'description',
    'panelCount',
    'firmwareChannel',
    'pinnedVersion',
    'pushpin',
    'spanWidth',
    // Words that merely CONTAIN pan/pin never match: token boundaries are
    // separators and camelCase humps, not substrings.
    'panel',
    'pinpoint',
    'expansion',
    'spinning',
    'companyName',
    // Near-misses of the CVV/track aliases must stay harmless: bare
    // 'track' is not a token, Stripe-the-vendor keys are not stripe data,
    // and correlation-id 'cid' qualifiers are only exact-match sensitive.
    'trackingNumber',
    'trackingData',
    'audioTrack',
    'audio_track',
    'stripeCustomerId',
    'requestCid',
    'lucidMode',
    // Near-misses of the new CVN/CSC/access-key aliases stay harmless:
    // bare 'key' is never sensitive, and cvn/csc match only as whole
    // words/suffixes.
    'monkey',
    'turkey',
    'key',
    'keyboardLayout',
    'sortKey',
    'cascade',
    'canvasColor',
  ])('accepts harmless key %s', (key) => {
    expect(isSensitiveKey(key)).toBe(false);
  });
});

describe('containsCredentialValue', () => {
  it.each([
    'rtsp://user:password@camera.local/feed',
    'http://admin:secret@device.local',
    'https://user:pass@example.com',
    'rtmp://user:pass@stream.local',
    'mqtt://user:pass@broker.local:1883',
    'amqp://guest:guest@rabbit.local',
    'redis://:hunter2@cache.local:6379',
    'postgres://sa:pw@db.local:5432/app',
    'postgresql://sa:pw@db.local/app',
    'mysql://root:root@db.local/app',
    'mongodb://user:pw@mongo.local/app',
    'mongodb+srv://user:pw@cluster.mongodb.net/app',
    // Username-only userinfo is still a credential shape.
    'ftp://deploy@files.local/path',
    // Embedded mid-sentence.
    'primary feed at rtsp://user:pw@cam-1.local/live, fallback disabled',
    // Key-value connection strings.
    'Server=db.local;Database=app;User Id=sa;Password=hunter2;',
    'host=db.local pwd=hunter2',
    // URLs carrying credential query parameters (no userinfo needed).
    'https://camera.local/feed?access_token=abc',
    'https://camera.local/feed?api_key=abc',
    'rtsp://camera.local/feed?token=abc',
    'mqtt://broker.local?password=abc',
    'https://example.com?signature=abc',
    'https://example.com?client_secret=abc',
    'https://example.com/path?token=none#frag',
    'https://cdn.example.com/asset.jpg?sig=xyz&expires=12',
    'https://api.example.com/v1?key=abc123',
    // Bare key=value credential fragments outside a parseable URL.
    'token=abc123',
    'endpoint at broker.local, auth=basic secret=hunter2',
    // Provider-namespaced signed-URL credentials.
    'https://bucket.s3.amazonaws.com/backup.tar?X-Amz-Signature=abc123',
    'https://bucket.s3.amazonaws.com/f?X-Amz-Credential=AKIA%2F20260712',
    'https://storage.googleapis.com/f.jpg?X-Goog-Signature=abc123',
    // Payment-shaped key=value fragments.
    'cvv=123',
    'CVC=999',
    'cvn=12',
    'csc=321',
    'pin=1234',
    'pan=4111111111111111',
    'terminal config: cvv2=456',
  ])('flags credential-bearing value %s', (value) => {
    expect(containsCredentialValue(value)).toBe(true);
  });

  it.each([
    'rtsp://camera.local/feed',
    'rtsp://camera.local/feed?channel=1&fps=25',
    'https://example.com/path?page=2&sort=asc#frag',
    'https://example.com/docs?version=1.4.2',
    'mqtt://broker.local:1883',
    'postgres://db.local:5432/app',
    'plain text mentioning admin@store.example without a scheme',
    'front entrance, aisle 3',
    '1.4.2',
    // Innocent substrings never trip the key=value backstop.
    'monkey=banana',
    'oauth flow disabled',
    'spin=fast',
    'timespan=90',
    'expand=all',
    'https://example.com/f?x-request-id=5&region=eu',
  ])('accepts safe value %s', (value) => {
    expect(containsCredentialValue(value)).toBe(false);
  });
});

describe('containsPaymentCardValue', () => {
  it.each([
    // Common test PANs are Luhn-valid and rejected like live ones.
    '4111111111111111',
    '4111 1111 1111 1111',
    '4111-1111-1111-1111',
    '4242424242424242',
    '378282246310005', // Amex, 15 digits
    '6011111111111117', // Discover
    '4222222222222', // 13-digit Visa test PAN
    'card on file: 4111 1111 1111 1111 (do not share)',
  ])('flags PAN-shaped value %s', (value) => {
    expect(containsPaymentCardValue(value)).toBe(true);
    expect(containsSensitiveValue(value)).toBe(true);
  });

  it.each([
    // Luhn-invalid digit runs: serials, order numbers, phone-ish strings.
    '4111111111111112',
    '1234567890123',
    'order 1234567890123 confirmed',
    'SN-4111-1111-1111-1112',
    // Too short / too long to be a PAN.
    '411111111111', // 12 digits
    '12345678901234567890', // 20 digits
    '1234 5678',
    'firmware 1.4.2 build 20260712',
  ])('accepts non-PAN value %s', (value) => {
    expect(containsPaymentCardValue(value)).toBe(false);
  });
});

describe('findSensitiveKeyPath', () => {
  it('returns null for safe nested metadata', () => {
    expect(
      findSensitiveKeyPath({
        mountPosition: 'front',
        stream: { url: 'rtsp://cam.local/feed', fps: 25 },
        zones: [{ name: 'entry', threshold: 0.4 }],
      }),
    ).toBeNull();
  });

  it('finds a sensitive key nested in objects', () => {
    expect(
      findSensitiveKeyPath({ config: { auth: { apiKey: 'x' } } }),
    ).toBe('config.auth.apiKey');
  });

  it('finds a sensitive key nested inside arrays', () => {
    expect(
      findSensitiveKeyPath({ endpoints: [{ url: 'a' }, { token: 'x' }] }),
    ).toBe('endpoints[1].token');
  });

  it('finds payment-shaped keys regardless of separator style', () => {
    expect(findSensitiveKeyPath({ 'Card Number': '4111...' })).toBe(
      'Card Number',
    );
    expect(findSensitiveKeyPath({ payment: { track_2: 'raw' } })).toBe(
      'payment.track_2',
    );
    expect(
      findSensitiveKeyPath({ terminal: { payment_pan_number: '4111' } }),
    ).toBe('terminal.payment_pan_number');
  });

  it('flags the KEY even when the value is harmless', () => {
    expect(findSensitiveKeyPath({ cvv: null })).toBe('cvv');
  });

  it('finds credential-bearing VALUES under harmless keys', () => {
    expect(
      findSensitiveKeyPath({
        stream: { url: 'rtsp://user:pw@cam.local/feed' },
      }),
    ).toBe('stream.url');
    expect(
      findSensitiveKeyPath({
        endpoints: ['rtsp://cam.local/ok', 'http://admin:secret@dev.local'],
      }),
    ).toBe('endpoints[1]');
  });

  it('finds URL query secrets under harmless keys', () => {
    expect(
      findSensitiveKeyPath({
        streamUrl: 'https://camera.local/feed?access_token=abc',
      }),
    ).toBe('streamUrl');
    expect(
      findSensitiveKeyPath({
        feeds: ['rtsp://cam.local/ok', 'rtsp://cam.local/feed?token=abc'],
      }),
    ).toBe('feeds[1]');
  });

  it('finds raw PAN values under harmless keys, nested and separated', () => {
    expect(findSensitiveKeyPath({ notes: '4111111111111111' })).toBe('notes');
    expect(findSensitiveKeyPath({ notes: '4111 1111 1111 1111' })).toBe(
      'notes',
    );
    expect(findSensitiveKeyPath({ notes: '4111-1111-1111-1111' })).toBe(
      'notes',
    );
    expect(
      findSensitiveKeyPath({
        device: { diagnostics: ['ok', { lastError: 'card 4242424242424242' }] },
      }),
    ).toBe('device.diagnostics[1].lastError');
  });

  it('accepts harmless serial/order numbers that are not Luhn-valid', () => {
    expect(
      findSensitiveKeyPath({
        serialNumber: 'SN-4111-1111-1111-1112',
        orderRef: 'order 1234567890123 confirmed',
        assetTag: '12345678901234567890',
      }),
    ).toBeNull();
  });

  it('finds PANs submitted as JSON numbers', () => {
    expect(findSensitiveKeyPath({ notes: 4111111111111111 })).toBe('notes');
    expect(
      findSensitiveKeyPath({ device: { cards: [4242424242424242] } }),
    ).toBe('device.cards[0]');
  });

  it('accepts harmless numbers (non-Luhn, short, or fractional)', () => {
    expect(
      findSensitiveKeyPath({
        port: 8080,
        threshold: 0.4,
        serial: 1234567890123, // 13 digits, fails Luhn
        epochMs: 1752307200000,
        negativeOffset: -42,
      }),
    ).toBeNull();
  });
});
