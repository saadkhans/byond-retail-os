import { ConflictException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import {
  CustomerJourneyStatus,
  OrderPaymentStatus,
  StoreEntryTokenStatus,
  StoreFlowAutonomyLevel,
  StoreFlowSettlementStatus,
} from '@prisma/client';
import { PlatformModulesService } from '../platform-modules/platform-modules.service';
import { StoreFlowService } from '../store-flow/store-flow.service';
import {
  ENTRY_CREDENTIAL_INVALID,
  SHOPPER_SESSION_INVALID,
  SHOPPER_SESSION_MAX_SECONDS,
} from './shopper.constants';
import { ShopperRepository } from './shopper.repository';
import { ShopperService } from './shopper.service';

/**
 * Phase 35 — what a shopper can and cannot reach.
 *
 * These are the states a real shopper hits: a credential that expired while
 * they queued, one their friend already used, one that belongs to another
 * shop entirely, an empty basket in a SHADOW store, an exit a colleague has
 * to look at first, and a settled visit.
 */

const SECRET = 'abcdefghijklmnop-_1234567890ABCD';
const HEADER = `Shopper ${SECRET}`;
const NOW = new Date('2026-09-16T10:00:00.000Z');

const credential = (over: Record<string, unknown> = {}) => ({
  id: 'tok_1',
  tenantId: 'tenant_1',
  status: StoreEntryTokenStatus.REDEEMED,
  redeemedAt: NOW,
  redeemedJourneyId: 'journey_1',
  issuedById: 'user_1',
  ...over,
});

const journey = (over: Record<string, unknown> = {}) => ({
  id: 'journey_1',
  locationId: 'loc_1',
  status: CustomerJourneyStatus.OPEN,
  checkoutSessionId: 'sess_1',
  orderId: null,
  settlementStatus: StoreFlowSettlementStatus.NOT_STARTED,
  ...over,
});

const shadowPolicy = {
  autonomyLevel: StoreFlowAutonomyLevel.SHADOW,
  autoApplyMinConfidence: 0.7,
  requireInventoryValidation: true,
  settleOnExit: false,
  policyVersionId: null,
  policyLocationId: null,
};

const autoPolicy = {
  ...shadowPolicy,
  autonomyLevel: StoreFlowAutonomyLevel.AUTO_APPLY,
  settleOnExit: true,
  policyVersionId: 'ver_1',
  policyLocationId: 'loc_1',
};

type Repo = jest.Mocked<ShopperRepository>;
type Modules = jest.Mocked<PlatformModulesService>;
type Flow = jest.Mocked<StoreFlowService>;

function build(overrides: {
  repo?: Partial<Repo>;
  modules?: Partial<Modules>;
  flow?: Partial<Flow>;
} = {}) {
  const repo = {
    findCredentialByHash: jest.fn().mockResolvedValue(credential()),
    tenantIsActive: jest.fn().mockResolvedValue(true),
    findActiveIssuer: jest
      .fn()
      .mockResolvedValue({ id: 'user_1', email: 'operator@store.test' }),
    findJourney: jest.fn().mockResolvedValue(journey()),
    basketLines: jest.fn().mockResolvedValue([]),
    findOrder: jest.fn().mockResolvedValue(null),
    ...overrides.repo,
  } as unknown as Repo;
  const modules = {
    isEnabledForTenant: jest.fn().mockResolvedValue(true),
    ...overrides.modules,
  } as unknown as Modules;
  const flow = {
    effectivePolicy: jest.fn().mockResolvedValue(shadowPolicy),
    redeemEntryToken: jest.fn().mockResolvedValue({
      journeyId: 'journey_1',
      shopperId: 'shopper_1',
      checkoutSessionId: 'sess_1',
      locationId: 'loc_1',
      unitId: 'unit_1',
    }),
    exitJourney: jest.fn().mockResolvedValue({
      journey: {},
      settlement: {
        status: StoreFlowSettlementStatus.NOT_STARTED,
        blockedBy: 'SETTLEMENT_DISABLED',
        order: null,
        payment: null,
      },
    }),
    ...overrides.flow,
  } as unknown as Flow;
  return { service: new ShopperService(repo, modules, flow), repo, modules, flow };
}

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(NOW);
});

