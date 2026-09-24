import { StructuredLogger, LogRecord } from './structured-logger';
import {
  REDACTED,
  assertPersistable,
  containsCardNumber,
  redact,
  redactString,
} from './redaction';

// A Luhn-valid test number from the public test-card space. It is not a real
// account; it exists so the redactor can be proven to catch card shapes.
const TEST_PAN = '4242424242424242';

describe('redaction', () => {
  it('detects a card number and leaves other long digits alone', () => {
    expect(containsCardNumber(TEST_PAN)).toBe(true);
    expect(containsCardNumber('4242 4242 4242 4242')).toBe(true);
    expect(containsCardNumber('4242-4242-4242-4242')).toBe(true);
    expect(containsCardNumber('1111111111111111')).toBe(false);
    expect(containsCardNumber('sequence 20260916120000')).toBe(false);
  });

  it('recognises the other card networks at their real lengths', () => {
    // American Express (15), Mastercard (16), Discover (16) — Luhn-valid
    // numbers from the public test-card space.
    expect(containsCardNumber('378282246310005')).toBe(true);
    expect(containsCardNumber('5555555555554444')).toBe(true);
    expect(containsCardNumber('6011111111111117')).toBe(true);
  });

  it('never mistakes a barcode or a timestamp for a card', () => {
    // A guard that REFUSES to persist cannot afford false positives: retail
    // payloads are full of long digit runs, and about one in ten passes Luhn
    // by chance. These are exactly the shapes that used to trip it.
    const luhnValidTimestamps = Array.from(
      { length: 400 },
      (_, index) => `heartbeat:device-1:${1758000000000 + index}`,
    );
    expect(luhnValidTimestamps.some(containsCardNumber)).toBe(false);

    // EAN-13 barcodes, including ones that happen to satisfy Luhn.
    for (const barcode of [
      '4006381333931',
      '5901234123457',
      '9780201379624',
      '0012345678905',
    ]) {
      expect(containsCardNumber(`barcode ${barcode}`)).toBe(false);
    }
  });

  it('masks card numbers inside a sentence', () => {
    expect(redactString(`card ${TEST_PAN} used`)).toBe(`card ${REDACTED} used`);
  });

  it('masks absolute paths, UNC paths and file URIs', () => {
    expect(redactString(String.raw`read C:\media\clip.mp4`)).toContain(REDACTED);
    expect(redactString('read file:///var/media/clip.mp4')).toContain(REDACTED);
    expect(redactString(String.raw`read \\host\share\clip.mp4`)).toContain(
      REDACTED,
    );
    expect(redactString('read /var/lib/byond/media/clip.mp4')).toContain(
      REDACTED,
    );
  });

  it('masks inlined media bytes', () => {
    expect(redactString('data:image/png;base64,AAAABBBBCCCC')).toBe(REDACTED);
  });

  it('replaces secret-named and media-named keys wholesale', () => {
    const output = redact({
      token: 'super-secret-value',
      apiKey: 'another',
      storageKey: 'tenant/asset/clip.mp4',
      signedUrl: 'https://example.com/x?sig=abc',
      productId: 'SKU-1',
    }) as Record<string, unknown>;
    expect(output.token).toBe(REDACTED);
    expect(output.apiKey).toBe(REDACTED);
    expect(output.storageKey).toBe(REDACTED);
    expect(output.signedUrl).toBe(REDACTED);
    expect(output.productId).toBe('SKU-1');
  });

  it('walks arrays and nested objects, and survives a cycle', () => {
    const cyclic: Record<string, unknown> = { password: 'x' };
    cyclic.self = cyclic;
    const output = redact({ items: [cyclic] }) as { items: unknown[] };
    const first = output.items[0] as Record<string, unknown>;
    expect(first.password).toBe(REDACTED);
    expect(first.self).toBe('[circular]');
  });
});

describe('assertPersistable', () => {
  it('accepts ordinary domain payloads', () => {
    expect(() =>
      assertPersistable(
        { productId: 'SKU-1', quantity: 2, evidenceRef: 'proposal-9' },
        'test',
      ),
    ).not.toThrow();
  });

  it('refuses card data rather than masking it', () => {
    expect(() => assertPersistable({ note: TEST_PAN }, 'test')).toThrow(
      /payment card/,
    );
  });

  it('refuses a secret-named or media-named key', () => {
    expect(() => assertPersistable({ token: 'abc' }, 'test')).toThrow(/secret/);
    expect(() => assertPersistable({ storageKey: 'a/b' }, 'test')).toThrow(
      /media locator/,
    );
  });

  it('refuses raw bytes and inlined media', () => {
    expect(() =>
      assertPersistable({ blob: new Uint8Array([1, 2, 3]) }, 'test'),
    ).toThrow(/byte buffer/);
    expect(() =>
      assertPersistable({ image: 'data:image/png;base64,AAAA' }, 'test'),
    ).toThrow(/data URI/);
  });
});

describe('StructuredLogger', () => {
  it('redacts every emitted field, including error detail', () => {
    const logger = new StructuredLogger();
    const records: LogRecord[] = [];
    logger.setSink((record) => records.push(record));

    logger.detail(
      'warn',
      `failed for card ${TEST_PAN}`,
      { token: 'secret-token', path: String.raw`C:\media\clip.mp4` },
      'test',
    );
    logger.failure('boom', new TypeError('bad thing'), 'test');

    const serialised = JSON.stringify(records);
    expect(serialised).not.toContain(TEST_PAN);
    expect(serialised).not.toContain('secret-token');
    expect(serialised).not.toContain('clip.mp4');
    expect(records[1].detail).toEqual({ class: 'TypeError', message: 'bad thing' });
  });
});
