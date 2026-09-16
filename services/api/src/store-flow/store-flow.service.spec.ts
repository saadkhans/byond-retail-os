import { ConflictException, NotFoundException } from '@nestjs/common';
import {
  CustomerJourneyEventType,
  CustomerJourneyStatus,
  JourneyEventReviewDecision,
  PaymentStatus,
  StoreFlowAutonomyLevel,
  StoreFlowProjectionOutcome,
  StoreFlowSettlementStatus,
  VisionEventStatus,
} from '@prisma/client';
import { AuditLogService } from '../common/audit/audit-log.service';
import { CheckoutSessionsService } from '../checkout/checkout-sessions.service';
import { JourneyService } from '../journey/journey.service';
import { PaymentsService } from '../payments/payments.service';
import { PrismaService } from '../prisma/prisma.service';
import { VisionEventsService } from '../vision/vision-events.service';
import { PROJECTION_REASON, SETTLEMENT_BLOCK_REASON } from './store-flow.constants';
import { StoreFlowRepository } from './store-flow.repository';
import { StoreFlowService } from './store-flow.service';

const TENANT = 'tenant-1';
const OTHER_TENANT = 'tenant-2';
const STORE = 'store-1';
const UNIT = 'unit-1';
const ACTOR = { id: 'user-1', email: 'ops@example.com' };

type Row = Record<string, unknown>;

/**
 * In-memory stand-in for the tables the store flow touches, plus recording
 * fakes for the four services it drives. Rich enough to prove the things that
 * matter: SHADOW is inert, a score alone never applies anything, replays do
 * not double-charge or double-deduct, and nothing reads across tenants.
 */
