import {
  OrderPaymentStatus,
  StoreEntryTokenStatus,
  StoreFlowAutonomyLevel,
  StoreFlowSettlementStatus,
} from '@prisma/client';
import { SHOPPER_SESSION_MAX_SECONDS } from './shopper.constants';
import {
  detectionView,
  parseShopperCredential,
  settlementViewFromJourney,
  shopperSessionUsable,
  summariseBasket,
} from './shopper.logic';

const SECRET = 'abcdefghijklmnop-_1234567890ABCD';

describe('parseShopperCredential', () => {
  it('reads the secret out of a well-formed header', () => {
    expect(parseShopperCredential(`Shopper ${SECRET}`)).toBe(SECRET);
  });

  it('accepts the scheme case-insensitively, as HTTP requires', () => {
    expect(parseShopperCredential(`shopper ${SECRET}`)).toBe(SECRET);
    expect(parseShopperCredential(`SHOPPER ${SECRET}`)).toBe(SECRET);
  });

  it('never accepts a staff Bearer token as a shopper credential', () => {
    expect(parseShopperCredential(`Bearer ${SECRET}`)).toBeNull();
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['empty', ''],
    ['scheme only', 'Shopper'],
    ['no scheme', SECRET],
    ['leading space', ` Shopper ${SECRET}`],
    ['basic auth', `Basic ${SECRET}`],
  ])('refuses a %s header', (_label, header) => {
    expect(parseShopperCredential(header)).toBeNull();
  });

  it.each([
    ['too short', 'abc'],
    ['not base64url', 'abcdefghijklmnop+/=='],
    ['with a space inside', 'abcdefghijklmnop 1234567890ABCD'],
    ['longer than the column allows', 'a'.repeat(201)],
  ])('refuses a secret that is %s', (_label, secret) => {
    expect(parseShopperCredential(`Shopper ${secret}`)).toBeNull();
  });
});

describe('shopperSessionUsable', () => {
  const redeemedAt = new Date('2026-09-16T10:00:00.000Z');
  const usable = {
    id: 'tok_1',
    tenantId: 'tenant_1',
    status: StoreEntryTokenStatus.REDEEMED,
    redeemedAt,
    redeemedJourneyId: 'journey_1',
    issuedById: 'user_1',
  };

  it('accepts a freshly redeemed credential', () => {
    expect(shopperSessionUsable(usable, redeemedAt)).toEqual({ usable: true });
  });

  it('accepts one right up to the end of the session window', () => {
    const now = new Date(
      redeemedAt.getTime() + SHOPPER_SESSION_MAX_SECONDS * 1000,
    );
    expect(shopperSessionUsable(usable, now).usable).toBe(true);
  });

  it('refuses one a second past the window', () => {
    const now = new Date(
      redeemedAt.getTime() + (SHOPPER_SESSION_MAX_SECONDS + 1) * 1000,
    );
    expect(shopperSessionUsable(usable, now)).toEqual({
      usable: false,
      reason: 'SESSION_EXPIRED',
    });
  });

  it('refuses a credential that has not been redeemed yet', () => {
    // An ISSUED credential is for the door, not for the session. Handing it
    // to /shopper/basket must not read anything.
    expect(
      shopperSessionUsable(
        { ...usable, status: StoreEntryTokenStatus.ISSUED },
        redeemedAt,
      ),
    ).toEqual({ usable: false, reason: 'NOT_REDEEMED' });
  });

  it('refuses a revoked credential', () => {
    expect(
      shopperSessionUsable(
        { ...usable, status: StoreEntryTokenStatus.REVOKED },
        redeemedAt,
      ).usable,
    ).toBe(false);
  });

  it('refuses a redeemed credential that is bound to no journey', () => {
    expect(
      shopperSessionUsable({ ...usable, redeemedJourneyId: null }, redeemedAt),
    ).toEqual({ usable: false, reason: 'NO_JOURNEY' });
  });

  it('refuses a credential nobody is accountable for', () => {
    expect(
      shopperSessionUsable({ ...usable, issuedById: null }, redeemedAt),
    ).toEqual({ usable: false, reason: 'NO_ISSUER' });
  });

  it('refuses a credential redeemed in the future (clock skew is not a door)', () => {
    const now = new Date(redeemedAt.getTime() - 1000);
    expect(shopperSessionUsable(usable, now)).toEqual({
      usable: false,
      reason: 'SESSION_EXPIRED',
    });
  });
});

