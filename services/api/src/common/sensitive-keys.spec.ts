import { findSensitiveKeyPath, isSensitiveKey } from './sensitive-keys';

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
  ])('accepts harmless key %s', (key) => {
    expect(isSensitiveKey(key)).toBe(false);
  });
});

describe('findSensitiveKeyPath', () => {
  it('returns null for safe nested metadata', () => {
    expect(
      findSensitiveKeyPath({
        mountPosition: 'front',
        stream: { url: 'rtsp://cam.local', fps: 25 },
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
  });

  it('flags the KEY even when the value is harmless', () => {
    expect(findSensitiveKeyPath({ cvv: null })).toBe('cvv');
  });
});