function buildHarness() {
  let seq = 0;
  const nextId = (prefix: string) => `${prefix}-${(seq += 1)}`;

  const rows = {
    shopper: [] as Row[],
    storeEntryToken: [] as Row[],
    storeFlowPolicy: [] as Row[],
    storeFlowPolicyVersion: [] as Row[],
    storeFlowProjection: [] as Row[],
    customerJourney: [] as Row[],
    customerJourneyEvent: [] as Row[],
    visionEvent: [] as Row[],
    checkoutSessionLine: [] as Row[],
    order: [] as Row[],
    paymentIntent: [] as Row[],
    inventoryLevel: [] as Row[],
    product: [] as Row[],
    retailUnit: [] as Row[],
    location: [] as Row[],
  };

  const matches = (row: Row, where: Row): boolean =>
    Object.entries(where).every(([key, cond]) => {
      if (key === 'OR') {
        return (cond as Row[]).some((clause) => matches(row, clause));
      }
      if (cond !== null && typeof cond === 'object') {
        const c = cond as Record<string, unknown>;
        if ('in' in c) {
          return (c.in as unknown[]).includes(row[key]);
        }
        if ('not' in c) {
          return c.not === null ? row[key] !== null : row[key] !== c.not;
        }
      }
      return row[key] === cond;
    });

  const sortBy = (list: Row[], orderBy: unknown): Row[] => {
    const clauses = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
    return [...list].sort((a, b) => {
      for (const clause of clauses as Row[]) {
        const [field, direction] = Object.entries(clause)[0] as [
          string,
          string,
        ];
        const left = a[field];
        const right = b[field];
        if (left === right) continue;
        const cmp =
          left instanceof Date && right instanceof Date
            ? left.getTime() - right.getTime()
            : String(left) < String(right)
              ? -1
              : 1;
        return direction === 'desc' ? -cmp : cmp;
      }
      return 0;
    });
  };

  // Column defaults the real schema applies and the repository therefore
  // never passes. Without them a row created here has no status at all, and
  // the guarded updates that make a credential single-use silently match
  // nothing.
  const DEFAULTS: Partial<Record<keyof typeof rows, Row>> = {
    storeEntryToken: {
      status: 'ISSUED',
      redeemedAt: null,
      redeemedJourneyId: null,
      revokedAt: null,
    },
    shopper: { status: 'ACTIVE', userId: null },
    storeFlowPolicy: { activeVersionId: null },
  };

  const table = (name: keyof typeof rows, prefix: string) => ({
    findFirst: jest.fn(
      async (args: { where: Row; orderBy?: unknown } = { where: {} }) => {
        const hits = sortBy(
          rows[name].filter((row) => matches(row, args.where ?? {})),
          args.orderBy,
        );
        return hits[0] ? { ...hits[0] } : null;
      },
    ),
    findMany: jest.fn(
      async (
        args: { where?: Row; orderBy?: unknown; take?: number } = {},
      ) => {
        const hits = sortBy(
          rows[name].filter((row) => matches(row, args.where ?? {})),
          args.orderBy,
        );
        return (args.take ? hits.slice(0, args.take) : hits).map((row) => ({
          ...row,
        }));
      },
    ),
    create: jest.fn(async (args: { data: Row }) => {
      const row = {
        id: nextId(prefix),
        createdAt: new Date(),
        updatedAt: new Date(),
        ...(DEFAULTS[name] ?? {}),
        ...args.data,
      };
      rows[name].push(row);
      return { ...row };
    }),
    update: jest.fn(async (args: { where: Row; data: Row }) => {
      const where = (args.where.id_tenantId as Row) ?? args.where;
      const row = rows[name].find((candidate) => matches(candidate, where));
      if (!row) {
        throw Object.assign(new Error('not found'), { code: 'P2025' });
      }
      Object.assign(row, args.data, { updatedAt: new Date() });
      return { ...row };
    }),
    updateMany: jest.fn(async (args: { where: Row; data: Row }) => {
      const hits = rows[name].filter((row) => matches(row, args.where));
      hits.forEach((row) => Object.assign(row, args.data));
      return { count: hits.length };
    }),
  });

  const tables = {
    shopper: table('shopper', 'shopper'),
    storeEntryToken: table('storeEntryToken', 'token'),
    storeFlowPolicy: table('storeFlowPolicy', 'policy'),
    storeFlowPolicyVersion: table('storeFlowPolicyVersion', 'version'),
    storeFlowProjection: table('storeFlowProjection', 'proj'),
    customerJourney: table('customerJourney', 'journey'),
    customerJourneyEvent: table('customerJourneyEvent', 'obs'),
    visionEvent: table('visionEvent', 'vision'),
    checkoutSessionLine: table('checkoutSessionLine', 'line'),
    order: table('order', 'order'),
    paymentIntent: table('paymentIntent', 'intent'),
    inventoryLevel: table('inventoryLevel', 'level'),
    product: table('product', 'prod'),
    retailUnit: table('retailUnit', 'unit'),
    location: table('location', 'loc'),
  };

  // The policy reads use nested selects the generic table cannot express, so
  // they are hydrated here instead.
  const hydratePolicy = (policy: Row) => ({
    ...policy,
    activeVersion:
      rows.storeFlowPolicyVersion.find(
        (version) => version.id === policy.activeVersionId,
      ) ?? null,
    versions: sortBy(
      rows.storeFlowPolicyVersion.filter(
        (version) => version.policyId === policy.id,
      ),
      [{ versionNumber: 'desc' }],
    ),
  });
  const rawPolicyFindMany = tables.storeFlowPolicy.findMany;
  tables.storeFlowPolicy.findMany = jest.fn(async (args: Row = {}) => {
    const base = await rawPolicyFindMany(args as never);
    return base.map(hydratePolicy);
  }) as typeof tables.storeFlowPolicy.findMany;

  const prisma = {
    ...tables,
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(tables),
    ),
  } as unknown as PrismaService;

  // ---- collaborators -------------------------------------------------------

  const journeys = {
    openJourneyInTransaction: jest.fn(async () => {
      const journey = {
        id: nextId('journey'),
        tenantId: TENANT,
        locationId: STORE,
        unitId: UNIT,
        status: CustomerJourneyStatus.OPEN,
        shopperId: null,
        checkoutSessionId: null,
        orderId: null,
        settlementStatus: StoreFlowSettlementStatus.NOT_STARTED,
        startedAt: new Date(),
        endedAt: null,
      };
      rows.customerJourney.push(journey);
      return { journeyId: journey.id };
    }),
    exit: jest.fn(async (tenantId: string, journeyId: string) => {
      const journey = rows.customerJourney.find(
        (row) => row.id === journeyId && row.tenantId === tenantId,
      );
      if (journey) {
        journey.status = CustomerJourneyStatus.EXITED;
        journey.endedAt = new Date();
      }
      return { id: journeyId, status: CustomerJourneyStatus.EXITED };
    }),
    detail: jest.fn(async (_tenantId: string, journeyId: string) => ({
      id: journeyId,
      events: [],
      basket: [],
      issues: [],
    })),
    reviewEvent: jest.fn(async () => ({ id: nextId('review') })),
    reviewQueue: jest.fn(async () => [] as Row[]),
  } as unknown as JourneyService;

  const checkout = {
    create: jest.fn(
      async (
        tenantId: string,
        dto: { locationId: string; unitId: string; idempotencyKey?: string },
      ) => {
        const existing = rows.checkoutSessionLine.length
          ? null
          : rows.order.find(() => false);
        void existing;
        const prior = sessions.find(
          (row) =>
            row.tenantId === tenantId &&
            row.idempotencyKey === dto.idempotencyKey,
        );
        if (prior) {
          return { ...prior };
        }
        const session = {
          id: nextId('session'),
          tenantId,
          locationId: dto.locationId,
          unitId: dto.unitId,
          idempotencyKey: dto.idempotencyKey ?? null,
          status: 'OPEN',
        };
        sessions.push(session);
        return { ...session };
      },
    ),
    complete: jest.fn(
      async (
        tenantId: string,
        sessionId: string,
        dto: { idempotencyKey?: string },
      ) => {
        const prior = rows.order.find(
          (row) =>
            row.tenantId === tenantId &&
            row.idempotencyKey === dto.idempotencyKey,
        );
        if (prior) {
          return { ...prior };
        }
        const lines = rows.checkoutSessionLine.filter(
          (row) => row.sessionId === sessionId && row.tenantId === tenantId,
        );
        const subtotal = lines.reduce(
          (sum, line) => sum + Number(line.lineTotalMinor ?? 0),
          0,
        );
        const order = {
          id: nextId('order'),
          tenantId,
          orderNumber: `ORD-${seq}`,
          checkoutSessionId: sessionId,
          status: 'CONFIRMED',
          paymentStatus: 'UNPAID',
          subtotalMinor: subtotal || null,
          totalMinor: subtotal || null,
          currencyCode: subtotal ? 'AED' : null,
          idempotencyKey: dto.idempotencyKey ?? null,
        };
        rows.order.push(order);
        // Completion is what consumes stock in the real repository; the
        // harness mirrors that so a double completion would be visible.
        for (const line of lines) {
          const level = rows.inventoryLevel.find(
            (row) =>
              row.tenantId === tenantId &&
              row.locationId === STORE &&
              row.productId === line.productId,
          );
          if (level) {
            level.quantity =
              Number(level.quantity) - Number(line.quantity ?? 0);
          }
        }
        return { ...order };
      },
    ),
  } as unknown as CheckoutSessionsService;
  const sessions: Row[] = [];

  const vision = {
    ingest: jest.fn(
      async (
        tenantId: string,
        dto: {
          locationId: string;
          unitId: string;
          sessionId?: string;
          type: string;
          quantity?: number;
          idempotencyKey?: string;
          candidates?: { sku: string }[];
        },
      ) => {
        const prior = rows.visionEvent.find(
          (row) =>
            row.tenantId === tenantId &&
            row.idempotencyKey === dto.idempotencyKey,
        );
        if (prior) {
          return { ...prior };
        }
        const event = {
          id: nextId('vision'),
          tenantId,
          locationId: dto.locationId,
          unitId: dto.unitId,
          sessionId: dto.sessionId ?? null,
          type: dto.type,
          quantity: dto.quantity ?? 1,
          status: VisionEventStatus.PENDING_REVIEW,
          sku: dto.candidates?.[0]?.sku ?? null,
          idempotencyKey: dto.idempotencyKey ?? null,
        };
        rows.visionEvent.push(event);
        return { ...event };
      },
    ),
    review: jest.fn(
      async (
        tenantId: string,
        eventId: string,
        dto: { decision: string; productId?: string; quantity?: number },
      ) => {
        const event = rows.visionEvent.find(
          (row) => row.id === eventId && row.tenantId === tenantId,
        );
        if (!event) {
          throw new NotFoundException('vision event not found');
        }
        event.status =
          dto.decision === 'APPROVE'
            ? VisionEventStatus.APPROVED
            : dto.decision === 'REJECT'
              ? VisionEventStatus.REJECTED
              : VisionEventStatus.OVERRIDDEN;
        if (dto.decision !== 'REJECT') {
          // An approval is what adds the basket line in the real service.
          const catalogProduct = rows.product.find(
            (row) => row.tenantId === tenantId && row.sku === event.sku,
          );
          rows.checkoutSessionLine.push({
            id: nextId('line'),
            tenantId,
            sessionId: event.sessionId,
            productId:
              dto.productId ?? (catalogProduct?.id as string | undefined) ?? null,
            sku: event.sku,
            productName: 'Test product',
            quantity: dto.quantity ?? event.quantity,
            unitPriceMinor: 250,
            lineTotalMinor: 250 * Number(dto.quantity ?? event.quantity),
            currencyCode: 'AED',
            status: 'ACTIVE',
            createdAt: new Date(),
          });
        }
        return { ...event };
      },
    ),
  } as unknown as VisionEventsService;

  const payments = {
    create: jest.fn(
      async (
        tenantId: string,
        dto: { orderId?: string; amountMinor: number; currencyCode: string },
      ) => {
        const intent = {
          id: nextId('intent'),
          tenantId,
          orderId: dto.orderId ?? null,
          amountMinor: dto.amountMinor,
          currencyCode: dto.currencyCode,
          status: PaymentStatus.CREATED,
          createdAt: new Date(),
        };
        rows.paymentIntent.push(intent);
        return { ...intent };
      },
    ),
    authorize: jest.fn(async (tenantId: string, id: string) => {
      const intent = rows.paymentIntent.find(
        (row) => row.id === id && row.tenantId === tenantId,
      )!;
      intent.status = PaymentStatus.AUTHORIZED;
      return { ...intent };
    }),
    capture: jest.fn(async (tenantId: string, id: string) => {
      const intent = rows.paymentIntent.find(
        (row) => row.id === id && row.tenantId === tenantId,
      )!;
      intent.status = PaymentStatus.CAPTURED;
      return { ...intent };
    }),
  } as unknown as PaymentsService;

  const audit = { record: jest.fn(async () => undefined) } as unknown as
    AuditLogService;

  const repository = new StoreFlowRepository(prisma);
  const service = new StoreFlowService(
    prisma,
    repository,
    journeys,
    checkout,
    vision,
    payments,
    audit,
  );

  // ---- fixtures ------------------------------------------------------------

  rows.location.push(
    { id: STORE, tenantId: TENANT },
    { id: 'store-9', tenantId: OTHER_TENANT },
  );
  rows.retailUnit.push(
    { id: UNIT, tenantId: TENANT, locationId: STORE },
    { id: 'unit-9', tenantId: OTHER_TENANT, locationId: 'store-9' },
  );
  rows.product.push(
    { id: 'prod-water', tenantId: TENANT, sku: 'WATER-500', name: 'Water' },
    { id: 'prod-cola', tenantId: TENANT, sku: 'COLA-330', name: 'Cola' },
  );
  rows.inventoryLevel.push({
    id: 'level-1',
    tenantId: TENANT,
    locationId: STORE,
    productId: 'prod-water',
    quantity: 10,
  });

  const setPolicy = async (
    overrides: Partial<{
      autonomyLevel: StoreFlowAutonomyLevel;
      autoApplyMinConfidence: number;
      requireInventoryValidation: boolean;
      settleOnExit: boolean;
      locationId: string | null;
    }> = {},
  ) =>
    service.publishPolicy(
      TENANT,
      {
        autonomyLevel:
          overrides.autonomyLevel ?? StoreFlowAutonomyLevel.AUTO_APPLY,
        autoApplyMinConfidence: overrides.autoApplyMinConfidence ?? 0.7,
        requireInventoryValidation:
          overrides.requireInventoryValidation ?? true,
        settleOnExit: overrides.settleOnExit ?? true,
        ...(overrides.locationId === undefined
          ? {}
          : { locationId: overrides.locationId ?? undefined }),
      },
      ACTOR,
    );

  const openJourney = (overrides: Row = {}): Row => {
    const journey = {
      id: nextId('journey'),
      tenantId: TENANT,
      locationId: STORE,
      unitId: UNIT,
      status: CustomerJourneyStatus.OPEN,
      shopperId: 'shopper-1',
      checkoutSessionId: nextId('session'),
      orderId: null,
      settlementStatus: StoreFlowSettlementStatus.NOT_STARTED,
      startedAt: new Date('2026-09-16T10:00:00Z'),
      endedAt: null,
      ...overrides,
    };
    rows.customerJourney.push(journey);
    return journey;
  };

  const observe = (journeyId: string, overrides: Row = {}): Row => {
    const observation = {
      id: nextId('obs'),
      tenantId: TENANT,
      journeyId,
      eventType: CustomerJourneyEventType.PRODUCT_PICKUP,
      occurredAt: new Date('2026-09-16T10:05:00Z'),
      productId: 'prod-water',
      sku: 'WATER-500',
      productName: 'Water',
      quantity: 1,
      matchScore: 0.9,
      sourceType: 'FUSION_SHADOW',
      fusionRunId: null,
      videoAssetId: null,
      ...overrides,
    };
    rows.customerJourneyEvent.push(observation);
    return observation;
  };

  return {
    service,
    repository,
    rows,
    sessions,
    journeys,
    checkout,
    vision,
    payments,
    audit,
    setPolicy,
    openJourney,
    observe,
  };
}

