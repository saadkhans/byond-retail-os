import {
  containsCredentialValue,
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
  ])('flags credential-bearing value %s', (value) => {
    expect(containsCredentialValue(value)).toBe(true);
  });

  it.each([
    'rtsp://camera.local/feed',
    'https://example.com/path?token=none#frag',
    'mqtt://broker.local:1883',
    'postgres://db.local:5432/app',
    'plain text mentioning admin@store.example without a scheme',
    'front entrance, aisle 3',
    '1.4.2',
  ])('accepts safe value %s', (value) => {
    expect(containsCredentialValue(value)).toBe(false);
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
});
