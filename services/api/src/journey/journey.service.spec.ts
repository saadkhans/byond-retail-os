import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import {
  CustomerJourneyDecision,
  CustomerJourneyEventType,
  CustomerJourneyStatus,
  JourneyEventReviewDecision,
} from '@prisma/client';
import {
  FoldReview,
  JourneyService,
  decideJourney,
  foldBasket,
} from './journey.service';

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
    location: { findFirst: jest.fn(async () => ({ id: 'store-1' })) },
    retailUnit: {
      findFirst: jest.fn(async () =>
        overrides.unit === undefined ? { id: 'unit-1' } : overrides.unit,
      ),
    },
    product: {
      findFirst: jest.fn(async () => ({ sku: 'SKU-A', name: 'Product A' })),
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
});
