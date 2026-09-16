import {
  isPromotionEffectiveAt,
  isReasonCode,
  normalizeMemberCode,
  normalizePromotionCode,
  normalizeReasonCode,
  projectLedgerAppend,
  PromotionCandidate,
  PromotionRuleCandidate,
  ruleDiscountMinor,
  ruleForProduct,
  selectPromotion,
  signedPoints,
} from './loyalty.logic';

const T = (iso: string) => new Date(iso);

function rule(
  over: Partial<PromotionRuleCandidate> = {},
): PromotionRuleCandidate {
  return {
    ruleId: over.ruleId ?? 'rule-1',
    productId: over.productId === undefined ? null : over.productId,
    kind: over.kind ?? 'PERCENT_OFF',
    value: over.value ?? 1000,
    maxDiscountMinor:
      over.maxDiscountMinor === undefined ? null : over.maxDiscountMinor,
  };
}

function candidate(
  over: Partial<PromotionCandidate> = {},
): PromotionCandidate {
  return {
    promotionId: over.promotionId ?? 'promo-1',
    promotionCode: over.promotionCode ?? 'SUMMER',
    promotionLocationId:
      over.promotionLocationId === undefined ? null : over.promotionLocationId,
    audience: over.audience ?? 'ALL_SHOPPERS',
    priority: over.priority ?? 0,
    promotionVersionId: over.promotionVersionId ?? 'pver-1',
    versionNumber: over.versionNumber ?? 1,
    status: over.status ?? 'ACTIVE',
    effectiveFrom: over.effectiveFrom ?? T('2026-01-01T00:00:00Z'),
    effectiveTo: over.effectiveTo === undefined ? null : over.effectiveTo,
    rules: over.rules ?? [rule()],
  };
}

const CTX = {
  productId: 'prod-1',
  basePriceMinor: 1000,
  at: T('2026-06-01T00:00:00Z'),
  locationId: 'loc-1',
  memberPresent: false,
};

describe('promotion effective windows', () => {
  it('are half-open: the start instant is in, the end instant is out', () => {
    const version = candidate({
      effectiveFrom: T('2026-06-01T00:00:00Z'),
      effectiveTo: T('2026-07-01T00:00:00Z'),
    });
    expect(isPromotionEffectiveAt(version, T('2026-06-01T00:00:00Z'))).toBe(
      true,
    );
    expect(
      isPromotionEffectiveAt(version, T('2026-06-30T23:59:59.999Z')),
    ).toBe(true);
    expect(isPromotionEffectiveAt(version, T('2026-07-01T00:00:00Z'))).toBe(
      false,
    );
    expect(isPromotionEffectiveAt(version, T('2026-05-31T23:59:59Z'))).toBe(
      false,
    );
  });

  it('treats a null end as still current', () => {
    expect(
      isPromotionEffectiveAt(candidate(), T('2099-01-01T00:00:00Z')),
    ).toBe(true);
  });
});