afterEach(() => {
  jest.useRealTimers();
  jest.clearAllMocks();
});

// ===========================================================================
// Entry
// ===========================================================================

describe('entering the store', () => {
  it('redeems through Phase 26 and returns the shopper view', async () => {
    const { service, flow } = build();
    const view = await service.enter({ token: SECRET });

    expect(flow.redeemEntryToken).toHaveBeenCalledWith(
      'tenant_1',
      { token: SECRET },
      { id: 'user_1', email: 'operator@store.test' },
    );
    expect(view.journeyId).toBe('journey_1');
    expect(view.detection).toEqual({
      autonomyLevel: StoreFlowAutonomyLevel.SHADOW,
      active: false,
      settlesOnExit: false,
    });
  });

  it('never reveals whether an unknown credential exists', async () => {
    const { service, flow } = build({
      repo: { findCredentialByHash: jest.fn().mockResolvedValue(null) },
    });
    await expect(service.enter({ token: SECRET })).rejects.toThrow(
      new NotFoundException(ENTRY_CREDENTIAL_INVALID),
    );
    expect(flow.redeemEntryToken).not.toHaveBeenCalled();
  });

  it('lets an EXPIRED credential stay distinguishable — the shopper needs a new code', async () => {
    // Phase 26 answers 409 with a reason for expired/used, and 404 for
    // unknown/wrong. This surface must not blur that distinction shut; it
    // only refuses to ADD a way to tell unknown from wrong.
    const { service } = build({
      flow: {
        redeemEntryToken: jest
          .fn()
          .mockRejectedValue(
            new ConflictException('Entry credential is not usable (EXPIRED)'),
          ),
      },
    });
    await expect(service.enter({ token: SECRET })).rejects.toMatchObject({
      status: 409,
      message: 'Entry credential is not usable (EXPIRED)',
    });
  });

  it('passes an ALREADY_USED credential straight through', async () => {
    const { service } = build({
      flow: {
        redeemEntryToken: jest
          .fn()
          .mockRejectedValue(
            new ConflictException('Entry credential is not usable (ALREADY_USED)'),
          ),
      },
    });
    await expect(service.enter({ token: SECRET })).rejects.toMatchObject({
      status: 409,
      message: 'Entry credential is not usable (ALREADY_USED)',
    });
  });

  const refusesBeforeRedeeming = async (repo: Partial<Repo>) => {
    const { service, flow } = build({ repo });
    await expect(service.enter({ token: SECRET })).rejects.toThrow(
      new NotFoundException(ENTRY_CREDENTIAL_INVALID),
    );
    expect(flow.redeemEntryToken).not.toHaveBeenCalled();
  };

  it('refuses with the unknown-credential answer when the tenant is suspended', () =>
    refusesBeforeRedeeming({
      tenantIsActive: jest.fn().mockResolvedValue(false),
    } as unknown as Partial<Repo>));

  it('refuses with the unknown-credential answer when the issuing operator is gone', () =>
    refusesBeforeRedeeming({
      findActiveIssuer: jest.fn().mockResolvedValue(null),
    } as unknown as Partial<Repo>));

  it('refuses a credential nobody is accountable for', () =>
    refusesBeforeRedeeming({
      findCredentialByHash: jest
        .fn()
        .mockResolvedValue(credential({ issuedById: null })),
    } as unknown as Partial<Repo>));

  it('refuses when the tenant has the store-flow module disabled', async () => {
    const { service, flow } = build({
      modules: { isEnabledForTenant: jest.fn().mockResolvedValue(false) },
    });
    await expect(service.enter({ token: SECRET })).rejects.toThrow(
      new NotFoundException(ENTRY_CREDENTIAL_INVALID),
    );
    expect(flow.redeemEntryToken).not.toHaveBeenCalled();
  });

  it('refuses a digest that resolves ambiguously across tenants', async () => {
    // findCredentialByHash returns null unless EXACTLY one row matched; the
    // service must then behave as if the credential does not exist rather
    // than pick a tenant.
    const { service } = build({
      repo: { findCredentialByHash: jest.fn().mockResolvedValue(null) },
    });
    await expect(service.enter({ token: SECRET })).rejects.toThrow(
      NotFoundException,
    );
  });
});