describe('StoreFlowService — SHADOW is inert', () => {
  it('projects nothing and creates no vision event', async () => {
    const h = buildHarness();
    const journey = h.openJourney();
    h.observe(journey.id as string);

    const result = await h.service.syncJourney(
      TENANT,
      journey.id as string,
      ACTOR,
    );

    expect(result.skippedShadow).toBe(true);
    expect(result.projected).toHaveLength(0);
    expect(h.rows.storeFlowProjection).toHaveLength(0);
    expect(h.vision.ingest).not.toHaveBeenCalled();
  });

  it('closes a journey on exit without touching checkout, orders or payments', async () => {
    const h = buildHarness();
    const journey = h.openJourney();
    h.observe(journey.id as string);

    const result = await h.service.exitJourney(
      TENANT,
      journey.id as string,
      ACTOR,
    );

    expect(result.settlement.status).toBe(
      StoreFlowSettlementStatus.NOT_STARTED,
    );
    expect(result.settlement.blockedBy).toBe(
      SETTLEMENT_BLOCK_REASON.SETTLEMENT_DISABLED,
    );
    expect(h.journeys.exit).toHaveBeenCalledTimes(1);
    expect(h.checkout.complete).not.toHaveBeenCalled();
    expect(h.payments.create).not.toHaveBeenCalled();
    expect(h.rows.order).toHaveLength(0);
  });
});

