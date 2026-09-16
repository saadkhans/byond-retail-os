import { describe, expect, it } from 'vitest';
import type { LoyaltyPointMovement, PriceQuote, PromotionVersion } from './api';
import {
  activeVersion,
  balanceFromLedger,
  describeRule,
  describeRuleScope,
  explainQuote,
  formatMoney,
  formatPoints,
  latestDraft,
  movementIdempotencyKey,
  quoteIsExplainable,
} from './loyalty-utils';

function version(over: Partial<PromotionVersion>): PromotionVersion {
  return {
    id: 'pver-1',
    promotionId: 'promo-1',
    versionNumber: 1,
    status: 'DRAFT',
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    effectiveTo: null,
    reason: 'RULE_CHANGE',
    note: null,
    activatedAt: null,
    supersededByVersionId: null,
    rolledBackFromVersionId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function movement(
  sequenceNumber: number,
  balanceAfter: number,
): LoyaltyPointMovement {
  return {
    id: `mov-${sequenceNumber}`,
    accountId: 'acc-1',
    sequenceNumber,
    type: 'ACCRUAL',
    points: 10,
    balanceAfter,
    reasonCode: 'PURCHASE',
    note: null,
    orderId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

const QUOTE: PriceQuote = {
  productId: 'prod-1',
  currencyCode: 'AED',
  basePriceMinor: 1000,
  priceBookId: 'book-1',
  priceBookVersionId: 'ver-7',
  promotion: {
    promotionId: 'promo-1',
    promotionVersionId: 'pver-3',
    ruleId: 'rule-1',
    kind: 'AMOUNT_OFF',
    discountMinor: 150,
    finalUnitPriceMinor: 850,
  },
  unitPriceMinor: 850,
};

describe('money and points formatting', () => {
  it('renders minor units as a readable amount', () => {
    expect(formatMoney(1099, 'AED')).toBe('10.99 AED');
    expect(formatMoney(0, 'AED')).toBe('0.00 AED');
  });

  it('renders an unpriced value as a dash, never as zero', () => {
    expect(formatMoney(null, 'AED')).toBe('—');
    expect(formatMoney(1000, null)).toBe('—');
    expect(formatMoney(undefined, undefined)).toBe('—');
  });

  it('always signs points so a redemption reads as a redemption', () => {
    expect(formatPoints(40)).toBe('+40');
    expect(formatPoints(-40)).toBe('-40');
  });
});

describe('explaining a quote', () => {
  it('names the price version AND the promotion version behind the price', () => {
    const sentence = explainQuote(QUOTE);
    expect(sentence).toContain('ver-7');
    expect(sentence).toContain('pver-3');
    expect(sentence).toContain('10.00 AED');
    expect(sentence).toContain('1.50 AED');
    expect(sentence).toContain('8.50 AED');
  });

  it('still names the price version when no promotion applies', () => {
    const sentence = explainQuote({
      ...QUOTE,
      promotion: null,
      unitPriceMinor: 1000,
    });
    expect(sentence).toContain('ver-7');
    expect(sentence).toContain('No promotion applies');
  });

  it('accepts a quote whose arithmetic holds', () => {
    expect(quoteIsExplainable(QUOTE)).toBe(true);
    expect(
      quoteIsExplainable({ ...QUOTE, promotion: null, unitPriceMinor: 1000 }),
    ).toBe(true);
  });

  it('REJECTS a quote that is not base minus discount', () => {
    expect(quoteIsExplainable({ ...QUOTE, unitPriceMinor: 900 })).toBe(false);
  });

  it('REJECTS a discount larger than the base — a promotion cannot raise a price', () => {
    expect(
      quoteIsExplainable({
        ...QUOTE,
        promotion: { ...QUOTE.promotion!, discountMinor: 1500 },
        unitPriceMinor: -500,
      }),
    ).toBe(false);
  });

  it('REJECTS a negative discount, which would be a price increase', () => {
    expect(
      quoteIsExplainable({
        ...QUOTE,
        promotion: { ...QUOTE.promotion!, discountMinor: -100 },
        unitPriceMinor: 1100,
      }),
    ).toBe(false);
  });
});

describe('describing promotion rules for operators', () => {
  it('reads basis points back as a percentage', () => {
    expect(describeRule({ kind: 'PERCENT_OFF', value: 1000 })).toBe('10% off');
    expect(describeRule({ kind: 'PERCENT_OFF', value: 1250 })).toBe('12.5% off');
    expect(describeRule({ kind: 'PERCENT_OFF', value: 10000 })).toBe('100% off');
  });

  it('mentions a percent cap when there is one', () => {
    expect(
      describeRule({ kind: 'PERCENT_OFF', value: 5000, maxDiscountMinor: 250 }),
    ).toBe('50% off, capped at 2.50');
  });

  it('reads the other two kinds in minor units', () => {
    expect(describeRule({ kind: 'AMOUNT_OFF', value: 250 })).toBe('2.50 off');
    expect(describeRule({ kind: 'FIXED_UNIT_PRICE', value: 799 })).toBe(
      'fixed unit price 7.99',
    );
  });

  it('names the catalog-wide rule as such', () => {
    expect(describeRuleScope({ productId: null })).toBe('every product');
    expect(
      describeRuleScope({ productId: 'prod-1', product: { sku: 'SKU-A' } }),
    ).toBe('SKU-A');
  });
});

describe('promotion version selection', () => {
  it('finds the version in force', () => {
    const promotion = {
      versions: [
        version({ id: 'a', status: 'SUPERSEDED', versionNumber: 1 }),
        version({ id: 'b', status: 'ACTIVE', versionNumber: 2 }),
        version({ id: 'c', status: 'DRAFT', versionNumber: 3 }),
      ],
    };
    expect(activeVersion(promotion)?.id).toBe('b');
  });

  it('reports no version in force rather than guessing', () => {
    expect(
      activeVersion({
        versions: [version({ status: 'SUPERSEDED' })],
      }),
    ).toBeNull();
    expect(activeVersion({ versions: undefined })).toBeNull();
  });

  it('picks the NEWEST draft, not the first one returned', () => {
    const promotion = {
      versions: [
        version({ id: 'd1', status: 'DRAFT', versionNumber: 3 }),
        version({ id: 'd2', status: 'DRAFT', versionNumber: 7 }),
        version({ id: 'd3', status: 'DRAFT', versionNumber: 5 }),
      ],
    };
    expect(latestDraft(promotion)?.id).toBe('d2');
  });

  it('reports no draft when there is none', () => {
    expect(latestDraft({ versions: [version({ status: 'ACTIVE' })] })).toBeNull();
  });
});

describe('points balance from the ledger', () => {
  it('reads the stamp on the newest movement, whatever the array order', () => {
    expect(
      balanceFromLedger([movement(2, 70), movement(4, 120), movement(3, 95)]),
    ).toBe(120);
  });

  it('is zero for an empty ledger', () => {
    expect(balanceFromLedger([])).toBe(0);
  });
});

describe('movement idempotency keys', () => {
  it('names the account and the action so a replay is recognisable', () => {
    const key = movementIdempotencyKey(
      'acc-1',
      'redeem',
      new Date('2026-06-01T00:00:00.000Z'),
    );
    expect(key).toContain('acc-1');
    expect(key).toContain('redeem');
  });

  it('differs between actions on the same account at the same instant', () => {
    const at = new Date('2026-06-01T00:00:00.000Z');
    expect(movementIdempotencyKey('acc-1', 'accrue', at)).not.toBe(
      movementIdempotencyKey('acc-1', 'redeem', at),
    );
  });
});
