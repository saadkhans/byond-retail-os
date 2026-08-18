import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  CustomerJourneyDecision,
  CustomerJourneyEventType,
  CustomerJourneyStatus,
  JourneyEventReviewDecision,
  Prisma,
} from '@prisma/client';
import {
  FoldReview,
  JourneyService,
  decideJourney,
  foldBasket,
  normalizeReviewReason,
  validateAggregateBasket,
} from './journey.service';

describe('normalizeReviewReason', () => {
  it('null, undefined, empty, and whitespace-only all normalize to null', () => {
    expect(normalizeReviewReason(null)).toBeNull();
    expect(normalizeReviewReason(undefined)).toBeNull();
    expect(normalizeReviewReason('')).toBeNull();
    expect(normalizeReviewReason('   ')).toBeNull();
  });

  it('trims surrounding whitespace and preserves the text', () => {
    expect(normalizeReviewReason('  keep this  ')).toBe('keep this');
  });

  it('caps at the 500-char storage bound', () => {
    expect(normalizeReviewReason('x'.repeat(600))).toHaveLength(500);
  });
});

const TENANT = 'tenant-1';

/** Fixed capture baseline for the mock video asset — fusion imports derive
 *  occurredAt from createdAt + evidence peakMs (v1 pipeline rule). */
const ASSET_CREATED_AT = new Date('2026-08-01T10:00:00.000Z');

type EventRow = {
  id: string;
  eventType: CustomerJourneyEventType;
  productId: string | null;
  sku: string | null;
  productName: string | null;
  quantity: number;
};

function event(
  eventType: CustomerJourneyEventType,
  productId: string | null = null,
  quantity = 1,
): EventRow {
  return {
    id: `e-${Math.abs(quantity)}-${eventType}-${productId ?? 'none'}`,
    eventType,
    productId,
    sku: productId ? `SKU-${productId}` : null,
    productName: productId ? `Product ${productId}` : null,
    quantity,
  };
}

let reviewSeq = 0;
function review(
  eventId: string,
  decision: JourneyEventReviewDecision,
  overrides: Partial<FoldReview> = {},
): FoldReview {
  reviewSeq += 1;
  return {
    id: `r-${reviewSeq}`,
    eventId,
    decision,
    correctedEventType: null,
    correctedProductId: null,
    correctedSku: null,
    correctedProductName: null,
    correctedQuantity: null,
    createdAt: new Date(2026, 0, 1, 0, 0, reviewSeq),
    ...overrides,
  };
}

describe('foldBasket (provisional basket = pure fold over events)', () => {
  it('accumulates pickups and subtracts returns per product', () => {
    const { basket, issues } = foldBasket([
      event(CustomerJourneyEventType.ENTRY),
      event(CustomerJourneyEventType.PRODUCT_PICKUP, 'a', 2),
      event(CustomerJourneyEventType.PRODUCT_PICKUP, 'b', 1),
      event(CustomerJourneyEventType.PRODUCT_RETURN, 'a', 1),
      event(CustomerJourneyEventType.EXIT),
    ]);
    expect(basket).toEqual([
      expect.objectContaining({ productId: 'a', quantity: 1 }),
      expect.objectContaining({ productId: 'b', quantity: 1 }),
    ]);
    expect(issues).toHaveLength(0);
  });

  it('flags REVIEW_REQUIRED events, unknown products, and returns without pickups', () => {
    const { basket, issues } = foldBasket([
      event(CustomerJourneyEventType.REVIEW_REQUIRED),
      event(CustomerJourneyEventType.PRODUCT_RETURN, 'x', 1),
    ]);
    expect(basket).toEqual([expect.objectContaining({ productId: 'x', quantity: -1 })]);
    const kinds = issues.map((issue) => issue.kind).sort();
    expect(kinds).toEqual(['NEGATIVE_QUANTITY', 'RETURN_WITHOUT_PICKUP', 'REVIEW_EVENT']);
  });

  it('drops fully-returned lines from the basket without losing the audit trail', () => {
    const { basket, issues } = foldBasket([
      event(CustomerJourneyEventType.PRODUCT_PICKUP, 'a', 1),
      event(CustomerJourneyEventType.PRODUCT_RETURN, 'a', 1),
    ]);
    expect(basket).toHaveLength(0);
    expect(issues).toHaveLength(0);
  });
});

describe('foldBasket with reviews (append-only corrections)', () => {
  it('REJECT removes the event contribution and raises no issue', () => {
    const pickup = event(CustomerJourneyEventType.PRODUCT_PICKUP, 'a', 2);
    const { basket, issues } = foldBasket(
      [pickup],
      [review(pickup.id, JourneyEventReviewDecision.REJECT)],
    );
    expect(basket).toHaveLength(0);
    expect(issues).toHaveLength(0);
  });

  it('APPROVE resolves a REVIEW_REQUIRED observation as a non-event', () => {
    const flagged = event(CustomerJourneyEventType.REVIEW_REQUIRED);
    const { basket, issues } = foldBasket(
      [flagged],
      [review(flagged.id, JourneyEventReviewDecision.APPROVE)],
    );
    expect(basket).toHaveLength(0);
    expect(issues).toHaveLength(0);
  });

  it('APPROVE keeps a product event counting as-is', () => {
    const pickup = event(CustomerJourneyEventType.PRODUCT_PICKUP, 'a', 2);
    const { basket } = foldBasket(
      [pickup],
      [review(pickup.id, JourneyEventReviewDecision.APPROVE)],
    );
    expect(basket).toEqual([
      expect.objectContaining({ productId: 'a', quantity: 2 }),
    ]);
  });

  it('CORRECT replaces product, quantity, and kind in the fold', () => {
    const flagged = event(CustomerJourneyEventType.REVIEW_REQUIRED);
    const { basket, issues } = foldBasket(
      [flagged],
      [
        review(flagged.id, JourneyEventReviewDecision.CORRECT, {
          correctedEventType: CustomerJourneyEventType.PRODUCT_PICKUP,
          correctedProductId: 'b',
          correctedSku: 'SKU-b',
          correctedProductName: 'Product b',
          correctedQuantity: 3,
        }),
      ],
    );
    expect(basket).toEqual([
      expect.objectContaining({ productId: 'b', sku: 'SKU-b', quantity: 3 }),
    ]);
    expect(issues).toHaveLength(0);
  });

  it('the LATEST review per event wins (append-only history, last decision rules)', () => {
    const pickup = event(CustomerJourneyEventType.PRODUCT_PICKUP, 'a', 1);
    const { basket } = foldBasket(
      [pickup],
      [
        review(pickup.id, JourneyEventReviewDecision.REJECT),
        review(pickup.id, JourneyEventReviewDecision.APPROVE),
      ],
    );
    expect(basket).toEqual([
      expect.objectContaining({ productId: 'a', quantity: 1 }),
    ]);
  });

  it('corrected events still surface fold-arithmetic issues (a correction fixes the observation, not the journey)', () => {
    const flagged = event(CustomerJourneyEventType.REVIEW_REQUIRED);
    const { issues } = foldBasket(
      [flagged],
      [
        review(flagged.id, JourneyEventReviewDecision.CORRECT, {
          correctedEventType: CustomerJourneyEventType.PRODUCT_RETURN,
          correctedProductId: 'b',
          correctedSku: 'SKU-b',
          correctedProductName: 'Product b',
          correctedQuantity: 1,
        }),
      ],
    );
    const kinds = issues.map((issue) => issue.kind).sort();
    expect(kinds).toEqual(['NEGATIVE_QUANTITY', 'RETURN_WITHOUT_PICKUP']);
  });
});