describe('rule discounts are strictly subtractive and integer-exact', () => {
  it('takes basis points off for PERCENT_OFF, flooring the discount', () => {
    // 10% of 1099 = 109.9 -> 109, never 110 and never a fraction.
    expect(
      ruleDiscountMinor(rule({ kind: 'PERCENT_OFF', value: 1000 }), 1099),
    ).toBe(109);
  });

  it('honours a PERCENT_OFF ceiling', () => {
    expect(
      ruleDiscountMinor(
        rule({ kind: 'PERCENT_OFF', value: 5000, maxDiscountMinor: 200 }),
        1000,
      ),
    ).toBe(200);
  });

  it('never discounts more than the base price', () => {
    expect(
      ruleDiscountMinor(rule({ kind: 'AMOUNT_OFF', value: 5000 }), 1000),
    ).toBe(1000);
    expect(
      ruleDiscountMinor(rule({ kind: 'PERCENT_OFF', value: 10000 }), 1000),
    ).toBe(1000);
  });

  it('treats a FIXED_UNIT_PRICE at or above the base as no discount at all', () => {
    expect(
      ruleDiscountMinor(rule({ kind: 'FIXED_UNIT_PRICE', value: 1500 }), 1000),
    ).toBe(0);
    expect(
      ruleDiscountMinor(rule({ kind: 'FIXED_UNIT_PRICE', value: 1000 }), 1000),
    ).toBe(0);
    expect(
      ruleDiscountMinor(rule({ kind: 'FIXED_UNIT_PRICE', value: 700 }), 1000),
    ).toBe(300);
  });

  it('discounts nothing on a zero or nonsensical base', () => {
    expect(ruleDiscountMinor(rule(), 0)).toBe(0);
    expect(ruleDiscountMinor(rule(), -100)).toBe(0);
    expect(ruleDiscountMinor(rule(), 10.5)).toBe(0);
  });

  it('A PROMOTION CAN NEVER RAISE A PRICE — no rule, no value', () => {
    const kinds = ['PERCENT_OFF', 'AMOUNT_OFF', 'FIXED_UNIT_PRICE'] as const;
    for (const kind of kinds) {
      for (const value of [1, 5, 999, 1000, 10000, 100_000_000]) {
        const discount = ruleDiscountMinor(rule({ kind, value }), 1000);
        expect(discount).toBeGreaterThanOrEqual(0);
        expect(discount).toBeLessThanOrEqual(1000);
        expect(1000 - discount).toBeLessThanOrEqual(1000);
      }
    }
  });
});

describe('rule selection within a version', () => {
  it('prefers the product-specific rule over the catalog-wide one', () => {
    const version = candidate({
      rules: [
        rule({ ruleId: 'wide', productId: null }),
        rule({ ruleId: 'specific', productId: 'prod-1' }),
      ],
    });
    expect(ruleForProduct(version, 'prod-1')?.ruleId).toBe('specific');
    expect(ruleForProduct(version, 'prod-2')?.ruleId).toBe('wide');
  });

  it('returns null when the version covers neither', () => {
    const version = candidate({
      rules: [rule({ ruleId: 'other', productId: 'prod-9' })],
    });
    expect(ruleForProduct(version, 'prod-1')).toBeNull();
  });
});

