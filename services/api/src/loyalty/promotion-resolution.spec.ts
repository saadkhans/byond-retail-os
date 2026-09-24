import { PromotionCandidate } from './loyalty.logic';
import { PromotionResolutionService } from './promotion-resolution.service';

/**
 * The composition contract: promotions resolve ON TOP of a price version.
 *
 * Every assertion here is about ORDER and PROVENANCE — that pricing is asked
 * first and alone, that its answer is used as a read-only value, and that the
 * result always names both the price version and the promotion version that
 * produced it.
 */

const TENANT = 'tenant-a';
const AT = new Date('2026-06-15T00:00:00Z');

const BASE = {
  unitPriceMinor: 1000,
  currencyCode: 'AED',
  priceBookId: 'book-1',
  priceBookVersionId: 'ver-7',
};

function candidate(over: Partial<PromotionCandidate> = {}): PromotionCandidate {
  return {
    promotionId: 'promo-1',
    promotionCode: 'SUMMER',
    promotionLocationId: null,
    audience: 'ALL_SHOPPERS',
    priority: 0,
    promotionVersionId: 'pver-1',
    versionNumber: 1,
    status: 'ACTIVE',
    effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    effectiveTo: null,
    rules: [
      {
        ruleId: 'rule-1',
        productId: null,
        kind: 'AMOUNT_OFF',
        value: 150,
        maxDiscountMinor: null,
      },
    ],
    ...over,
  };
}

function build(options: {
  candidates?: PromotionCandidate[];
  moduleEnabled?: boolean;
  activeMember?: boolean;
  base?: typeof BASE | null;
}) {
  const repository = {
    findPromotionCandidates: jest.fn(
      async (..._args: unknown[]) => options.candidates ?? [candidate()],
    ),
    isActiveMember: jest.fn(
      async (..._args: unknown[]) => options.activeMember ?? false,
    ),
  };
  const priceResolution = {
    resolve: jest.fn(async (..._args: unknown[]) =>
      options.base === undefined ? BASE : options.base,
    ),
  };
  const platformModules = {
    isEnabledForTenant: jest.fn(
      async (..._args: unknown[]) => options.moduleEnabled ?? true,
    ),
  };
  const service = new PromotionResolutionService(
    repository as never,
    priceResolution as never,
    platformModules as never,
  );
  return { service, repository, priceResolution, platformModules };
}

