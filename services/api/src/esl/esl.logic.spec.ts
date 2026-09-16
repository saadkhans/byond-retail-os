import {
  ESL_UPDATE_BACKOFF_BASE_SECONDS,
  ESL_UPDATE_MAX_ATTEMPTS,
} from './esl.constants';
import {
  activationIdempotencyKey,
  alreadyRendered,
  attemptsExhausted,
  clampPercent,
  contentHash,
  manualIdempotencyKey,
  nextAttemptAt,
  normalizeGatewayCode,
  normalizeVendorCode,
  reconciliationIdempotencyKey,
} from './esl.logic';
import { EslLabelContent } from './ports';

const content = (over: Partial<EslLabelContent> = {}): EslLabelContent => ({
  sku: 'WATER-500',
  productName: 'Drinking Water 500ml',
  unitPriceMinor: 250,
  currencyCode: 'AED',
  ...over,
});

describe('ESL content hashing', () => {
  it('is stable for the same content', () => {
    expect(contentHash(content())).toBe(contentHash(content()));
  });

  it('changes when the price changes', () => {
    expect(contentHash(content({ unitPriceMinor: 300 }))).not.toBe(
      contentHash(content()),
    );
  });

  it('changes when the currency changes', () => {
    expect(contentHash(content({ currencyCode: 'USD' }))).not.toBe(
      contentHash(content()),
    );
  });

  it('changes when the product name changes', () => {
    // The label prints the name as well as the price, so a rename must
    // re-render even though the money did not move.
    expect(contentHash(content({ productName: 'Water 500ml' }))).not.toBe(
      contentHash(content()),
    );
  });

  it('does not embed the price in the hash', () => {
    // The hash is persisted on the label row; it must not leak the content
    // it fingerprints.
    expect(contentHash(content())).not.toContain('250');
    expect(contentHash(content())).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('ESL idempotency keys', () => {
  it('makes a replayed activation the same key', () => {
    expect(activationIdempotencyKey('v1', 'label-1')).toBe(
      activationIdempotencyKey('v1', 'label-1'),
    );
  });

  it('separates versions and labels', () => {
    expect(activationIdempotencyKey('v1', 'label-1')).not.toBe(
      activationIdempotencyKey('v2', 'label-1'),
    );
    expect(activationIdempotencyKey('v1', 'label-1')).not.toBe(
      activationIdempotencyKey('v1', 'label-2'),
    );
  });

  it('keys reconciliation by the drift it saw', () => {
    // Two sweeps that see the same divergence must not queue it twice; a new
    // divergence must get its own job.
    expect(reconciliationIdempotencyKey('label-1', 'aaa')).toBe(
      reconciliationIdempotencyKey('label-1', 'aaa'),
    );
    expect(reconciliationIdempotencyKey('label-1', 'aaa')).not.toBe(
      reconciliationIdempotencyKey('label-1', 'bbb'),
    );
  });

  it('never de-duplicates an operator request', () => {
    expect(manualIdempotencyKey('label-1', 'one')).not.toBe(
      manualIdempotencyKey('label-1', 'two'),
    );
  });

  it('keeps the three namespaces apart', () => {
    const keys = [
      activationIdempotencyKey('v1', 'label-1'),
      reconciliationIdempotencyKey('label-1', 'v1'),
      manualIdempotencyKey('label-1', 'v1'),
    ];
    expect(new Set(keys).size).toBe(3);
  });
});

describe('ESL retry backoff', () => {
  const now = new Date('2026-09-16T10:00:00.000Z');

  it('waits the base interval after the first failure', () => {
    expect(nextAttemptAt(1, now).getTime() - now.getTime()).toBe(
      ESL_UPDATE_BACKOFF_BASE_SECONDS * 1000,
    );
  });

  it('doubles with each attempt', () => {
    const first = nextAttemptAt(1, now).getTime() - now.getTime();
    const second = nextAttemptAt(2, now).getTime() - now.getTime();
    const third = nextAttemptAt(3, now).getTime() - now.getTime();
    expect(second).toBe(first * 2);
    expect(third).toBe(first * 4);
  });

  it('never returns a time in the past', () => {
    expect(nextAttemptAt(0, now).getTime()).toBeGreaterThanOrEqual(
      now.getTime(),
    );
  });

  it('stops retrying once the budget is spent', () => {
    expect(attemptsExhausted(ESL_UPDATE_MAX_ATTEMPTS - 1)).toBe(false);
    expect(attemptsExhausted(ESL_UPDATE_MAX_ATTEMPTS)).toBe(true);
    expect(attemptsExhausted(ESL_UPDATE_MAX_ATTEMPTS + 1)).toBe(true);
  });
});

describe('ESL rendered-state comparison', () => {
  it('treats a label that has never rendered as out of date', () => {
    expect(alreadyRendered(null, 'abc')).toBe(false);
  });

  it('treats a matching hash as already correct', () => {
    expect(alreadyRendered('abc', 'abc')).toBe(true);
  });

  it('treats a different hash as out of date', () => {
    expect(alreadyRendered('abc', 'abd')).toBe(false);
  });
});

describe('ESL normalisation and clamping', () => {
  it('uppercases codes', () => {
    expect(normalizeGatewayCode(' store-01 ')).toBe('STORE-01');
    expect(normalizeVendorCode(' simulated ')).toBe('SIMULATED');
  });

  it('clamps vendor health into the range the CHECK constraints allow', () => {
    expect(clampPercent(150)).toBe(100);
    expect(clampPercent(-4)).toBe(0);
    expect(clampPercent(61.6)).toBe(62);
  });

  it('treats an absent or non-finite reading as unknown, not zero', () => {
    // Reporting a missing battery as 0 % would send an engineer to a healthy
    // label.
    expect(clampPercent(undefined)).toBeNull();
    expect(clampPercent(Number.NaN)).toBeNull();
    expect(clampPercent(Number.POSITIVE_INFINITY)).toBeNull();
  });
});