// ===========================================================================
// The session credential
// ===========================================================================

describe('the journey-scoped session', () => {
  it.each([
    ['no header at all', undefined],
    ['a staff bearer token', `Bearer ${SECRET}`],
    ['a malformed credential', 'Shopper not+valid'],
  ])('refuses %s with one generic answer', async (_label, header) => {
    const { service, repo } = build();
    await expect(service.basket(header)).rejects.toThrow(
      new UnauthorizedException(SHOPPER_SESSION_INVALID),
    );
    expect(repo.findCredentialByHash).not.toHaveBeenCalled();
  });

  it('refuses a credential that was issued but never redeemed', async () => {
    const { service } = build({
      repo: {
        findCredentialByHash: jest
          .fn()
          .mockResolvedValue(
            credential({ status: StoreEntryTokenStatus.ISSUED, redeemedAt: null }),
          ),
      },
    });
    await expect(service.basket(HEADER)).rejects.toThrow(
      new UnauthorizedException(SHOPPER_SESSION_INVALID),
    );
  });

  it('refuses once the session window has passed', async () => {
    jest.setSystemTime(
      new Date(NOW.getTime() + (SHOPPER_SESSION_MAX_SECONDS + 1) * 1000),
    );
    const { service } = build();
    await expect(service.basket(HEADER)).rejects.toThrow(
      new UnauthorizedException(SHOPPER_SESSION_INVALID),
    );
  });

  it('refuses if the tenant was suspended mid-visit', async () => {
    const { service } = build({
      repo: { tenantIsActive: jest.fn().mockResolvedValue(false) },
    });
    await expect(service.basket(HEADER)).rejects.toThrow(
      new UnauthorizedException(SHOPPER_SESSION_INVALID),
    );
  });

  it('refuses if the module was disabled mid-visit', async () => {
    const { service } = build({
      modules: { isEnabledForTenant: jest.fn().mockResolvedValue(false) },
    });
    await expect(service.basket(HEADER)).rejects.toThrow(
      new UnauthorizedException(SHOPPER_SESSION_INVALID),
    );
  });

  it('reads the journey ONLY within the credential’s own tenant', async () => {
    const { service, repo } = build();
    await service.basket(HEADER);
    expect(repo.findJourney).toHaveBeenCalledWith('tenant_1', 'journey_1');
    expect(repo.basketLines).toHaveBeenCalledWith('tenant_1', 'sess_1');
  });

  it('refuses when the journey is not in the credential’s tenant', async () => {
    const { service } = build({
      repo: { findJourney: jest.fn().mockResolvedValue(null) },
    });
    await expect(service.basket(HEADER)).rejects.toThrow(
      new UnauthorizedException(SHOPPER_SESSION_INVALID),
    );
  });
});

// ===========================================================================
// The basket
// ===========================================================================