describe('validateAggregateBasket (pure aggregate stock check)', () => {
  const line = (productId: string, quantity: number) => ({
    productId,
    sku: `SKU-${productId}`,
    productName: `Product ${productId}`,
    quantity,
  });

  it('passes when every folded line fits the on-hand projection', () => {
    const result = validateAggregateBasket(
      [line('a', 1)],
      new Map([['a', 1]]),
    );
    expect(result).toEqual({ ok: true, reason: null });
  });

  it('fails when a folded quantity exceeds on-hand stock', () => {
    const result = validateAggregateBasket(
      [line('a', 2)],
      new Map([['a', 1]]),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('SKU-a');
    expect(result.reason).toContain('on-hand');
  });

  it('fails when the product has no inventory row at this location', () => {
    const result = validateAggregateBasket([line('a', 1)], new Map());
    expect(result.ok).toBe(false);
  });

  it('validates per SKU and names every shortfall', () => {
    const result = validateAggregateBasket(
      [line('a', 1), line('b', 3)],
      new Map([
        ['a', 5],
        ['b', 2],
      ]),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('SKU-b');
    expect(result.reason).not.toContain('SKU-a');
  });

  it('ignores non-positive lines and unknown-product lines (issues cover those)', () => {
    const result = validateAggregateBasket(
      [
        { productId: null, sku: null, productName: null, quantity: 4 },
        line('a', 0),
      ],
      new Map(),
    );
    expect(result.ok).toBe(true);
  });
});

describe('decideJourney (final shadow decision)', () => {
  it('clean journeys are READY_TO_SETTLE_SHADOW', () => {
    const { decision } = decideJourney([]);
    expect(decision).toBe(CustomerJourneyDecision.READY_TO_SETTLE_SHADOW);
  });

  it('unresolved event issues need event review', () => {
    const { decision } = decideJourney([
      { kind: 'REVIEW_EVENT', detail: 'x' },
      { kind: 'UNKNOWN_PRODUCT_EVENT', detail: 'y' },
    ]);
    expect(decision).toBe(CustomerJourneyDecision.NEEDS_EVENT_REVIEW);
  });

  it('journey-level inconsistencies outrank event issues', () => {
    const { decision, reason } = decideJourney([
      { kind: 'REVIEW_EVENT', detail: 'x' },
      { kind: 'RETURN_WITHOUT_PICKUP', detail: 'y' },
    ]);
    expect(decision).toBe(CustomerJourneyDecision.NEEDS_JOURNEY_REVIEW);
    expect(reason).toContain('1');
  });

  it('NEGATIVE_QUANTITY is journey-level', () => {
    const { decision } = decideJourney([
      { kind: 'NEGATIVE_QUANTITY', detail: 'x' },
    ]);
    expect(decision).toBe(CustomerJourneyDecision.NEEDS_JOURNEY_REVIEW);
  });
});

/**
 * The prisma mock exposes ONLY journey tables + read-only product/location
 * lookups — any attempt by the service to touch checkout sessions, orders,
 * payments, or inventory would throw immediately (shadow-mode guarantee).
 */
function buildService(overrides: {
  journeyStatus?: CustomerJourneyStatus;
  fusionRun?: Record<string, unknown> | null;
  /** The fusion-import video asset's store context (null = asset absent). */
  asset?: {
    locationId: string | null;
    unitId: string | null;
    createdAt?: Date;
  } | null;
  unit?: { id: string } | null;
  /** Per-product on-hand quantities for the aggregate stock check.
   *  undefined = plentiful stock for everything (999); a record = only
   *  the listed products have level rows, at the listed quantities. */
  stock?: Record<string, number>;
  /** The resolved reviewer row (null = unknown user id). undefined =
   *  a TENANT user of the journey's tenant. */
  reviewer?: {
    id: string;
    tenantId: string | null;
    userType: 'PLATFORM' | 'TENANT';
  } | null;
  /** Whether the journey's tenant is the VERIFIED platform sandbox
   *  (isPlatformSandbox marker). Default false — an ordinary customer
   *  tenant, on which platform reviewer attribution must be refused. */
  verifiedSandbox?: boolean;
  /** A live camera session that OWNS the journey (Codex P1 exit guard +
   *  review-first fence). status defaults to RUNNING when omitted.
   *  Default null — no live owner, generic exits allowed, no fence. */
  liveOwnerSession?: {
    id: string;
    status?: string;
    eventWindowsDetected?: number;
    errorCode?: string | null;
    finalizationMode?: string | null;
  } | null;
  /** A durable finalization intent row on the owning live session (the
   *  fence's last check). Default null. */
  liveIntent?: { id: string } | null;
} = {}) {
  const createdEvents: Record<string, unknown>[] = [];
  const createdReviews: Record<string, unknown>[] = [];
  const journeyRow = {
    id: 'j-1',
    tenantId: TENANT,
    locationId: 'store-1',
    unitId: null,
    status: overrides.journeyStatus ?? CustomerJourneyStatus.OPEN,
    decision: null as unknown,
    decisionReason: null as unknown,
    decidedAt: null as unknown,
    startedAt: new Date(),
    endedAt: null,
    events: [] as Record<string, unknown>[],
  };
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const prisma: any = {
    // Live-owned journey guard + review-first fence (Codex P1): the
    // generic-exit guard queries with a non-terminal status filter; the
    // reconcile fence queries with NO status filter. The stub honors an
    // `in` status predicate so a TERMINAL session row still fences the
    // decision while no longer blocking the generic exit. Default: no
    // live owner.
    liveCameraSession: {
      findFirst: jest.fn(
        async (args?: { where?: { status?: { in?: string[] } } }) => {
          const row = overrides.liveOwnerSession ?? null;
          if (!row) {
            return null;
          }
          const statusIn = args?.where?.status?.in;
          const rowStatus = (row as { status?: string }).status ?? 'RUNNING';
          if (statusIn && !statusIn.includes(rowStatus)) {
            return null;
          }
          return row;
        },
      ),
    },
    liveCameraSessionFinalizationIntent: {
      findFirst: jest.fn(async () => overrides.liveIntent ?? null),
    },
    location: { findFirst: jest.fn(async () => ({ id: 'store-1' })) },
    retailUnit: {
      findFirst: jest.fn(async () =>
        overrides.unit === undefined ? { id: 'unit-1' } : overrides.unit,
      ),
    },
    product: {
      findFirst: jest.fn(async () => ({ sku: 'SKU-A', name: 'Product A' })),
    },
    user: {
      // Honors the where clause so the service's tenant-scoped and
      // platform-scoped lookups behave like the real database: a global
      // `{ id }` query would match rows these selectors must not.
      findFirst: jest.fn(
        async (args: {
          where?: {
            id?: string;
            tenantId?: string | null;
            userType?: string;
          };
        }) => {
          const row =
            overrides.reviewer === undefined
              ? { id: 'user-1', tenantId: TENANT, userType: 'TENANT' }
              : overrides.reviewer;
          if (!row) {
            return null;
          }
          const where = args?.where ?? {};
          if (where.id !== undefined && row.id !== where.id) {
            return null;
          }
          if ('tenantId' in where && row.tenantId !== where.tenantId) {
            return null;
          }
          if (where.userType !== undefined && row.userType !== where.userType) {
            return null;
          }
          return row;
        },
      ),
    },
    tenant: {
      // The verified-sandbox identity check: only a row carrying the
      // isPlatformSandbox marker (and ACTIVE status) resolves.
      findFirst: jest.fn(
        async (args: {
          where?: { id?: string; isPlatformSandbox?: boolean };
        }) => {
          if (!overrides.verifiedSandbox) {
            return null;
          }
          const where = args?.where ?? {};
          if (where.id !== undefined && where.id !== TENANT) {
            return null;
          }
          if (where.isPlatformSandbox !== true) {
            return null;
          }
          return { id: TENANT };
        },
      ),
    },
    inventoryLevel: {
      // READ-ONLY on-hand projection for the aggregate basket check —
      // deliberately no create/update/delete methods: an inventory WRITE
      // from this module would throw immediately (shadow-mode guarantee).
      findFirst: jest.fn(
        async (args: { where?: { productId?: string } }) => {
          if (overrides.stock === undefined) {
            return { quantity: 999 };
          }
          const quantity = overrides.stock[args.where?.productId ?? ''];
          return quantity === undefined ? null : { quantity };
        },
      ),
    },
    videoAsset: {
      findFirst: jest.fn(async () =>
        overrides.asset === undefined
          ? { locationId: 'store-1', unitId: null, createdAt: ASSET_CREATED_AT }
          : overrides.asset,
      ),
    },
    customerJourney: {
      create: jest.fn(async () => journeyRow),
      findFirst: jest.fn(async () => journeyRow),
      update: jest.fn(async (args: { data: Record<string, unknown> }) => {
        Object.assign(journeyRow, args.data);
        return journeyRow;
      }),
      findMany: jest.fn(async () => []),
    },
    customerJourneyEvent: {
      create: jest.fn(async (args: { data: Record<string, unknown> }) => {
        const row = { id: `e-${createdEvents.length + 1}`, ...args.data };
        createdEvents.push(row);
        journeyRow.events.push(row);
        return row;
      }),
      findFirst: jest.fn(
        async (args: {
          where?: { id?: string; videoAssetId?: string; sourceType?: string };
        }) => {
          if (args.where?.id !== undefined) {
            return (
              journeyRow.events.find((row) => row.id === args.where?.id) ?? null
            );
          }
          return (
            journeyRow.events.find(
              (row) =>
                args.where?.videoAssetId !== undefined &&
                row.videoAssetId === args.where.videoAssetId &&
                (args.where.sourceType === undefined ||
                  row.sourceType === args.where.sourceType),
            ) ?? null
          );
        },
      ),
      findMany: jest.fn(async () => journeyRow.events),
    },
    customerJourneyEventReview: {
      create: jest.fn(async (args: { data: Record<string, unknown> }) => {
        const row = {
          id: `r-${createdReviews.length + 1}`,
          createdAt: new Date(2026, 0, 2, 0, 0, createdReviews.length),
          ...args.data,
        };
        createdReviews.push(row);
        return row;
      }),
      findFirst: jest.fn(
        async (args: {
          where?: { eventId?: string; idempotencyKey?: string };
        }) =>
          createdReviews.find(
            (row) =>
              args.where?.idempotencyKey !== undefined &&
              row.idempotencyKey === args.where.idempotencyKey &&
              row.eventId === args.where.eventId,
          ) ?? null,
      ),
      findMany: jest.fn(async () => createdReviews),
    },
    pickupFusionRun: {
      findFirst: jest.fn(async () => overrides.fusionRun ?? null),
      findMany: jest.fn(async () => []),
    },
    $queryRaw: jest.fn(async () => []),
  };
  // Interactive transaction: hand the same mock back as the tx client —
  // the service's advisory lock + open-check + writes all run through it.
  prisma.$transaction = jest.fn(
    async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
  );
  const audit = { record: jest.fn(async () => undefined) };
  /* eslint-enable @typescript-eslint/no-explicit-any */
  return {
    service: new JourneyService(prisma as never, audit as never),
    prisma,
    audit,
    createdEvents,
    createdReviews,
    journeyRow,
  };
}

describe('JourneyService', () => {
  it('create opens the journey with an ENTRY event', async () => {
    const { service, createdEvents } = buildService();
    await service.create(TENANT, { locationId: 'store-1' }, 'user-1');
    expect(createdEvents[0]).toMatchObject({
      eventType: CustomerJourneyEventType.ENTRY,
    });
  });

  it('create writes the journey and its ENTRY event in ONE transaction (atomic open)', async () => {
    const { service, prisma, journeyRow } = buildService();
    // Track whether each write ran inside the $transaction callback: a
    // journey insert that commits without its ENTRY event would leave an
    // OPEN journey that a retry then duplicates.
    let inTransaction = false;
    const writes: string[] = [];
    prisma.$transaction.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        inTransaction = true;
        try {
          return await fn(prisma);
        } finally {
          inTransaction = false;
        }
      },
    );
    prisma.customerJourney.create.mockImplementation(async () => {
      writes.push(inTransaction ? 'journey:tx' : 'journey:outside');
      return journeyRow;
    });
    prisma.customerJourneyEvent.create.mockImplementation(
      async (args: { data: Record<string, unknown> }) => {
        writes.push(inTransaction ? 'entry:tx' : 'entry:outside');
        return { id: 'e-1', ...args.data };
      },
    );
    await service.create(TENANT, { locationId: 'store-1' }, 'user-1');
    expect(writes).toEqual(['journey:tx', 'entry:tx']);
  });

  it('create rejects when the ENTRY insert fails (transaction rolls both writes back)', async () => {
    const { service, prisma } = buildService();
    prisma.customerJourneyEvent.create.mockRejectedValueOnce(
      new Error('ENTRY insert failed'),
    );
    await expect(
      service.create(TENANT, { locationId: 'store-1' }),
    ).rejects.toThrow('ENTRY insert failed');
  });

  it('append rejects on a closed journey (append-only stream stays coherent)', async () => {
    const { service } = buildService({
      journeyStatus: CustomerJourneyStatus.RECONCILED,
    });
    await expect(
      service.appendEvent(TENANT, 'j-1', {
        eventType: CustomerJourneyEventType.SHELF_INTERACTION,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('pickup/return events REQUIRE a product; unidentified goes to REVIEW_REQUIRED', async () => {
    const { service } = buildService();
    await expect(
      service.appendEvent(TENANT, 'j-1', {
        eventType: CustomerJourneyEventType.PRODUCT_PICKUP,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('exit reconciles CLEAN journeys to RECONCILED', async () => {
    const { service, journeyRow } = buildService();
    await service.appendEvent(TENANT, 'j-1', {
      eventType: CustomerJourneyEventType.PRODUCT_PICKUP,
      productId: 'prod-a',
    });
    await service.exit(TENANT, 'j-1');
    expect(journeyRow.status).toBe(CustomerJourneyStatus.RECONCILED);
  });

  it('generic exit on a journey OWNED by an active live session is a controlled 409 — the journey stays OPEN (Codex P1)', async () => {
    const { service, prisma, journeyRow } = buildService({
      liveOwnerSession: { id: 'live-1' },
    });
    await expect(service.exit(TENANT, 'j-1')).rejects.toThrow(
      /LIVE_JOURNEY_EXIT_REQUIRES_SESSION_FINALIZER/,
    );
    expect(journeyRow.status).toBe(CustomerJourneyStatus.OPEN);
    expect(journeyRow.decision).toBeNull();
    // Tenant-scoped, status-bounded ownership lookup.
    const call = prisma.liveCameraSession.findFirst.mock.calls[0][0] as {
      where: { tenantId: string; journeyId: string; status: { in: string[] } };
    };
    expect(call.where.tenantId).toBe(TENANT);
    expect(call.where.journeyId).toBe('j-1');
    expect(call.where.status.in).toEqual(
      expect.arrayContaining(['STARTING', 'RUNNING', 'STOPPING']),
    );
  });

  it('the live-session FINALIZER bypass still exits a live-owned journey', async () => {
    const { service, journeyRow } = buildService({
      liveOwnerSession: { id: 'live-1' },
    });
    await service.exit(TENANT, 'j-1', undefined, {
      viaLiveSessionFinalizer: true,
    });
    expect(journeyRow.status).toBe(CustomerJourneyStatus.RECONCILED);
  });

  it('REVIEW-FIRST FENCE: a live-owned journey with DETECTED work cannot commit READY even when the basket folds cleanly (Codex P1)', async () => {
    const { service, journeyRow } = buildService({
      liveOwnerSession: {
        id: 'live-1',
        status: 'STOPPING',
        eventWindowsDetected: 1,
      },
    });
    await service.appendEvent(TENANT, 'j-1', {
      eventType: CustomerJourneyEventType.PRODUCT_PICKUP,
      productId: 'prod-a',
    });
    await service.exit(TENANT, 'j-1', undefined, {
      viaLiveSessionFinalizer: true,
    });
    // The JOURNEY's own decision is review — not just a session copy.
    expect(journeyRow.decision).toBe(
      CustomerJourneyDecision.NEEDS_EVENT_REVIEW,
    );
    expect(journeyRow.decision).not.toBe(
      CustomerJourneyDecision.READY_TO_SETTLE_SHADOW,
    );
    expect(journeyRow.status).toBe(CustomerJourneyStatus.REVIEW_REQUIRED);
  });

  it('REVIEW-FIRST FENCE: a TERMINAL live session with a finalization error mode/code still fences the in-flight exit (timeout takeover race)', async () => {
    // The takeover stamped mode+code and terminalized the session; the
    // ORIGINAL exit, blocked until now, finally commits — the fence read
    // inside its deciding transaction must refuse READY.
    const { service, journeyRow } = buildService({
      liveOwnerSession: {
        id: 'live-1',
        status: 'ERROR',
        eventWindowsDetected: 0,
        errorCode: 'LIVE_WINDOW_DRAIN_TIMEOUT',
        finalizationMode: 'ERROR',
      },
    });
    await service.exit(TENANT, 'j-1', undefined, {
      viaLiveSessionFinalizer: true,
    });
    expect(journeyRow.decision).toBe(
      CustomerJourneyDecision.NEEDS_EVENT_REVIEW,
    );
    expect(journeyRow.decision).not.toBe(
      CustomerJourneyDecision.READY_TO_SETTLE_SHADOW,
    );
  });

  it('REVIEW-FIRST FENCE: any durable finalization intent on the owning live session forbids READY', async () => {
    const { service, journeyRow } = buildService({
      liveOwnerSession: { id: 'live-1', status: 'STOPPING' },
      liveIntent: { id: 'intent-1' },
    });
    await service.exit(TENANT, 'j-1', undefined, {
      viaLiveSessionFinalizer: true,
    });
    expect(journeyRow.decision).toBe(
      CustomerJourneyDecision.NEEDS_EVENT_REVIEW,
    );
  });

  it('REVIEW-FIRST FENCE: a genuinely clean zero-motion live session may still settle its empty journey', async () => {
    const { service, journeyRow } = buildService({
      liveOwnerSession: {
        id: 'live-1',
        status: 'STOPPING',
        eventWindowsDetected: 0,
        errorCode: null,
        finalizationMode: null,
      },
    });
    await service.exit(TENANT, 'j-1', undefined, {
      viaLiveSessionFinalizer: true,
    });
    expect(journeyRow.decision).toBe(
      CustomerJourneyDecision.READY_TO_SETTLE_SHADOW,
    );
    expect(journeyRow.status).toBe(CustomerJourneyStatus.RECONCILED);
  });

  it('exit scopes the status update by the id_tenantId composite key (tenant isolation at the write)', async () => {
    const { service, prisma } = buildService();
    await service.exit(TENANT, 'j-1');
    // The update must carry the composite unique key — id alone would let
    // a caller-supplied journey id address another tenant's row.
    expect(prisma.customerJourney.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id_tenantId: { id: 'j-1', tenantId: TENANT } },
      }),
    );
  });

  it('exit routes journeys with unresolved issues to REVIEW_REQUIRED', async () => {
    const { service, journeyRow } = buildService();
    await service.appendEvent(TENANT, 'j-1', {
      eventType: CustomerJourneyEventType.REVIEW_REQUIRED,
      note: 'unidentified pickup',
    });
    await service.exit(TENANT, 'j-1');
    expect(journeyRow.status).toBe(CustomerJourneyStatus.REVIEW_REQUIRED);
  });

  it('fusion-run import maps AUTO_PROPOSE to a product event and anything else to review', async () => {
    const autoRun = {
      id: 'run-1',
      policy: 'AUTO_PROPOSE',
      fusedTopScore: 0.51,
      fusedTopSku: 'SKU-A',
      evidence: {
        detector: { events: [{ kind: 'PICKUP' }] },
        fused: [{ productId: 'prod-a', sku: 'SKU-A', productName: 'Product A' }],
      },
    };
    const { service, createdEvents } = buildService({ fusionRun: autoRun });
    await service.appendFromFusionRun(TENANT, 'j-1', 'asset-1');
    expect(createdEvents[0]).toMatchObject({
      eventType: CustomerJourneyEventType.PRODUCT_PICKUP,
      productId: 'prod-a',
      sourceType: 'FUSION_SHADOW',
      fusionRunId: 'run-1',
    });

    const reviewRun = { ...autoRun, policy: 'NEEDS_HUMAN_REVIEW' };
    const second = buildService({ fusionRun: reviewRun });
    await second.service.appendFromFusionRun(TENANT, 'j-1', 'asset-1');
    expect(second.createdEvents[0]).toMatchObject({
      eventType: CustomerJourneyEventType.REVIEW_REQUIRED,
      sourceType: 'FUSION_SHADOW',
    });
  });

  it('fusion-run import stamps the SOURCE occurrence time (asset createdAt + evidence peakMs)', async () => {
    const autoRun = {
      id: 'run-1',
      policy: 'AUTO_PROPOSE',
      fusedTopScore: 0.51,
      fusedTopSku: 'SKU-A',
      evidence: {
        detector: { events: [{ kind: 'PICKUP', peakMs: 4500 }] },
        fused: [{ productId: 'prod-a', sku: 'SKU-A', productName: 'Product A' }],
      },
    };
    const { service, createdEvents } = buildService({ fusionRun: autoRun });
    await service.appendFromFusionRun(TENANT, 'j-1', 'asset-1');
    // Stamped at capture time, NOT import time — a clip imported hours
    // later must not fabricate chronology in the ordered basket fold.
    expect(createdEvents[0].occurredAt).toEqual(
      new Date(ASSET_CREATED_AT.getTime() + 4500),
    );
    // Review-path imports carry the same source timestamp.
    const review = buildService({
      fusionRun: { ...autoRun, policy: 'NEEDS_HUMAN_REVIEW' },
    });
    await review.service.appendFromFusionRun(TENANT, 'j-1', 'asset-1');
    expect(review.createdEvents[0].occurredAt).toEqual(
      new Date(ASSET_CREATED_AT.getTime() + 4500),
    );
  });

  it('fusion-run import falls back to append-time stamping when peakMs is missing', async () => {
    const before = Date.now();
    const { service, createdEvents } = buildService({
      fusionRun: {
        id: 'run-1',
        policy: 'AUTO_PROPOSE',
        fusedTopScore: 0.51,
        fusedTopSku: 'SKU-A',
        evidence: {
          detector: { events: [{ kind: 'PICKUP' }] },
          fused: [{ productId: 'prod-a', sku: 'SKU-A', productName: 'Product A' }],
        },
      },
    });
    await service.appendFromFusionRun(TENANT, 'j-1', 'asset-1');
    const occurredAt = createdEvents[0].occurredAt as Date;
    expect(occurredAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(occurredAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('fusion-run import is IDEMPOTENT: a retry replays instead of doubling the basket', async () => {
    const autoRun = {
      id: 'run-1',
      policy: 'AUTO_PROPOSE',
      fusedTopScore: 0.51,
      fusedTopSku: 'SKU-A',
      evidence: {
        detector: { events: [{ kind: 'PICKUP' }] },
        fused: [{ productId: 'prod-a', sku: 'SKU-A', productName: 'Product A' }],
      },
    };
    const { service, createdEvents } = buildService({ fusionRun: autoRun });
    await service.appendFromFusionRun(TENANT, 'j-1', 'asset-1');
    await service.appendFromFusionRun(TENANT, 'j-1', 'asset-1');
    expect(
      createdEvents.filter((row) => row.fusionRunId === 'run-1'),
    ).toHaveLength(1);
  });

  it('fusion-run dedup keys on the VIDEO, not the run id: a re-run cannot double-count', async () => {
    const runOf = (id: string) => ({
      id,
      policy: 'AUTO_PROPOSE',
      fusedTopScore: 0.51,
      fusedTopSku: 'SKU-A',
      evidence: {
        detector: { events: [{ kind: 'PICKUP' }] },
        fused: [{ productId: 'prod-a', sku: 'SKU-A', productName: 'Product A' }],
      },
    });
    const { service, prisma, createdEvents } = buildService({
      fusionRun: runOf('run-1'),
    });
    await service.appendFromFusionRun(TENANT, 'j-1', 'asset-1');
    // Fusion is re-run on the same video (a normal admin action), so the
    // LATEST run is now run-2: a repeated import resolves a FRESH run id
    // that a run-id-only dedup would wave through.
    prisma.pickupFusionRun.findFirst.mockResolvedValue(runOf('run-2'));
    await service.appendFromFusionRun(TENANT, 'j-1', 'asset-1');
    expect(
      createdEvents.filter((row) => row.videoAssetId === 'asset-1'),
    ).toHaveLength(1);
  });

  it('append rejects a note carrying payment- or credential-bearing content', async () => {
    const { service, createdEvents } = buildService();
    // A Luhn-valid PAN would otherwise persist verbatim and echo back on
    // every journey read — the AGENTS.md payments invariant.
    await expect(
      service.appendEvent(TENANT, 'j-1', {
        eventType: CustomerJourneyEventType.REVIEW_REQUIRED,
        note: 'shopper card 4242 4242 4242 4242 cvv=123',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    // Credential-bearing URLs reject too.
    await expect(
      service.appendEvent(TENANT, 'j-1', {
        eventType: CustomerJourneyEventType.REVIEW_REQUIRED,
        note: 'camera at rtsp://admin:hunter2@10.0.0.5/stream',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(createdEvents).toHaveLength(0);
  });

  it('append keeps benign notes (the screen rejects secrets, not prose)', async () => {
    const { service, createdEvents } = buildService();
    await service.appendEvent(TENANT, 'j-1', {
      eventType: CustomerJourneyEventType.REVIEW_REQUIRED,
      note: 'shopper picked up an unidentified bottle near aisle four',
    });
    expect(createdEvents[0]).toMatchObject({
      note: 'shopper picked up an unidentified bottle near aisle four',
    });
  });

  it("fusion-run import rejects a video from a different store context", async () => {
    const { service } = buildService({
      fusionRun: { id: 'run-1', policy: 'AUTO_PROPOSE', evidence: {} },
      asset: { locationId: 'store-OTHER', unitId: null },
    });
    await expect(
      service.appendFromFusionRun(TENANT, 'j-1', 'asset-1'),
    ).rejects.toBeInstanceOf(ConflictException);
    // An asset with NO location context cannot prove it matches either.
    const noContext = buildService({
      fusionRun: { id: 'run-1', policy: 'AUTO_PROPOSE', evidence: {} },
      asset: { locationId: null, unitId: null },
    });
    await expect(
      noContext.service.appendFromFusionRun(TENANT, 'j-1', 'asset-1'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('create validates a supplied unit within the tenant AND location', async () => {
    const { service, prisma } = buildService({ unit: null });
    await expect(
      service.create(TENANT, { locationId: 'store-1', unitId: 'unit-foreign' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.retailUnit.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: TENANT,
          id: 'unit-foreign',
          locationId: 'store-1',
        }),
      }),
    );
  });

  it('append re-checks OPEN inside the locked transaction (exit race cannot slip an event in)', async () => {
    const { service, prisma } = buildService();
    // The journey CLOSES between the caller's intent and the transaction:
    // the in-tx open check must reject the append.
    prisma.customerJourney.findFirst.mockResolvedValueOnce({
      id: 'j-1',
      tenantId: TENANT,
      locationId: 'store-1',
      unitId: null,
      status: CustomerJourneyStatus.RECONCILED,
      events: [],
    });
    await expect(
      service.appendEvent(TENANT, 'j-1', {
        eventType: CustomerJourneyEventType.SHELF_INTERACTION,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    // And the lock was actually taken before the check.
    expect(prisma.$queryRaw).toHaveBeenCalled();
  });

  it('exit persists the final SHADOW decision with its reason', async () => {
    const { service, journeyRow } = buildService();
    await service.appendEvent(TENANT, 'j-1', {
      eventType: CustomerJourneyEventType.PRODUCT_PICKUP,
      productId: 'prod-a',
    });
    await service.exit(TENANT, 'j-1');
    expect(journeyRow.status).toBe(CustomerJourneyStatus.RECONCILED);
    expect(journeyRow.decision).toBe(
      CustomerJourneyDecision.READY_TO_SETTLE_SHADOW,
    );
    expect(journeyRow.decisionReason).toEqual(expect.any(String));
    expect(journeyRow.decidedAt).toBeInstanceOf(Date);
  });

  it('exit decides NEEDS_EVENT_REVIEW for unresolved observations', async () => {
    const { service, journeyRow } = buildService();
    await service.appendEvent(TENANT, 'j-1', {
      eventType: CustomerJourneyEventType.REVIEW_REQUIRED,
    });
    await service.exit(TENANT, 'j-1');
    expect(journeyRow.status).toBe(CustomerJourneyStatus.REVIEW_REQUIRED);
    expect(journeyRow.decision).toBe(
      CustomerJourneyDecision.NEEDS_EVENT_REVIEW,
    );
  });

  it('exit decides NEEDS_JOURNEY_REVIEW for journey-level inconsistencies', async () => {
    const { service, journeyRow } = buildService();
    await service.appendEvent(TENANT, 'j-1', {
      eventType: CustomerJourneyEventType.PRODUCT_RETURN,
      productId: 'prod-a',
    });
    await service.exit(TENANT, 'j-1');
    expect(journeyRow.status).toBe(CustomerJourneyStatus.REVIEW_REQUIRED);
    expect(journeyRow.decision).toBe(
      CustomerJourneyDecision.NEEDS_JOURNEY_REVIEW,
    );
  });

  it('exit persists FAILED when reconciliation itself throws', async () => {
    const { service, prisma, journeyRow } = buildService();
    // The post-EXIT fold read blows up — the journey must not present a
    // half-computed basket as settled.
    prisma.customerJourneyEventReview.findMany.mockRejectedValueOnce(
      new Error('storage failure'),
    );
    await service.exit(TENANT, 'j-1');
    expect(journeyRow.status).toBe(CustomerJourneyStatus.REVIEW_REQUIRED);
    expect(journeyRow.decision).toBe(CustomerJourneyDecision.FAILED);
  });
});

describe('JourneyService.reviewEvent', () => {
  const ACTOR = { id: 'user-1', email: 'reviewer@example.com' };

  async function withPickupEvent(
    overrides: Parameters<typeof buildService>[0] = {},
  ) {
    const built = buildService(overrides);
    // Seed the observation directly so the journey status override applies
    // to the review, not the append.
    built.journeyRow.events.push({
      id: 'e-1',
      eventType: CustomerJourneyEventType.PRODUCT_PICKUP,
      productId: 'prod-a',
      sku: 'SKU-A',
      productName: 'Product A',
      quantity: 1,
    });
    return built;
  }

  it('rejects reviews on non-reviewable event types', async () => {
    const built = buildService();
    built.journeyRow.events.push({
      id: 'e-1',
      eventType: CustomerJourneyEventType.SHELF_INTERACTION,
      productId: null,
      sku: null,
      productName: null,
      quantity: 1,
    });
    await expect(
      built.service.reviewEvent(
        TENANT,
        'j-1',
        'e-1',
        { decision: JourneyEventReviewDecision.APPROVE },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  async function withLoneReturnEvent() {
    // A KNOWN-product return with no prior pickup: the fold flags
    // RETURN_WITHOUT_PICKUP anchored to this observation.
    const built = buildService();
    built.journeyRow.events.push({
      id: 'e-return',
      eventType: CustomerJourneyEventType.PRODUCT_RETURN,
      productId: 'prod-a',
      sku: 'SKU-A',
      productName: 'Product A',
      quantity: 1,
    });
    return built;
  }

  it('APPROVE on a known-product event implicated in a fold inconsistency is rejected (Codex P1)', async () => {
    const built = await withLoneReturnEvent();
    await expect(
      built.service.reviewEvent(
        TENANT,
        'j-1',
        'e-return',
        { decision: JourneyEventReviewDecision.APPROVE },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(built.createdReviews).toHaveLength(0);
    expect(built.audit.record).not.toHaveBeenCalled();
  });

  it('REJECT on the implicated event still lands (and resolves the fold)', async () => {
    const built = await withLoneReturnEvent();
    await built.service.reviewEvent(
      TENANT,
      'j-1',
      'e-return',
      { decision: JourneyEventReviewDecision.REJECT },
      ACTOR,
    );
    expect(built.createdReviews).toHaveLength(1);
    expect(built.createdReviews[0]).toMatchObject({
      decision: JourneyEventReviewDecision.REJECT,
    });
  });

  it('APPROVE on a CLEAN known-product event is still allowed', async () => {
    const built = await withPickupEvent();
    await built.service.reviewEvent(
      TENANT,
      'j-1',
      'e-1',
      { decision: JourneyEventReviewDecision.APPROVE },
      ACTOR,
    );
    expect(built.createdReviews).toHaveLength(1);
  });

  it('APPROVE on an unidentified product event is rejected (400, no review, no audit)', async () => {
    const built = buildService();
    built.journeyRow.events.push({
      id: 'e-unknown',
      eventType: CustomerJourneyEventType.PRODUCT_PICKUP,
      productId: null,
      sku: null,
      productName: null,
      quantity: 1,
    });
    await expect(
      built.service.reviewEvent(
        TENANT,
        'j-1',
        'e-unknown',
        { decision: JourneyEventReviewDecision.APPROVE },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(built.createdReviews).toHaveLength(0);
    expect(built.audit.record).not.toHaveBeenCalled();
  });

  it('REJECT and CORRECT stay available for unidentified product events', async () => {
    const built = buildService();
    built.journeyRow.events.push({
      id: 'e-unknown',
      eventType: CustomerJourneyEventType.PRODUCT_RETURN,
      productId: null,
      sku: null,
      productName: null,
      quantity: 1,
    });
    await built.service.reviewEvent(
      TENANT,
      'j-1',
      'e-unknown',
      { decision: JourneyEventReviewDecision.REJECT },
      ACTOR,
    );
    await built.service.reviewEvent(
      TENANT,
      'j-1',
      'e-unknown',
      {
        decision: JourneyEventReviewDecision.CORRECT,
        correctedEventType: CustomerJourneyEventType.PRODUCT_RETURN,
        correctedProductId: 'prod-a',
        correctedQuantity: 1,
      },
      ACTOR,
    );
    expect(built.createdReviews).toHaveLength(2);
  });

  it('APPROVE on a REVIEW_REQUIRED observation remains allowed (resolves as non-event)', async () => {
    const built = buildService();
    built.journeyRow.events.push({
      id: 'e-rr',
      eventType: CustomerJourneyEventType.REVIEW_REQUIRED,
      productId: null,
      sku: null,
      productName: null,
      quantity: 1,
    });
    await built.service.reviewEvent(
      TENANT,
      'j-1',
      'e-rr',
      { decision: JourneyEventReviewDecision.APPROVE },
      ACTOR,
    );
    expect(built.createdReviews).toHaveLength(1);
  });

  it('404s an event id that does not resolve within this tenant + journey', async () => {
    const built = await withPickupEvent();
    await expect(
      built.service.reviewEvent(
        TENANT,
        'j-1',
        'e-foreign',
        { decision: JourneyEventReviewDecision.APPROVE },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(built.createdReviews).toHaveLength(0);
  });

  it('CORRECT requires a product and an in-range quantity', async () => {
    const built = await withPickupEvent();
    await expect(
      built.service.reviewEvent(
        TENANT,
        'j-1',
        'e-1',
        { decision: JourneyEventReviewDecision.CORRECT },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      built.service.reviewEvent(
        TENANT,
        'j-1',
        'e-1',
        {
          decision: JourneyEventReviewDecision.CORRECT,
          correctedProductId: 'prod-a',
          correctedQuantity: 0,
        },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('APPROVE/REJECT must not smuggle corrected fields', async () => {
    const built = await withPickupEvent();
    await expect(
      built.service.reviewEvent(
        TENANT,
        'j-1',
        'e-1',
        {
          decision: JourneyEventReviewDecision.APPROVE,
          correctedProductId: 'prod-b',
        },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a reason carrying payment-bearing content', async () => {
    const built = await withPickupEvent();
    await expect(
      built.service.reviewEvent(
        TENANT,
        'j-1',
        'e-1',
        {
          decision: JourneyEventReviewDecision.REJECT,
          reason: 'shopper card 4242 4242 4242 4242',
        },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(built.createdReviews).toHaveLength(0);
  });

  it('CORRECT on a REVIEW_REQUIRED observation requires the corrected kind', async () => {
    const built = buildService();
    built.journeyRow.events.push({
      id: 'e-1',
      eventType: CustomerJourneyEventType.REVIEW_REQUIRED,
      productId: null,
      sku: null,
      productName: null,
      quantity: 1,
    });
    await expect(
      built.service.reviewEvent(
        TENANT,
        'j-1',
        'e-1',
        {
          decision: JourneyEventReviewDecision.CORRECT,
          correctedProductId: 'prod-a',
          correctedQuantity: 1,
        },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('writes the review AND its audit row in the SAME transaction, with the product snapshot', async () => {
    const built = await withPickupEvent();
    await built.service.reviewEvent(
      TENANT,
      'j-1',
      'e-1',
      {
        decision: JourneyEventReviewDecision.CORRECT,
        correctedProductId: 'prod-a',
        correctedQuantity: 2,
        reason: 'shopper took two',
      },
      ACTOR,
    );
    expect(built.createdReviews[0]).toMatchObject({
      decision: JourneyEventReviewDecision.CORRECT,
      correctedEventType: CustomerJourneyEventType.PRODUCT_PICKUP,
      correctedProductId: 'prod-a',
      correctedSku: 'SKU-A',
      correctedProductName: 'Product A',
      correctedQuantity: 2,
      reviewedById: ACTOR.id,
    });
    // The audit entry is handed the SAME transaction client the review
    // used — commit or roll back together (fail closed).
    expect(built.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'OVERRIDE',
        entityType: 'CustomerJourneyEvent',
        entityId: 'e-1',
        actorEmail: ACTOR.email,
      }),
      built.prisma,
    );
  });

  it('a review on a CLOSED journey re-settles the final decision in the same transaction', async () => {
    const built = buildService({
      journeyStatus: CustomerJourneyStatus.REVIEW_REQUIRED,
    });
    built.journeyRow.events.push({
      id: 'e-1',
      eventType: CustomerJourneyEventType.REVIEW_REQUIRED,
      productId: null,
      sku: null,
      productName: null,
      quantity: 1,
    });
    await built.service.reviewEvent(
      TENANT,
      'j-1',
      'e-1',
      { decision: JourneyEventReviewDecision.APPROVE },
      ACTOR,
    );
    expect(built.journeyRow.status).toBe(CustomerJourneyStatus.RECONCILED);
    expect(built.journeyRow.decision).toBe(
      CustomerJourneyDecision.READY_TO_SETTLE_SHADOW,
    );
  });

  it('a review on an OPEN journey records the decision for exit-time reconciliation only', async () => {
    const built = await withPickupEvent();
    await built.service.reviewEvent(
      TENANT,
      'j-1',
      'e-1',
      { decision: JourneyEventReviewDecision.APPROVE },
      ACTOR,
    );
    expect(built.createdReviews).toHaveLength(1);
    expect(built.journeyRow.decision).toBeNull();
  });

  it('resolves the reviewer within the tenant at the data-access boundary', async () => {
    const built = await withPickupEvent();
    await built.service.reviewEvent(
      TENANT,
      'j-1',
      'e-1',
      { decision: JourneyEventReviewDecision.APPROVE },
      ACTOR,
    );
    expect(built.prisma.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: ACTOR.id, tenantId: TENANT },
      }),
    );
    expect(built.createdReviews[0]).toMatchObject({ reviewedById: ACTOR.id });
  });

  it("rejects a reviewer belonging to ANOTHER tenant (attribution can't cross tenants)", async () => {
    const built = await withPickupEvent({
      reviewer: { id: 'user-1', tenantId: 'tenant-OTHER', userType: 'TENANT' },
    });
    await expect(
      built.service.reviewEvent(
        TENANT,
        'j-1',
        'e-1',
        { decision: JourneyEventReviewDecision.APPROVE },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(built.createdReviews).toHaveLength(0);
    expect(built.audit.record).not.toHaveBeenCalled();
  });

  it('rejects an unknown reviewer id', async () => {
    const built = await withPickupEvent({ reviewer: null });
    await expect(
      built.service.reviewEvent(
        TENANT,
        'j-1',
        'e-1',
        { decision: JourneyEventReviewDecision.APPROVE },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(built.createdReviews).toHaveLength(0);
  });

  it('accepts a PLATFORM reviewer ONLY on the VERIFIED platform sandbox tenant', async () => {
    const built = await withPickupEvent({
      reviewer: { id: 'user-1', tenantId: null, userType: 'PLATFORM' },
      verifiedSandbox: true,
    });
    await built.service.reviewEvent(
      TENANT,
      'j-1',
      'e-1',
      { decision: JourneyEventReviewDecision.APPROVE },
      ACTOR,
    );
    // The sandbox check is by the VERIFIED marker, never the slug alone.
    expect(built.prisma.tenant.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: TENANT,
          isPlatformSandbox: true,
        }),
      }),
    );
    expect(built.createdReviews[0]).toMatchObject({ reviewedById: 'user-1' });
  });

  it('REJECTS a PLATFORM reviewer on an ordinary customer tenant (no cross-tenant attribution)', async () => {
    const built = await withPickupEvent({
      reviewer: { id: 'user-1', tenantId: null, userType: 'PLATFORM' },
      verifiedSandbox: false,
    });
    await expect(
      built.service.reviewEvent(
        TENANT,
        'j-1',
        'e-1',
        { decision: JourneyEventReviewDecision.APPROVE },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    // Neither the review nor its audit row may ever land cross-tenant.
    expect(built.createdReviews).toHaveLength(0);
    expect(built.audit.record).not.toHaveBeenCalled();
  });
});

describe('JourneyService.reviewEvent idempotency (lost-response retries)', () => {
  const ACTOR = { id: 'user-1', email: 'reviewer@example.com' };
  const KEY = 'retry-key-12345678';

  async function withPickupEvent(
    overrides: Parameters<typeof buildService>[0] = {},
  ) {
    const built = buildService(overrides);
    built.journeyRow.events.push({
      id: 'e-1',
      eventType: CustomerJourneyEventType.PRODUCT_PICKUP,
      productId: 'prod-a',
      sku: 'SKU-A',
      productName: 'Product A',
      quantity: 1,
    });
    return built;
  }

  it('a retry with the same key and action REPLAYS: one review row, one audit record', async () => {
    const built = await withPickupEvent();
    const body = {
      decision: JourneyEventReviewDecision.APPROVE,
      idempotencyKey: KEY,
    };
    await built.service.reviewEvent(TENANT, 'j-1', 'e-1', body, ACTOR);
    await built.service.reviewEvent(TENANT, 'j-1', 'e-1', body, ACTOR);
    expect(built.createdReviews).toHaveLength(1);
    expect(built.audit.record).toHaveBeenCalledTimes(1);
    expect(built.createdReviews[0]).toMatchObject({ idempotencyKey: KEY });
  });

  it('the idempotency lookup is tenant-scoped', async () => {
    const built = await withPickupEvent();
    await built.service.reviewEvent(
      TENANT,
      'j-1',
      'e-1',
      { decision: JourneyEventReviewDecision.APPROVE, idempotencyKey: KEY },
      ACTOR,
    );
    expect(
      built.prisma.customerJourneyEventReview.findFirst,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: TENANT,
          eventId: 'e-1',
          idempotencyKey: KEY,
        }),
      }),
    );
  });

  it('the same key with a DIFFERENT action conflicts instead of silently replaying', async () => {
    const built = await withPickupEvent();
    await built.service.reviewEvent(
      TENANT,
      'j-1',
      'e-1',
      { decision: JourneyEventReviewDecision.APPROVE, idempotencyKey: KEY },
      ACTOR,
    );
    await expect(
      built.service.reviewEvent(
        TENANT,
        'j-1',
        'e-1',
        { decision: JourneyEventReviewDecision.REJECT, idempotencyKey: KEY },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(built.createdReviews).toHaveLength(1);
    expect(built.audit.record).toHaveBeenCalledTimes(1);
  });

  it('a retry with the same key, action, and reason replays with the audit reason unchanged', async () => {
    const built = await withPickupEvent();
    const body = {
      decision: JourneyEventReviewDecision.APPROVE,
      reason: 'shelf camera confirms the pickup',
      idempotencyKey: KEY,
    };
    await built.service.reviewEvent(TENANT, 'j-1', 'e-1', body, ACTOR);
    await built.service.reviewEvent(TENANT, 'j-1', 'e-1', { ...body }, ACTOR);
    expect(built.createdReviews).toHaveLength(1);
    expect(built.audit.record).toHaveBeenCalledTimes(1);
    expect(built.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'shelf camera confirms the pickup' }),
      expect.anything(),
    );
    expect(built.createdReviews[0]).toMatchObject({
      reason: 'shelf camera confirms the pickup',
    });
  });

  it('the same key with a DIFFERENT reason conflicts — the immutable reason is part of the action', async () => {
    const built = await withPickupEvent();
    await built.service.reviewEvent(
      TENANT,
      'j-1',
      'e-1',
      {
        decision: JourneyEventReviewDecision.APPROVE,
        reason: 'first reason',
        idempotencyKey: KEY,
      },
      ACTOR,
    );
    await expect(
      built.service.reviewEvent(
        TENANT,
        'j-1',
        'e-1',
        {
          decision: JourneyEventReviewDecision.APPROVE,
          reason: 'second, different reason',
          idempotencyKey: KEY,
        },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(built.createdReviews).toHaveLength(1);
    expect(built.audit.record).toHaveBeenCalledTimes(1);
    expect(built.createdReviews[0]).toMatchObject({ reason: 'first reason' });
  });

  it('reason matching is NORMALIZED: surrounding whitespace does not break a replay', async () => {
    const built = await withPickupEvent();
    await built.service.reviewEvent(
      TENANT,
      'j-1',
      'e-1',
      {
        decision: JourneyEventReviewDecision.APPROVE,
        reason: 'same reason',
        idempotencyKey: KEY,
      },
      ACTOR,
    );
    await built.service.reviewEvent(
      TENANT,
      'j-1',
      'e-1',
      {
        decision: JourneyEventReviewDecision.APPROVE,
        reason: '  same reason  ',
        idempotencyKey: KEY,
      },
      ACTOR,
    );
    expect(built.createdReviews).toHaveLength(1);
    expect(built.audit.record).toHaveBeenCalledTimes(1);
  });

  it('an absent reason and an empty/whitespace reason are the same fingerprint (both null)', async () => {
    const built = await withPickupEvent();
    await built.service.reviewEvent(
      TENANT,
      'j-1',
      'e-1',
      { decision: JourneyEventReviewDecision.APPROVE, idempotencyKey: KEY },
      ACTOR,
    );
    await built.service.reviewEvent(
      TENANT,
      'j-1',
      'e-1',
      {
        decision: JourneyEventReviewDecision.APPROVE,
        reason: '   ',
        idempotencyKey: KEY,
      },
      ACTOR,
    );
    expect(built.createdReviews).toHaveLength(1);
    expect(built.createdReviews[0]).toMatchObject({ reason: null });
  });

  it('keyless reviews stay plain append-only: two calls append two rows', async () => {
    const built = await withPickupEvent();
    const body = { decision: JourneyEventReviewDecision.APPROVE };
    await built.service.reviewEvent(TENANT, 'j-1', 'e-1', body, ACTOR);
    await built.service.reviewEvent(TENANT, 'j-1', 'e-1', body, ACTOR);
    expect(built.createdReviews).toHaveLength(2);
    expect(built.audit.record).toHaveBeenCalledTimes(2);
  });

  it('a P2002 race on the unique key re-reads OUTSIDE the aborted tx and replays', async () => {
    const built = await withPickupEvent();
    // Seed the winner's committed row, but make the in-tx pre-check miss
    // it (the loser read before the winner committed)...
    built.createdReviews.push({
      id: 'r-winner',
      eventId: 'e-1',
      decision: JourneyEventReviewDecision.APPROVE,
      correctedEventType: null,
      correctedProductId: null,
      correctedQuantity: null,
      idempotencyKey: KEY,
      createdAt: new Date(),
    });
    built.prisma.customerJourneyEventReview.findFirst.mockResolvedValueOnce(
      null,
    );
    // ...so the loser's insert hits the unique index.
    built.prisma.customerJourneyEventReview.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('unique violation', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    await built.service.reviewEvent(
      TENANT,
      'j-1',
      'e-1',
      { decision: JourneyEventReviewDecision.APPROVE, idempotencyKey: KEY },
      ACTOR,
    );
    // Replay: no second row beyond the winner's, and no loser audit record.
    expect(built.createdReviews).toHaveLength(1);
    expect(built.audit.record).not.toHaveBeenCalled();
  });
});

describe('JourneyService reconcile — aggregate basket vs on-hand stock', () => {
  it('one on-hand, one pickup: READY_TO_SETTLE_SHADOW stands', async () => {
    const built = buildService({ stock: { 'prod-a': 1 } });
    await built.service.appendEvent(TENANT, 'j-1', {
      eventType: CustomerJourneyEventType.PRODUCT_PICKUP,
      productId: 'prod-a',
    });
    await built.service.exit(TENANT, 'j-1');
    expect(built.journeyRow.decision).toBe(
      CustomerJourneyDecision.READY_TO_SETTLE_SHADOW,
    );
    expect(built.journeyRow.status).toBe(CustomerJourneyStatus.RECONCILED);
  });

  it('one on-hand, two pickups: the folded aggregate demotes to NEEDS_JOURNEY_REVIEW', async () => {
    const built = buildService({ stock: { 'prod-a': 1 } });
    await built.service.appendEvent(TENANT, 'j-1', {
      eventType: CustomerJourneyEventType.PRODUCT_PICKUP,
      productId: 'prod-a',
    });
    await built.service.appendEvent(TENANT, 'j-1', {
      eventType: CustomerJourneyEventType.PRODUCT_PICKUP,
      productId: 'prod-a',
    });
    await built.service.exit(TENANT, 'j-1');
    expect(built.journeyRow.decision).toBe(
      CustomerJourneyDecision.NEEDS_JOURNEY_REVIEW,
    );
    expect(built.journeyRow.status).toBe(
      CustomerJourneyStatus.REVIEW_REQUIRED,
    );
    expect(built.journeyRow.decisionReason).toContain('on-hand');
  });

  it('mixed SKUs validate per SKU: one fitting line cannot excuse another exceeding one', async () => {
    const built = buildService({ stock: { 'prod-a': 5 } });
    // prod-b has NO level row at this location.
    built.prisma.product.findFirst.mockImplementation(
      async (args: { where: { id: string } }) => ({
        sku: `SKU-${args.where.id}`,
        name: `Product ${args.where.id}`,
      }),
    );
    await built.service.appendEvent(TENANT, 'j-1', {
      eventType: CustomerJourneyEventType.PRODUCT_PICKUP,
      productId: 'prod-a',
    });
    await built.service.appendEvent(TENANT, 'j-1', {
      eventType: CustomerJourneyEventType.PRODUCT_PICKUP,
      productId: 'prod-b',
    });
    await built.service.exit(TENANT, 'j-1');
    expect(built.journeyRow.decision).toBe(
      CustomerJourneyDecision.NEEDS_JOURNEY_REVIEW,
    );
    expect(built.journeyRow.decisionReason).toContain('SKU-prod-b');
    expect(built.journeyRow.decisionReason).not.toContain('SKU-prod-a');
  });

  it('returns reduce the aggregate: pickup 2 + return 1 fits 1 on hand', async () => {
    const built = buildService({ stock: { 'prod-a': 1 } });
    await built.service.appendEvent(TENANT, 'j-1', {
      eventType: CustomerJourneyEventType.PRODUCT_PICKUP,
      productId: 'prod-a',
      quantity: 2,
    });
    await built.service.appendEvent(TENANT, 'j-1', {
      eventType: CustomerJourneyEventType.PRODUCT_RETURN,
      productId: 'prod-a',
      quantity: 1,
    });
    await built.service.exit(TENANT, 'j-1');
    expect(built.journeyRow.decision).toBe(
      CustomerJourneyDecision.READY_TO_SETTLE_SHADOW,
    );
  });

  it('a missing inventory row demotes (nothing on hand can satisfy the line)', async () => {
    const built = buildService({ stock: {} });
    await built.service.appendEvent(TENANT, 'j-1', {
      eventType: CustomerJourneyEventType.PRODUCT_PICKUP,
      productId: 'prod-a',
    });
    await built.service.exit(TENANT, 'j-1');
    expect(built.journeyRow.decision).toBe(
      CustomerJourneyDecision.NEEDS_JOURNEY_REVIEW,
    );
  });

  it('the on-hand lookup is READ-ONLY and scoped to tenant + store', async () => {
    const built = buildService({ stock: { 'prod-a': 1 } });
    await built.service.appendEvent(TENANT, 'j-1', {
      eventType: CustomerJourneyEventType.PRODUCT_PICKUP,
      productId: 'prod-a',
    });
    await built.service.exit(TENANT, 'j-1');
    expect(built.prisma.inventoryLevel.findFirst).toHaveBeenCalledWith({
      where: { tenantId: TENANT, locationId: 'store-1', productId: 'prod-a' },
      select: { quantity: true },
    });
    // The stub deliberately exposes NO write methods — reaching for one
    // would have thrown before this assertion.
  });
});

describe('JourneyService tenant scoping of nested reads', () => {
  it('detail() carries an explicit tenantId predicate on nested events AND reviews', async () => {
    const built = buildService();
    await built.service.detail(TENANT, 'j-1');
    expect(built.prisma.customerJourney.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: TENANT, id: 'j-1' },
        include: expect.objectContaining({
          events: expect.objectContaining({
            where: { tenantId: TENANT },
            include: expect.objectContaining({
              reviews: expect.objectContaining({
                where: { tenantId: TENANT },
              }),
            }),
          }),
        }),
      }),
    );
  });

  it('reconcile reads events and reviews with explicit tenant scope', async () => {
    const built = buildService();
    await built.service.exit(TENANT, 'j-1');
    expect(built.prisma.customerJourneyEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: TENANT, journeyId: 'j-1' }),
      }),
    );
    expect(
      built.prisma.customerJourneyEventReview.findMany,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: TENANT, journeyId: 'j-1' }),
      }),
    );
  });
});