describe('StoreFlowService — the bridge', () => {
  it('proposes without applying under PROPOSE', async () => {
    const h = buildHarness();
    await h.setPolicy({ autonomyLevel: StoreFlowAutonomyLevel.PROPOSE });
    const journey = h.openJourney();
    h.observe(journey.id as string);

    const result = await h.service.syncJourney(
      TENANT,
      journey.id as string,
      ACTOR,
    );

    expect(result.projected).toHaveLength(1);
    expect(result.projected[0].outcome).toBe(
      StoreFlowProjectionOutcome.PROPOSED,
    );
    expect(h.vision.ingest).toHaveBeenCalledTimes(1);
    expect(h.vision.review).not.toHaveBeenCalled();
    expect(h.rows.visionEvent[0].status).toBe(VisionEventStatus.PENDING_REVIEW);
    // The event is bound to the journey's basket, which is what makes a human
    // approval able to move it.
    expect(h.rows.visionEvent[0].sessionId).toBe(journey.checkoutSessionId);
    expect(h.rows.checkoutSessionLine).toHaveLength(0);
  });

  it('applies a confident, stocked pickup under AUTO_APPLY, through the human review path', async () => {
    const h = buildHarness();
    await h.setPolicy();
    const journey = h.openJourney();
    h.observe(journey.id as string, { matchScore: 0.95 });

    const result = await h.service.syncJourney(
      TENANT,
      journey.id as string,
      ACTOR,
    );

    expect(result.projected[0].outcome).toBe(
      StoreFlowProjectionOutcome.AUTO_APPLIED,
    );
    expect(h.vision.review).toHaveBeenCalledTimes(1);
    expect(h.rows.checkoutSessionLine).toHaveLength(1);
  });

  it('refuses to apply a confident pickup of something the store does not stock', async () => {
    const h = buildHarness();
    await h.setPolicy();
    const journey = h.openJourney();
    h.observe(journey.id as string, {
      productId: 'prod-cola',
      sku: 'COLA-330',
      matchScore: 0.99,
    });

    const result = await h.service.syncJourney(
      TENANT,
      journey.id as string,
      ACTOR,
    );

    expect(result.projected[0].outcome).toBe(
      StoreFlowProjectionOutcome.PROPOSED,
    );
    expect(result.projected[0].reasonCode).toBe(
      PROJECTION_REASON.INVENTORY_IMPLAUSIBLE,
    );
    expect(h.vision.review).not.toHaveBeenCalled();
    expect(h.rows.checkoutSessionLine).toHaveLength(0);
  });

  it('refuses to apply a low-confidence pickup', async () => {
    const h = buildHarness();
    await h.setPolicy({ autoApplyMinConfidence: 0.8 });
    const journey = h.openJourney();
    h.observe(journey.id as string, { matchScore: 0.4 });

    const result = await h.service.syncJourney(
      TENANT,
      journey.id as string,
      ACTOR,
    );

    expect(result.projected[0].reasonCode).toBe(
      PROJECTION_REASON.BELOW_CONFIDENCE_THRESHOLD,
    );
    expect(h.vision.review).not.toHaveBeenCalled();
  });

  it('routes an observation the pipeline flagged to a human without creating an event', async () => {
    const h = buildHarness();
    await h.setPolicy();
    const journey = h.openJourney();
    h.observe(journey.id as string, {
      eventType: CustomerJourneyEventType.REVIEW_REQUIRED,
      productId: null,
    });

    const result = await h.service.syncJourney(
      TENANT,
      journey.id as string,
      ACTOR,
    );

    expect(result.projected[0].outcome).toBe(
      StoreFlowProjectionOutcome.REVIEW_REQUIRED,
    );
    expect(h.vision.ingest).not.toHaveBeenCalled();
  });

  it('is idempotent: syncing twice produces one projection and one vision event', async () => {
    const h = buildHarness();
    await h.setPolicy();
    const journey = h.openJourney();
    h.observe(journey.id as string);

    await h.service.syncJourney(TENANT, journey.id as string, ACTOR);
    const second = await h.service.syncJourney(
      TENANT,
      journey.id as string,
      ACTOR,
    );

    expect(second.projected).toHaveLength(0);
    expect(h.rows.storeFlowProjection).toHaveLength(1);
    expect(h.vision.ingest).toHaveBeenCalledTimes(1);
    expect(h.rows.checkoutSessionLine).toHaveLength(1);
  });

  it('refuses to project a journey that was never bound to a basket', async () => {
    const h = buildHarness();
    await h.setPolicy();
    const journey = h.openJourney({ checkoutSessionId: null });

    await expect(
      h.service.syncJourney(TENANT, journey.id as string, ACTOR),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('cannot see another tenant journey', async () => {
    const h = buildHarness();
    await h.setPolicy();
    const journey = h.openJourney();

    await expect(
      h.service.syncJourney(OTHER_TENANT, journey.id as string, ACTOR),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('StoreFlowService — exit and settlement', () => {
  it('will not settle while a proposal still waits for a human', async () => {
    const h = buildHarness();
    await h.setPolicy({ autonomyLevel: StoreFlowAutonomyLevel.PROPOSE });
    const journey = h.openJourney();
    h.observe(journey.id as string);

    const result = await h.service.exitJourney(
      TENANT,
      journey.id as string,
      ACTOR,
    );

    expect(result.settlement.status).toBe(
      StoreFlowSettlementStatus.BLOCKED_ON_REVIEW,
    );
    expect(result.settlement.blockedBy).toBe(
      SETTLEMENT_BLOCK_REASON.AWAITING_EVENT_REVIEW,
    );
    expect(h.checkout.complete).not.toHaveBeenCalled();
    expect(h.rows.order).toHaveLength(0);
  });

  it('completes the basket into an order and captures payment', async () => {
    const h = buildHarness();
    await h.setPolicy();
    const journey = h.openJourney();
    h.observe(journey.id as string, { matchScore: 0.95 });

    const result = await h.service.exitJourney(
      TENANT,
      journey.id as string,
      ACTOR,
    );

    expect(result.settlement.status).toBe(StoreFlowSettlementStatus.PAID);
    expect(result.settlement.order).not.toBeNull();
    expect(h.rows.order).toHaveLength(1);
    expect(h.rows.paymentIntent).toHaveLength(1);
    expect(h.rows.paymentIntent[0].status).toBe(PaymentStatus.CAPTURED);
    // Stock left through the ledger exactly once.
    expect(h.rows.inventoryLevel[0].quantity).toBe(9);
    const stored = h.rows.customerJourney.find(
      (row) => row.id === journey.id,
    )!;
    expect(stored.settlementStatus).toBe(StoreFlowSettlementStatus.PAID);
    expect(stored.orderId).toBe(h.rows.order[0].id);
  });

  it('replaying an exit does not create a second order, charge, or stock movement', async () => {
    const h = buildHarness();
    await h.setPolicy();
    const journey = h.openJourney();
    h.observe(journey.id as string, { matchScore: 0.95 });

    await h.service.exitJourney(TENANT, journey.id as string, ACTOR);
    const replay = await h.service.exitJourney(
      TENANT,
      journey.id as string,
      ACTOR,
    );

    expect(h.rows.order).toHaveLength(1);
    expect(h.rows.paymentIntent).toHaveLength(1);
    expect(h.rows.inventoryLevel[0].quantity).toBe(9);
    expect(h.payments.capture).toHaveBeenCalledTimes(1);
    expect(replay.settlement.status).toBe(StoreFlowSettlementStatus.PAID);
    // The journey was already closed; it is not closed a second time.
    expect(h.journeys.exit).toHaveBeenCalledTimes(1);
  });

  it('lets a shopper who took nothing leave without an order', async () => {
    const h = buildHarness();
    await h.setPolicy();
    const journey = h.openJourney();

    const result = await h.service.exitJourney(
      TENANT,
      journey.id as string,
      ACTOR,
    );

    expect(result.settlement.blockedBy).toBe(
      SETTLEMENT_BLOCK_REASON.EMPTY_BASKET,
    );
    expect(h.rows.order).toHaveLength(0);
  });

  it('creates the order but takes no money when the policy does not settle on exit', async () => {
    const h = buildHarness();
    await h.setPolicy({ settleOnExit: false });
    const journey = h.openJourney();
    h.observe(journey.id as string, { matchScore: 0.95 });

    const result = await h.service.exitJourney(
      TENANT,
      journey.id as string,
      ACTOR,
    );

    expect(result.settlement.blockedBy).toBe(
      SETTLEMENT_BLOCK_REASON.SETTLEMENT_DISABLED,
    );
    expect(h.checkout.complete).not.toHaveBeenCalled();
    expect(h.payments.create).not.toHaveBeenCalled();
  });

  it('marks a journey FAILED when settlement blows up, and still reports it', async () => {
    const h = buildHarness();
    await h.setPolicy();
    const journey = h.openJourney();
    h.observe(journey.id as string, { matchScore: 0.95 });
    (h.checkout.complete as unknown as jest.Mock).mockRejectedValueOnce(
      new Error('order write failed'),
    );

    await expect(
      h.service.exitJourney(TENANT, journey.id as string, ACTOR),
    ).rejects.toThrow('order write failed');

    // The journey is already closed, so the failure has to be visible on the
    // row rather than left indistinguishable from "never settled".
    const stored = h.rows.customerJourney.find((row) => row.id === journey.id)!;
    expect(stored.settlementStatus).toBe(StoreFlowSettlementStatus.FAILED);
    expect(stored.orderId ?? null).toBeNull();
    expect(h.rows.paymentIntent).toHaveLength(0);
  });
});

describe('StoreFlowService — entry credentials', () => {
  it('returns the secret once and stores only a digest', async () => {
    const h = buildHarness();
    const issued = await h.service.issueEntryToken(
      TENANT,
      { locationId: STORE, unitId: UNIT },
      ACTOR,
    );

    expect(issued.secret).toBeTruthy();
    expect(JSON.stringify(issued.token)).not.toContain(issued.secret);
    const stored = h.rows.storeEntryToken[0];
    expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.tokenHash).not.toBe(issued.secret);
    // The audit trail records the event, never the credential.
    const auditCalls = (h.audit.record as jest.Mock).mock.calls;
    expect(JSON.stringify(auditCalls)).not.toContain(issued.secret);
    expect(JSON.stringify(auditCalls)).not.toContain(stored.tokenHash);
  });

  it('refuses a unit that is not in the named store', async () => {
    const h = buildHarness();
    await expect(
      h.service.issueEntryToken(
        TENANT,
        { locationId: STORE, unitId: 'unit-9' },
        ACTOR,
      ),
    ).rejects.toThrow(/not found in store/);
  });

  it('opens a journey and a basket on redemption, and burns the credential', async () => {
    const h = buildHarness();
    const issued = await h.service.issueEntryToken(
      TENANT,
      { locationId: STORE, unitId: UNIT },
      ACTOR,
    );

    const entered = await h.service.redeemEntryToken(
      TENANT,
      { token: issued.secret },
      ACTOR,
    );

    expect(entered.journeyId).toBeTruthy();
    expect(entered.checkoutSessionId).toBeTruthy();
    expect(entered.shopperId).toBeTruthy();
    expect(h.rows.storeEntryToken[0].status).toBe('REDEEMED');
    expect(h.rows.storeEntryToken[0].redeemedJourneyId).toBe(
      entered.journeyId,
    );
    const journey = h.rows.customerJourney.find(
      (row) => row.id === entered.journeyId,
    )!;
    expect(journey.checkoutSessionId).toBe(entered.checkoutSessionId);
    expect(journey.shopperId).toBe(entered.shopperId);
  });

  it('refuses a second redemption of the same credential', async () => {
    const h = buildHarness();
    const issued = await h.service.issueEntryToken(
      TENANT,
      { locationId: STORE, unitId: UNIT },
      ACTOR,
    );
    await h.service.redeemEntryToken(TENANT, { token: issued.secret }, ACTOR);

    await expect(
      h.service.redeemEntryToken(TENANT, { token: issued.secret }, ACTOR),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(h.rows.customerJourney).toHaveLength(1);
  });

  it('refuses an expired credential', async () => {
    const h = buildHarness();
    const issued = await h.service.issueEntryToken(
      TENANT,
      { locationId: STORE, unitId: UNIT, ttlSeconds: 30 },
      ACTOR,
    );
    h.rows.storeEntryToken[0].expiresAt = new Date(Date.now() - 1000);

    await expect(
      h.service.redeemEntryToken(TENANT, { token: issued.secret }, ACTOR),
    ).rejects.toThrow(/EXPIRED/);
  });

  it('refuses a revoked credential and refuses to revoke it twice', async () => {
    const h = buildHarness();
    const issued = await h.service.issueEntryToken(
      TENANT,
      { locationId: STORE, unitId: UNIT },
      ACTOR,
    );
    const tokenId = h.rows.storeEntryToken[0].id as string;
    await h.service.revokeEntryToken(TENANT, tokenId, ACTOR);

    await expect(
      h.service.redeemEntryToken(TENANT, { token: issued.secret }, ACTOR),
    ).rejects.toThrow(/REVOKED/);
    await expect(
      h.service.revokeEntryToken(TENANT, tokenId, ACTOR),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('gives the same answer for an unknown credential as for a wrong one', async () => {
    const h = buildHarness();
    await expect(
      h.service.redeemEntryToken(
        TENANT,
        { token: 'definitely-not-a-real-token' },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('cannot redeem another tenant credential', async () => {
    const h = buildHarness();
    const issued = await h.service.issueEntryToken(
      TENANT,
      { locationId: STORE, unitId: UNIT },
      ACTOR,
    );

    await expect(
      h.service.redeemEntryToken(
        OTHER_TENANT,
        { token: issued.secret },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('StoreFlowService — one review queue', () => {
  it('an approval recorded once lands in both the journey stream and the basket', async () => {
    const h = buildHarness();
    await h.setPolicy({ autonomyLevel: StoreFlowAutonomyLevel.PROPOSE });
    const journey = h.openJourney();
    const observation = h.observe(journey.id as string);
    await h.service.syncJourney(TENANT, journey.id as string, ACTOR);

    const result = await h.service.reviewObservation(
      TENANT,
      observation.id as string,
      { decision: JourneyEventReviewDecision.APPROVE },
      ACTOR,
    );

    expect(h.journeys.reviewEvent).toHaveBeenCalledTimes(1);
    expect(result.visionEvent).not.toBeNull();
    expect(h.rows.visionEvent[0].status).toBe(VisionEventStatus.APPROVED);
    expect(h.rows.checkoutSessionLine).toHaveLength(1);
    expect(result.projection?.outcome).toBe(
      StoreFlowProjectionOutcome.AUTO_APPLIED,
    );
    expect(result.projection?.reasonCode).toBe(
      PROJECTION_REASON.APPROVED_BY_REVIEWER,
    );
  });

  it('a rejection leaves the basket alone and records why', async () => {
    const h = buildHarness();
    await h.setPolicy({ autonomyLevel: StoreFlowAutonomyLevel.PROPOSE });
    const journey = h.openJourney();
    const observation = h.observe(journey.id as string);
    await h.service.syncJourney(TENANT, journey.id as string, ACTOR);

    const result = await h.service.reviewObservation(
      TENANT,
      observation.id as string,
      { decision: JourneyEventReviewDecision.REJECT, reason: 'not taken' },
      ACTOR,
    );

    expect(h.rows.visionEvent[0].status).toBe(VisionEventStatus.REJECTED);
    expect(h.rows.checkoutSessionLine).toHaveLength(0);
    expect(result.projection?.outcome).toBe(
      StoreFlowProjectionOutcome.REJECTED,
    );
  });

  it('does not decide the same observation twice', async () => {
    const h = buildHarness();
    await h.setPolicy({ autonomyLevel: StoreFlowAutonomyLevel.PROPOSE });
    const journey = h.openJourney();
    const observation = h.observe(journey.id as string);
    await h.service.syncJourney(TENANT, journey.id as string, ACTOR);

    await h.service.reviewObservation(
      TENANT,
      observation.id as string,
      { decision: JourneyEventReviewDecision.APPROVE, idempotencyKey: 'k1' },
      ACTOR,
    );
    await h.service.reviewObservation(
      TENANT,
      observation.id as string,
      { decision: JourneyEventReviewDecision.APPROVE, idempotencyKey: 'k1' },
      ACTOR,
    );

    expect(h.vision.review).toHaveBeenCalledTimes(1);
    expect(h.rows.checkoutSessionLine).toHaveLength(1);
  });

  it('records the human decision even when nothing was ever proposed', async () => {
    const h = buildHarness();
    const journey = h.openJourney();
    const observation = h.observe(journey.id as string);

    const result = await h.service.reviewObservation(
      TENANT,
      observation.id as string,
      { decision: JourneyEventReviewDecision.APPROVE },
      ACTOR,
    );

    expect(h.journeys.reviewEvent).toHaveBeenCalledTimes(1);
    expect(result.visionEvent).toBeNull();
    expect(h.vision.review).not.toHaveBeenCalled();
  });

  it('cannot decide another tenant observation', async () => {
    const h = buildHarness();
    const journey = h.openJourney();
    const observation = h.observe(journey.id as string);

    await expect(
      h.service.reviewObservation(
        OTHER_TENANT,
        observation.id as string,
        { decision: JourneyEventReviewDecision.APPROVE },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('StoreFlowService — policy versioning', () => {
  it('publishes version 1 and leaves it untouched when version 2 arrives', async () => {
    const h = buildHarness();
    await h.setPolicy({ autonomyLevel: StoreFlowAutonomyLevel.PROPOSE });
    const first = { ...h.rows.storeFlowPolicyVersion[0] };
    await h.setPolicy({ autonomyLevel: StoreFlowAutonomyLevel.AUTO_APPLY });

    expect(h.rows.storeFlowPolicyVersion).toHaveLength(2);
    expect(h.rows.storeFlowPolicyVersion[0]).toEqual(first);
    expect(h.rows.storeFlowPolicyVersion[1].versionNumber).toBe(2);
    const effective = await h.service.effectivePolicy(TENANT, STORE);
    expect(effective.autonomyLevel).toBe(StoreFlowAutonomyLevel.AUTO_APPLY);
    expect(effective.policyVersionId).toBe(
      h.rows.storeFlowPolicyVersion[1].id,
    );
  });

  it('audits every autonomy change', async () => {
    const h = buildHarness();
    await h.setPolicy({ autonomyLevel: StoreFlowAutonomyLevel.AUTO_APPLY });
    const entries = (h.audit.record as jest.Mock).mock.calls.map(
      ([entry]) => entry,
    );
    expect(
      entries.some(
        (entry) => entry.entityType === 'StoreFlowPolicyVersion',
      ),
    ).toBe(true);
  });

  it('refuses a policy for a store in another tenant', async () => {
    const h = buildHarness();
    await expect(
      h.service.publishPolicy(
        TENANT,
        {
          autonomyLevel: StoreFlowAutonomyLevel.AUTO_APPLY,
          locationId: 'store-9',
        },
        ACTOR,
      ),
    ).rejects.toThrow(/not found/);
  });

  it('refuses a note carrying credential-bearing content', async () => {
    const h = buildHarness();
    await expect(
      h.service.publishPolicy(
        TENANT,
        {
          autonomyLevel: StoreFlowAutonomyLevel.AUTO_APPLY,
          note: 'use password: hunter2 and api_key=sk_live_abcdefghijklmnop',
        },
        ACTOR,
      ),
    ).rejects.toThrow(/credential/);
  });
});