describe('the live basket', () => {
  it('is empty and honestly inactive under the default SHADOW policy', async () => {
    const { service } = build();
    const view = await service.basket(HEADER);
    expect(view.basket.lines).toEqual([]);
    expect(view.detection.active).toBe(false);
    expect(view.detection.autonomyLevel).toBe(StoreFlowAutonomyLevel.SHADOW);
  });

  it('shows the lines the loop resolved once the store is live', async () => {
    const { service } = build({
      flow: { effectivePolicy: jest.fn().mockResolvedValue(autoPolicy) },
      repo: {
        basketLines: jest.fn().mockResolvedValue([
          {
            id: 'line_1',
            sku: 'SKU-WATER',
            productName: 'Water 500ml',
            quantity: 2,
            unitPriceMinor: 120,
            lineTotalMinor: 240,
            currencyCode: 'GBP',
          },
        ]),
      },
    });
    const view = await service.basket(HEADER);
    expect(view.detection.active).toBe(true);
    expect(view.basket.totalMinor).toBe(240);
    expect(view.basket.currencyCode).toBe('GBP');
  });

  it('reads no basket at all for a journey with no session bound', async () => {
    const { service, repo } = build({
      repo: {
        findJourney: jest
          .fn()
          .mockResolvedValue(journey({ checkoutSessionId: null })),
      },
    });
    const view = await service.basket(HEADER);
    expect(repo.basketLines).not.toHaveBeenCalled();
    expect(view.basket.lines).toEqual([]);
  });

  it('never returns a tenant id, a store id or a shopper id', async () => {
    const { service } = build();
    const view = await service.basket(HEADER);
    const serialised = JSON.stringify(view);
    for (const secretish of ['tenant_1', 'loc_1', 'unit_1', 'shopper_1', 'sess_1']) {
      expect(serialised).not.toContain(secretish);
    }
    expect(Object.keys(view).sort()).toEqual([
      'basket',
      'detection',
      'journeyId',
      'journeyStatus',
      'settlement',
    ]);
  });
});

// ===========================================================================
// Exit and payment
// ===========================================================================