describe('summariseBasket', () => {
  const line = (over: Partial<Parameters<typeof summariseBasket>[0][number]>) => ({
    id: 'line_1',
    sku: 'SKU-1',
    productName: 'Water 500ml',
    quantity: 1,
    unitPriceMinor: 120,
    lineTotalMinor: 120,
    currencyCode: 'GBP',
    ...over,
  });

  it('is empty and unpriced for an empty basket', () => {
    expect(summariseBasket([])).toEqual({
      lines: [],
      totalMinor: 0,
      currencyCode: null,
      hasUnpricedLine: false,
    });
  });

  it('adds the line totals up', () => {
    const summary = summariseBasket([
      line({}),
      line({ id: 'line_2', quantity: 2, lineTotalMinor: 240 }),
    ]);
    expect(summary.totalMinor).toBe(360);
    expect(summary.currencyCode).toBe('GBP');
    expect(summary.hasUnpricedLine).toBe(false);
  });

  it('flags an unpriced line instead of silently counting it as free', () => {
    const summary = summariseBasket([
      line({}),
      line({ id: 'line_2', unitPriceMinor: null, lineTotalMinor: null }),
    ]);
    expect(summary.totalMinor).toBe(120);
    expect(summary.hasUnpricedLine).toBe(true);
  });

  it('drops the currency rather than assert one when lines disagree', () => {
    const summary = summariseBasket([
      line({}),
      line({ id: 'line_2', currencyCode: 'EUR' }),
    ]);
    expect(summary.currencyCode).toBeNull();
  });

  it('never carries a catalog product id through to the shopper', () => {
    const [only] = summariseBasket([line({})]).lines;
    expect(Object.keys(only).sort()).toEqual([
      'currencyCode',
      'id',
      'lineTotalMinor',
      'productName',
      'quantity',
      'sku',
      'unitPriceMinor',
    ]);
  });
});

describe('detectionView', () => {
  it('is honest that SHADOW changes nothing', () => {
    expect(
      detectionView({
        autonomyLevel: StoreFlowAutonomyLevel.SHADOW,
        settleOnExit: false,
      }),
    ).toEqual({
      autonomyLevel: StoreFlowAutonomyLevel.SHADOW,
      active: false,
      settlesOnExit: false,
    });
  });

  it.each([
    StoreFlowAutonomyLevel.PROPOSE,
    StoreFlowAutonomyLevel.AUTO_APPLY,
  ])('reports %s as active', (autonomyLevel) => {
    expect(detectionView({ autonomyLevel, settleOnExit: true }).active).toBe(
      true,
    );
  });
});

describe('settlementViewFromJourney', () => {
  it('re-derives the one reason BLOCKED_ON_REVIEW can mean', () => {
    expect(
      settlementViewFromJourney(
        { settlementStatus: StoreFlowSettlementStatus.BLOCKED_ON_REVIEW },
        null,
      ),
    ).toEqual({
      status: StoreFlowSettlementStatus.BLOCKED_ON_REVIEW,
      blockedBy: 'AWAITING_EVENT_REVIEW',
      orderNumber: null,
      paidMinor: null,
      currencyCode: null,
      paymentStatus: null,
    });
  });

  it('invents no reason for any other state', () => {
    for (const status of [
      StoreFlowSettlementStatus.NOT_STARTED,
      StoreFlowSettlementStatus.ORDER_CREATED,
      StoreFlowSettlementStatus.PAID,
      StoreFlowSettlementStatus.FAILED,
    ]) {
      expect(
        settlementViewFromJourney({ settlementStatus: status }, null).blockedBy,
      ).toBeNull();
    }
  });

  it('carries the order number and the paid total once there is an order', () => {
    expect(
      settlementViewFromJourney(
        { settlementStatus: StoreFlowSettlementStatus.PAID },
        {
          orderNumber: 'ORD-1',
          totalMinor: 360,
          currencyCode: 'GBP',
          paymentStatus: OrderPaymentStatus.PAID,
        },
      ),
    ).toEqual({
      status: StoreFlowSettlementStatus.PAID,
      blockedBy: null,
      orderNumber: 'ORD-1',
      paidMinor: 360,
      currencyCode: 'GBP',
      paymentStatus: OrderPaymentStatus.PAID,
    });
  });
});