describe('PromotionResolutionService.resolveForLine', () => {
  const query = {
    tenantId: TENANT,
    productId: 'prod-1',
    locationId: 'loc-1',
    at: AT,
    base: BASE,
    loyaltyAccountId: null,
  };

  it('reduces the resolved price and names the promotion version', async () => {
    const { service } = build({});
    expect(await service.resolveForLine({} as never, query)).toEqual({
      basePriceMinor: 1000,
      discountMinor: 150,
      unitPriceMinor: 850,
      currencyCode: 'AED',
      promotionId: 'promo-1',
      promotionVersionId: 'pver-1',
    });
  });

  it('returns null — leaving the base price untouched — when the module is off', async () => {
    const { service, repository } = build({ moduleEnabled: false });
    expect(await service.resolveForLine({} as never, query)).toBeNull();
    // And it does not even look: a disabled module costs one boolean, not a
    // query.
    expect(repository.findPromotionCandidates).not.toHaveBeenCalled();
  });

  it('returns null when no promotion applies', async () => {
    const { service } = build({ candidates: [] });
    expect(await service.resolveForLine({} as never, query)).toBeNull();
  });

  it('carries the base currency through unchanged', async () => {
    const { service } = build({});
    const result = await service.resolveForLine({} as never, {
      ...query,
      base: { ...BASE, currencyCode: 'USD' },
    });
    expect(result?.currencyCode).toBe('USD');
  });

  it('evaluates inside the caller’s transaction client', async () => {
    const { service, repository } = build({});
    const tx = { marker: 'tx' };
    await service.resolveForLine(tx as never, query);
    expect(repository.findPromotionCandidates).toHaveBeenCalledWith(
      TENANT,
      ['prod-1'],
      AT,
      'loc-1',
      tx,
    );
  });

  it('treats a member-only promotion as inapplicable without an active member', async () => {
    const memberOnly = [candidate({ audience: 'LOYALTY_MEMBERS' })];
    const withoutMember = build({ candidates: memberOnly, activeMember: false });
    expect(
      await withoutMember.service.resolveForLine({} as never, {
        ...query,
        loyaltyAccountId: 'acc-1',
      }),
    ).toBeNull();

    const withMember = build({ candidates: memberOnly, activeMember: true });
    expect(
      (
        await withMember.service.resolveForLine({} as never, {
          ...query,
          loyaltyAccountId: 'acc-1',
        })
      )?.discountMinor,
    ).toBe(150);
  });

  it('does not ask about membership when the basket has no account', async () => {
    const { service, repository } = build({});
    await service.resolveForLine({} as never, query);
    expect(repository.isActiveMember).not.toHaveBeenCalled();
  });

  it('ALWAYS returns a price at or below the base — a promotion cannot raise one', async () => {
    const kinds = ['PERCENT_OFF', 'AMOUNT_OFF', 'FIXED_UNIT_PRICE'] as const;
    for (const kind of kinds) {
      for (const value of [1, 250, 10000, 100_000_000]) {
        const { service } = build({
          candidates: [
            candidate({
              rules: [
                {
                  ruleId: 'r',
                  productId: null,
                  kind,
                  value,
                  maxDiscountMinor: null,
                },
              ],
            }),
          ],
        });
        const result = await service.resolveForLine({} as never, query);
        if (result) {
          expect(result.unitPriceMinor).toBeLessThanOrEqual(
            BASE.unitPriceMinor,
          );
          expect(result.unitPriceMinor).toBeGreaterThanOrEqual(0);
          expect(result.basePriceMinor).toBe(BASE.unitPriceMinor);
        }
      }
    }
  });
});

describe('PromotionResolutionService.quote', () => {
  it('explains the price with BOTH the price version and the promotion version', async () => {
    const { service } = build({});
    expect(
      await service.quote(TENANT, { productId: 'prod-1', at: AT, locationId: 'loc-1' }),
    ).toEqual({
      productId: 'prod-1',
      currencyCode: 'AED',
      basePriceMinor: 1000,
      priceBookId: 'book-1',
      priceBookVersionId: 'ver-7',
      promotion: {
        promotionId: 'promo-1',
        promotionVersionId: 'pver-1',
        ruleId: 'rule-1',
        kind: 'AMOUNT_OFF',
        discountMinor: 150,
        finalUnitPriceMinor: 850,
      },
      unitPriceMinor: 850,
    });
  });

  it('asks pricing FIRST, and never quotes without a price version', async () => {
    const { service, priceResolution, repository } = build({ base: null });
    expect(
      await service.quote(TENANT, { productId: 'prod-1', at: AT }),
    ).toBeNull();
    expect(priceResolution.resolve).toHaveBeenCalled();
    // UNPRICED is not "free with a discount": with no base there is nothing
    // to subtract from, so promotions are not even consulted.
    expect(repository.findPromotionCandidates).not.toHaveBeenCalled();
  });

  it('still reports the base price when the loyalty module is disabled', async () => {
    const { service } = build({ moduleEnabled: false });
    const quote = await service.quote(TENANT, { productId: 'prod-1', at: AT });
    expect(quote).toMatchObject({
      basePriceMinor: 1000,
      unitPriceMinor: 1000,
      priceBookVersionId: 'ver-7',
      promotion: null,
    });
  });

  it('passes a historical instant straight through to price resolution', async () => {
    const { service, priceResolution } = build({});
    const past = new Date('2025-03-01T00:00:00Z');
    await service.quote(TENANT, {
      productId: 'prod-1',
      at: past,
      locationId: 'loc-2',
    });
    expect(priceResolution.resolve).toHaveBeenCalledWith(
      TENANT,
      'prod-1',
      past,
      'loc-2',
    );
  });
});