describe('leaving the store', () => {
  it('drives Phase 26’s exit with the accountable operator', async () => {
    const { service, flow } = build();
    await service.exit(HEADER);
    expect(flow.exitJourney).toHaveBeenCalledWith('tenant_1', 'journey_1', {
      id: 'user_1',
      email: 'operator@store.test',
    });
  });

  it('reports a settlement blocked on review as a state, not an error', async () => {
    const { service } = build({
      flow: {
        effectivePolicy: jest.fn().mockResolvedValue(autoPolicy),
        exitJourney: jest.fn().mockResolvedValue({
          journey: {},
          settlement: {
            status: StoreFlowSettlementStatus.BLOCKED_ON_REVIEW,
            blockedBy: 'AWAITING_EVENT_REVIEW',
            order: null,
            payment: null,
          },
        }),
      },
      repo: {
        findJourney: jest.fn().mockResolvedValue(
          journey({
            status: CustomerJourneyStatus.EXITED,
            settlementStatus: StoreFlowSettlementStatus.BLOCKED_ON_REVIEW,
          }),
        ),
      },
    });
    const view = await service.exit(HEADER);
    expect(view.settlement.status).toBe(
      StoreFlowSettlementStatus.BLOCKED_ON_REVIEW,
    );
    expect(view.settlement.blockedBy).toBe('AWAITING_EVENT_REVIEW');
    expect(view.settlement.orderNumber).toBeNull();
  });

  it('keeps the blocking reason visible on a later plain refresh', async () => {
    const { service } = build({
      repo: {
        findJourney: jest.fn().mockResolvedValue(
          journey({
            status: CustomerJourneyStatus.EXITED,
            settlementStatus: StoreFlowSettlementStatus.BLOCKED_ON_REVIEW,
          }),
        ),
      },
    });
    const view = await service.basket(HEADER);
    expect(view.settlement.blockedBy).toBe('AWAITING_EVENT_REVIEW');
  });

  it('reports a shopper who took nothing as an empty basket, not a failure', async () => {
    const { service } = build({
      flow: {
        effectivePolicy: jest.fn().mockResolvedValue(autoPolicy),
        exitJourney: jest.fn().mockResolvedValue({
          journey: {},
          settlement: {
            status: StoreFlowSettlementStatus.NOT_STARTED,
            blockedBy: 'EMPTY_BASKET',
            order: null,
            payment: null,
          },
        }),
      },
      repo: {
        findJourney: jest
          .fn()
          .mockResolvedValue(journey({ status: CustomerJourneyStatus.EXITED })),
      },
    });
    const view = await service.exit(HEADER);
    expect(view.settlement.status).toBe(StoreFlowSettlementStatus.NOT_STARTED);
    expect(view.settlement.blockedBy).toBe('EMPTY_BASKET');
  });

  it('reports a captured payment as a paid receipt', async () => {
    const { service } = build({
      flow: {
        effectivePolicy: jest.fn().mockResolvedValue(autoPolicy),
        exitJourney: jest.fn().mockResolvedValue({
          journey: {},
          settlement: {
            status: StoreFlowSettlementStatus.PAID,
            blockedBy: null,
            order: { id: 'ord_1', orderNumber: 'ORD-1' },
            payment: { id: 'pay_1', status: 'CAPTURED' },
          },
        }),
      },
      repo: {
        findJourney: jest.fn().mockResolvedValue(
          journey({
            status: CustomerJourneyStatus.EXITED,
            orderId: 'ord_1',
            settlementStatus: StoreFlowSettlementStatus.PAID,
          }),
        ),
        findOrder: jest.fn().mockResolvedValue({
          orderNumber: 'ORD-1',
          totalMinor: 240,
          currencyCode: 'GBP',
          paymentStatus: OrderPaymentStatus.PAID,
        }),
      },
    });
    const view = await service.exit(HEADER);
    expect(view.settlement).toEqual({
      status: StoreFlowSettlementStatus.PAID,
      blockedBy: null,
      orderNumber: 'ORD-1',
      paidMinor: 240,
      currencyCode: 'GBP',
      paymentStatus: OrderPaymentStatus.PAID,
    });
    // The payment INTENT id is Phase 6's internal handle. It is not part of
    // a shopper's receipt and must not leak into one.
    expect(JSON.stringify(view)).not.toContain('pay_1');
  });

  it('reports an order that could not be charged as unpaid, without inventing a reason', async () => {
    const { service } = build({
      flow: {
        effectivePolicy: jest.fn().mockResolvedValue(autoPolicy),
        exitJourney: jest.fn().mockResolvedValue({
          journey: {},
          settlement: {
            status: StoreFlowSettlementStatus.ORDER_CREATED,
            blockedBy: 'PAYMENT_TERMINAL',
            order: { id: 'ord_1', orderNumber: 'ORD-1' },
            payment: null,
          },
        }),
      },
      repo: {
        findJourney: jest.fn().mockResolvedValue(
          journey({
            status: CustomerJourneyStatus.EXITED,
            orderId: 'ord_1',
            settlementStatus: StoreFlowSettlementStatus.ORDER_CREATED,
          }),
        ),
        findOrder: jest.fn().mockResolvedValue({
          orderNumber: 'ORD-1',
          totalMinor: 240,
          currencyCode: 'GBP',
          paymentStatus: OrderPaymentStatus.UNPAID,
        }),
      },
    });
    const view = await service.exit(HEADER);
    expect(view.settlement.status).toBe(
      StoreFlowSettlementStatus.ORDER_CREATED,
    );
    expect(view.settlement.blockedBy).toBe('PAYMENT_TERMINAL');
    expect(view.settlement.paymentStatus).toBe(OrderPaymentStatus.UNPAID);
  });

  it('is replay-safe: exiting twice calls the same idempotent Phase 26 exit', async () => {
    const { service, flow } = build();
    await service.exit(HEADER);
    await service.exit(HEADER);
    expect(flow.exitJourney).toHaveBeenCalledTimes(2);
    expect(flow.exitJourney).toHaveBeenNthCalledWith(
      2,
      'tenant_1',
      'journey_1',
      { id: 'user_1', email: 'operator@store.test' },
    );
  });
});