describe('selectPromotion', () => {
  it('returns null when nothing applies, leaving the base price alone', () => {
    expect(selectPromotion([], CTX)).toBeNull();
  });

  it('applies exactly one promotion and reports both halves of the price', () => {
    const outcome = selectPromotion(
      [candidate({ rules: [rule({ kind: 'AMOUNT_OFF', value: 250 })] })],
      CTX,
    );
    expect(outcome).toEqual({
      promotionId: 'promo-1',
      promotionVersionId: 'pver-1',
      ruleId: 'rule-1',
      kind: 'AMOUNT_OFF',
      discountMinor: 250,
      finalUnitPriceMinor: 750,
    });
  });

  it('DOES NOT STACK: the largest single discount wins, never the sum', () => {
    const outcome = selectPromotion(
      [
        candidate({
          promotionId: 'p-a',
          promotionCode: 'A',
          promotionVersionId: 'v-a',
          rules: [rule({ ruleId: 'r-a', kind: 'AMOUNT_OFF', value: 100 })],
        }),
        candidate({
          promotionId: 'p-b',
          promotionCode: 'B',
          promotionVersionId: 'v-b',
          rules: [rule({ ruleId: 'r-b', kind: 'AMOUNT_OFF', value: 300 })],
        }),
      ],
      CTX,
    );
    expect(outcome?.promotionId).toBe('p-b');
    expect(outcome?.discountMinor).toBe(300);
    // 400 would be the stacked answer. It is not the answer.
    expect(outcome?.finalUnitPriceMinor).toBe(700);
  });

  it('breaks an equal-discount tie by priority, not by array order', () => {
    const low = candidate({
      promotionId: 'p-low',
      promotionCode: 'LOW',
      promotionVersionId: 'v-low',
      priority: 1,
      rules: [rule({ ruleId: 'r-low', kind: 'AMOUNT_OFF', value: 200 })],
    });
    const high = candidate({
      promotionId: 'p-high',
      promotionCode: 'HIGH',
      promotionVersionId: 'v-high',
      priority: 5,
      rules: [rule({ ruleId: 'r-high', kind: 'AMOUNT_OFF', value: 200 })],
    });
    expect(selectPromotion([low, high], CTX)?.promotionId).toBe('p-high');
    expect(selectPromotion([high, low], CTX)?.promotionId).toBe('p-high');
  });

  it('never lets priority beat a larger discount', () => {
    const bigLowPriority = candidate({
      promotionId: 'p-big',
      promotionCode: 'BIG',
      promotionVersionId: 'v-big',
      priority: -1000,
      rules: [rule({ ruleId: 'r-big', kind: 'AMOUNT_OFF', value: 400 })],
    });
    const smallHighPriority = candidate({
      promotionId: 'p-small',
      promotionCode: 'SMALL',
      promotionVersionId: 'v-small',
      priority: 1000,
      rules: [rule({ ruleId: 'r-small', kind: 'AMOUNT_OFF', value: 100 })],
    });
    expect(
      selectPromotion([smallHighPriority, bigLowPriority], CTX)?.promotionId,
    ).toBe('p-big');
  });

  it('skips a promotion outside its window', () => {
    expect(
      selectPromotion(
        [
          candidate({
            effectiveFrom: T('2026-01-01T00:00:00Z'),
            effectiveTo: T('2026-02-01T00:00:00Z'),
            rules: [rule({ kind: 'AMOUNT_OFF', value: 300 })],
          }),
        ],
        CTX,
      ),
    ).toBeNull();
  });

  it('still applies a SUPERSEDED version inside its closed window', () => {
    const outcome = selectPromotion(
      [
        candidate({
          status: 'SUPERSEDED',
          effectiveFrom: T('2026-01-01T00:00:00Z'),
          effectiveTo: T('2026-12-01T00:00:00Z'),
          rules: [rule({ kind: 'AMOUNT_OFF', value: 300 })],
        }),
      ],
      CTX,
    );
    expect(outcome?.discountMinor).toBe(300);
  });

  it('skips a promotion scoped to a different location', () => {
    expect(
      selectPromotion(
        [
          candidate({
            promotionLocationId: 'loc-other',
            rules: [rule({ kind: 'AMOUNT_OFF', value: 300 })],
          }),
        ],
        CTX,
      ),
    ).toBeNull();
  });

  it('prefers the location-scoped promotion over the tenant-wide one on a tie', () => {
    const wide = candidate({
      promotionId: 'p-wide',
      promotionCode: 'WIDE',
      promotionVersionId: 'v-wide',
      promotionLocationId: null,
      rules: [rule({ ruleId: 'r-wide', kind: 'AMOUNT_OFF', value: 200 })],
    });
    const local = candidate({
      promotionId: 'p-local',
      promotionCode: 'LOCAL',
      promotionVersionId: 'v-local',
      promotionLocationId: 'loc-1',
      rules: [rule({ ruleId: 'r-local', kind: 'AMOUNT_OFF', value: 200 })],
    });
    expect(selectPromotion([wide, local], CTX)?.promotionId).toBe('p-local');
  });

  it('applies a member-only promotion only when an active member is present', () => {
    const members = candidate({
      audience: 'LOYALTY_MEMBERS',
      rules: [rule({ kind: 'AMOUNT_OFF', value: 300 })],
    });
    expect(selectPromotion([members], CTX)).toBeNull();
    expect(
      selectPromotion([members], { ...CTX, memberPresent: true })
        ?.discountMinor,
    ).toBe(300);
  });

  it('never applies a promotion that takes nothing off', () => {
    expect(
      selectPromotion(
        [
          candidate({
            rules: [rule({ kind: 'FIXED_UNIT_PRICE', value: 2000 })],
          }),
        ],
        CTX,
      ),
    ).toBeNull();
  });

  it('is deterministic: the same inputs in any order give the same answer', () => {
    const a = candidate({
      promotionId: 'p-a',
      promotionCode: 'AAA',
      promotionVersionId: 'v-a',
      rules: [rule({ ruleId: 'r-a', kind: 'AMOUNT_OFF', value: 200 })],
    });
    const b = candidate({
      promotionId: 'p-b',
      promotionCode: 'BBB',
      promotionVersionId: 'v-b',
      rules: [rule({ ruleId: 'r-b', kind: 'AMOUNT_OFF', value: 200 })],
    });
    expect(selectPromotion([a, b], CTX)).toEqual(selectPromotion([b, a], CTX));
  });

  it('always reports finalUnitPriceMinor as base minus discount', () => {
    for (const value of [1, 99, 500, 999, 1000]) {
      const outcome = selectPromotion(
        [candidate({ rules: [rule({ kind: 'AMOUNT_OFF', value })] })],
        CTX,
      );
      expect(outcome?.finalUnitPriceMinor).toBe(
        CTX.basePriceMinor - (outcome?.discountMinor ?? 0),
      );
      expect(outcome?.finalUnitPriceMinor).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('points ledger projection', () => {
  it('appends the next sequence number and the derived balance', () => {
    expect(projectLedgerAppend({ sequenceNumber: 3, balance: 120 }, 30)).toEqual(
      { sequenceNumber: 4, balanceAfter: 150 },
    );
  });

  it('starts an empty ledger at sequence 1', () => {
    expect(projectLedgerAppend({ sequenceNumber: 0, balance: 0 }, 10)).toEqual({
      sequenceNumber: 1,
      balanceAfter: 10,
    });
  });

  it('REFUSES TO OVERDRAW — a redemption cannot go below zero', () => {
    expect(projectLedgerAppend({ sequenceNumber: 2, balance: 50 }, -51)).toBe(
      'insufficient-points',
    );
  });

  it('allows a redemption that lands exactly on zero', () => {
    expect(projectLedgerAppend({ sequenceNumber: 2, balance: 50 }, -50)).toEqual(
      { sequenceNumber: 3, balanceAfter: 0 },
    );
  });

  it('refuses a zero or fractional movement', () => {
    expect(projectLedgerAppend({ sequenceNumber: 1, balance: 10 }, 0)).toBe(
      'zero-points',
    );
    expect(projectLedgerAppend({ sequenceNumber: 1, balance: 10 }, 1.5)).toBe(
      'zero-points',
    );
  });

  it('refuses a balance past the integer ceiling instead of overflowing', () => {
    expect(
      projectLedgerAppend({ sequenceNumber: 1, balance: 2147483000 }, 1000),
    ).toBe('points-overflow');
  });
});

describe('signedPoints', () => {
  it.each([
    ['ACCRUAL', 10, 10],
    ['ACCRUAL', -10, 10],
    ['REDEMPTION', 10, -10],
    ['REDEMPTION', -10, -10],
    ['EXPIRY', 10, -10],
    ['ADJUSTMENT', -7, -7],
    ['ADJUSTMENT', 7, 7],
    ['REVERSAL', -7, -7],
  ] as const)('%s of %s becomes %s', (type, input, expected) => {
    expect(signedPoints(type, input)).toBe(expected);
  });
});

describe('normalization', () => {
  it('uppercases and trims member and promotion codes', () => {
    expect(normalizeMemberCode('  mem-001 ')).toBe('MEM-001');
    expect(normalizePromotionCode(' summer-10 ')).toBe('SUMMER-10');
  });

  it('folds reason codes into the closed vocabulary shape', () => {
    expect(normalizeReasonCode(' purchase reward ')).toBe('PURCHASE_REWARD');
    expect(normalizeReasonCode('goodwill-credit')).toBe('GOODWILL_CREDIT');
    expect(isReasonCode(normalizeReasonCode('goodwill-credit'))).toBe(true);
    expect(isReasonCode('9BAD')).toBe(false);
  });
});
