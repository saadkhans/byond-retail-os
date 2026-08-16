import {
  CustomerJourneyDecision,
  CustomerJourneyEventType,
  CustomerJourneyStatus,
  JourneyEventReviewDecision,
} from '@prisma/client';
import {
  JourneyService,
  REVIEW_QUEUE_JOURNEY_BATCH,
  REVIEW_QUEUE_MAX_ITEMS,
} from './journey.service';

const TENANT = 'tenant-1';

type ReviewRow = {
  id: string;
  eventId: string;
  decision: JourneyEventReviewDecision;
  correctedEventType: CustomerJourneyEventType | null;
  correctedProductId: string | null;
  correctedSku: string | null;
  correctedProductName: string | null;
  correctedQuantity: number | null;
  createdAt: Date;
};

type QueueEventRow = {
  id: string;
  tenantId: string;
  journeyId: string;
  eventType: CustomerJourneyEventType;
  occurredAt: Date;
  productId: string | null;
  sku: string | null;
  productName: string | null;
  quantity: number;
  matchScore: number | null;
  sourceType: string;
  videoAssetId: string | null;
  fusionRunId: string | null;
  reviews: ReviewRow[];
};

type JourneyRow = {
  id: string;
  status: CustomerJourneyStatus;
  decision: CustomerJourneyDecision | null;
  startedAt: Date;
};

function review(
  eventId: string,
  decision: JourneyEventReviewDecision,
): ReviewRow {
  return {
    id: `r-${eventId}-${decision}`,
    eventId,
    decision,
    correctedEventType: null,
    correctedProductId:
      decision === JourneyEventReviewDecision.CORRECT ? 'prod-x' : null,
    correctedSku:
      decision === JourneyEventReviewDecision.CORRECT ? 'SKU-X' : null,
    correctedProductName:
      decision === JourneyEventReviewDecision.CORRECT ? 'Product X' : null,
    correctedQuantity:
      decision === JourneyEventReviewDecision.CORRECT ? 1 : null,
    createdAt: new Date('2026-08-12T10:00:00.000Z'),
  };
}

function reviewRequiredEvent(
  id: string,
  overrides: Partial<QueueEventRow> = {},
): QueueEventRow {
  return {
    id,
    tenantId: TENANT,
    journeyId: 'j-1',
    eventType: CustomerJourneyEventType.REVIEW_REQUIRED,
    occurredAt: new Date('2026-08-10T10:00:00.000Z'),
    productId: null,
    sku: null,
    productName: null,
    quantity: 1,
    matchScore: 0.27,
    sourceType: 'FUSION_SHADOW',
    videoAssetId: 'asset-1',
    fusionRunId: 'run-1',
    reviews: [],
    ...overrides,
  };
}

/**
 * HONORING stub: the event query applies the OR-type filter, the
 * `reviews: { none: … }` unresolved predicate, ordering, and `take`
 * exactly the way the database would — so a test proving "resolved rows
 * cannot crowd out unresolved ones" exercises the real predicate shape,
 * not a post-fetch service filter. Every where clause is recorded so
 * tenant scoping is assertable per call site.
 */
function buildService(events: QueueEventRow[], journeys?: JourneyRow[]) {
  const journeyRows: JourneyRow[] =
    journeys ??
    [...new Set(events.map((event) => event.journeyId))].map((id) => ({
      id,
      status: CustomerJourneyStatus.REVIEW_REQUIRED,
      decision: CustomerJourneyDecision.NEEDS_EVENT_REVIEW,
      startedAt: new Date('2026-08-10T09:00:00.000Z'),
    }));
  const evidence = {
    vlm: {
      invoked: true,
      status: 'VERDICT',
      verdict: 'AMBIGUOUS',
      selectedSku: null,
      requiresHumanReview: true,
      reasonCodes: ['MULTIPLE_SIMILAR_CANDIDATES'],
      contradictions: [],
    },
    // Present in the STORED evidence — must never surface in the queue.
    ocr: { rawText: 'SECRET SHELF TEXT' },
    stages: [],
  };
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const prisma: any = {
    customerJourneyEvent: {
      findMany: jest.fn(async (args: any) => {
        let rows = events.filter((row) => row.tenantId === args.where.tenantId);
        if (args.where.journeyId?.in) {
          rows = rows.filter((row) =>
            args.where.journeyId.in.includes(row.journeyId),
          );
        }
        if (args.where.reviews?.none) {
          rows = rows.filter((row) => row.reviews.length === 0);
        }
        if (args.where.OR) {
          rows = rows.filter(
            (row) =>
              row.eventType === CustomerJourneyEventType.REVIEW_REQUIRED ||
              ((row.eventType === CustomerJourneyEventType.PRODUCT_PICKUP ||
                row.eventType === CustomerJourneyEventType.PRODUCT_RETURN) &&
                row.productId === null),
          );
        }
        rows = [...rows].sort(
          (a, b) => a.occurredAt.getTime() - b.occurredAt.getTime(),
        );
        if (args.take !== undefined) {
          rows = rows.slice(0, args.take);
        }
        return rows;
      }),
    },
    customerJourney: {
      findMany: jest.fn(async (args: any) => {
        let rows = [...journeyRows].sort(
          (a, b) =>
            a.startedAt.getTime() - b.startedAt.getTime() ||
            (a.id < b.id ? -1 : 1),
        );
        if (args.where.decision?.in) {
          rows = rows.filter(
            (row) =>
              row.decision !== null &&
              args.where.decision.in.includes(row.decision),
          );
        }
        if (args.where.id?.in) {
          rows = rows.filter((row) => args.where.id.in.includes(row.id));
        }
        // Honors skip/take paging like the real database — the issue scan
        // walks candidate journeys in batches (Codex P1: cap after issue
        // filtering, never before).
        if (args.skip !== undefined) {
          rows = rows.slice(args.skip);
        }
        if (args.take !== undefined) {
          rows = rows.slice(0, args.take);
        }
        return rows;
      }),
    },
    pickupFusionRun: {
      findMany: jest.fn(async (args: { where: { id: { in: string[] } } }) =>
        [...new Set(args.where.id.in)].map((id) => ({
          id,
          fusedTopSku: 'WATER-BOTTLE-500ML',
          fusedTopScore: 0.27,
          evidence,
        })),
      ),
    },
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const audit = { record: jest.fn() };
  return {
    service: new JourneyService(prisma as never, audit as never),
    prisma,
  };
}

describe('JourneyService.reviewQueue', () => {
  it('lists unresolved REVIEW_REQUIRED observations with run candidate + VLM summary', async () => {
    const { service } = buildService([reviewRequiredEvent('e-1')]);
    const items = await service.reviewQueue(TENANT);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      journeyId: 'j-1',
      journeyStatus: CustomerJourneyStatus.REVIEW_REQUIRED,
      journeyDecision: CustomerJourneyDecision.NEEDS_EVENT_REVIEW,
      eventId: 'e-1',
      eventType: CustomerJourneyEventType.REVIEW_REQUIRED,
      candidateSku: 'WATER-BOTTLE-500ML',
      fusedTopScore: 0.27,
      vlm: {
        status: 'VERDICT',
        verdict: 'AMBIGUOUS',
        selectedSku: null,
        requiresHumanReview: true,
      },
      reason: 'REVIEW_REQUIRED observation',
      latestReview: null,
    });
  });

  it('the unresolved predicate is IN THE QUERY (reviews: none), tenant-scoped, before take', async () => {
    const { service, prisma } = buildService([reviewRequiredEvent('e-1')]);
    await service.reviewQueue(TENANT);
    const args = prisma.customerJourneyEvent.findMany.mock.calls[0][0];
    expect(args.where.reviews).toEqual({ none: { tenantId: TENANT } });
    expect(args.take).toBe(REVIEW_QUEUE_MAX_ITEMS);
  });

  it('a page-bound backlog of OLDER resolved events cannot hide a newer unresolved one', async () => {
    const resolved = Array.from(
      { length: REVIEW_QUEUE_MAX_ITEMS * 3 + 10 },
      (_, i) =>
        reviewRequiredEvent(`e-resolved-${i}`, {
          occurredAt: new Date(Date.UTC(2026, 7, 1, 0, 0, i)),
          reviews: [
            review(`e-resolved-${i}`, JourneyEventReviewDecision.REJECT),
          ],
        }),
    );
    const newest = reviewRequiredEvent('e-newest-unresolved', {
      occurredAt: new Date('2026-08-11T10:00:00.000Z'),
    });
    const { service } = buildService([...resolved, newest]);
    const items = await service.reviewQueue(TENANT);
    expect(items.map((item) => item.eventId)).toEqual(['e-newest-unresolved']);
  });

  it('an event with a landed review drops out of the queue', async () => {
    const { service } = buildService([
      reviewRequiredEvent('e-reviewed', {
        reviews: [review('e-reviewed', JourneyEventReviewDecision.REJECT)],
      }),
      reviewRequiredEvent('e-open'),
    ]);
    const items = await service.reviewQueue(TENANT);
    expect(items.map((item) => item.eventId)).toEqual(['e-open']);
  });

  it('every read carries an explicit tenantId — root, nested reviews, journeys, runs', async () => {
    const { service, prisma } = buildService([reviewRequiredEvent('e-1')]);
    await service.reviewQueue(TENANT);
    for (const call of prisma.customerJourneyEvent.findMany.mock.calls) {
      expect(call[0].where.tenantId).toBe(TENANT);
      expect(call[0].include.reviews.where).toEqual({ tenantId: TENANT });
    }
    for (const call of prisma.customerJourney.findMany.mock.calls) {
      expect(call[0].where.tenantId).toBe(TENANT);
    }
    expect(
      prisma.pickupFusionRun.findMany.mock.calls[0][0].where.tenantId,
    ).toBe(TENANT);
  });

  it('never leaks evidence internals (rawPreview / errorDetail / OCR text)', async () => {
    const { service } = buildService([reviewRequiredEvent('e-1')]);
    const items = await service.reviewQueue(TENANT);
    const serialized = JSON.stringify(items);
    expect(serialized).not.toContain('rawPreview');
    expect(serialized).not.toContain('errorDetail');
    expect(serialized).not.toContain('SECRET SHELF TEXT');
  });

  it('a product event with no identified product queues as unknown product', async () => {
    const { service } = buildService([
      reviewRequiredEvent('e-unknown', {
        eventType: CustomerJourneyEventType.PRODUCT_PICKUP,
        productId: null,
        fusionRunId: null,
        videoAssetId: null,
        sku: null,
      }),
    ]);
    const items = await service.reviewQueue(TENANT);
    expect(items[0]).toMatchObject({
      eventId: 'e-unknown',
      reason: 'unknown product',
      candidateSku: null,
    });
  });

  it('a KNOWN-product return without pickup queues via the journey fold issue', async () => {
    const returnEvent = reviewRequiredEvent('e-return', {
      eventType: CustomerJourneyEventType.PRODUCT_RETURN,
      productId: 'prod-a',
      sku: 'SKU-A',
      productName: 'Product A',
      fusionRunId: null,
      videoAssetId: null,
    });
    const { service } = buildService(
      [returnEvent],
      [
        {
          id: 'j-1',
          status: CustomerJourneyStatus.REVIEW_REQUIRED,
          decision: CustomerJourneyDecision.NEEDS_JOURNEY_REVIEW,
          startedAt: new Date('2026-08-10T09:00:00.000Z'),
        },
      ],
    );
    const items = await service.reviewQueue(TENANT);
    expect(items.map((item) => item.eventId)).toEqual(['e-return']);
    expect(items[0].reason).toBe('RETURN_WITHOUT_PICKUP');
  });

  it('a NEGATIVE_QUANTITY over-return queues anchored to the offending return event', async () => {
    const pickup = reviewRequiredEvent('e-pickup', {
      eventType: CustomerJourneyEventType.PRODUCT_PICKUP,
      productId: 'prod-a',
      sku: 'SKU-A',
      productName: 'Product A',
      occurredAt: new Date('2026-08-10T10:00:00.000Z'),
      fusionRunId: null,
      videoAssetId: null,
    });
    const overReturn = reviewRequiredEvent('e-over-return', {
      eventType: CustomerJourneyEventType.PRODUCT_RETURN,
      productId: 'prod-a',
      sku: 'SKU-A',
      productName: 'Product A',
      quantity: 2,
      occurredAt: new Date('2026-08-10T10:05:00.000Z'),
      fusionRunId: null,
      videoAssetId: null,
    });
    const { service } = buildService(
      [pickup, overReturn],
      [
        {
          id: 'j-1',
          status: CustomerJourneyStatus.REVIEW_REQUIRED,
          decision: CustomerJourneyDecision.NEEDS_JOURNEY_REVIEW,
          startedAt: new Date('2026-08-10T09:00:00.000Z'),
        },
      ],
    );
    const items = await service.reviewQueue(TENANT);
    expect(items.map((item) => item.eventId)).toEqual(['e-over-return']);
    expect(items[0].reason).toBe('NEGATIVE_QUANTITY');
  });

  it('an APPROVEd known-product inconsistency STAYS queued — fold decides, not review existence (Codex P1)', async () => {
    const returnEvent = reviewRequiredEvent('e-return', {
      eventType: CustomerJourneyEventType.PRODUCT_RETURN,
      productId: 'prod-a',
      sku: 'SKU-A',
      productName: 'Product A',
      fusionRunId: null,
      videoAssetId: null,
      // Historical APPROVE: changes nothing in the fold — the issue
      // persists, so the row must remain visible to reviewers.
      reviews: [review('e-return', JourneyEventReviewDecision.APPROVE)],
    });
    const { service } = buildService(
      [returnEvent],
      [
        {
          id: 'j-1',
          status: CustomerJourneyStatus.REVIEW_REQUIRED,
          decision: CustomerJourneyDecision.NEEDS_JOURNEY_REVIEW,
          startedAt: new Date('2026-08-10T09:00:00.000Z'),
        },
      ],
    );
    const items = await service.reviewQueue(TENANT);
    expect(items.map((item) => item.eventId)).toEqual(['e-return']);
    expect(items[0].reason).toBe('RETURN_WITHOUT_PICKUP');
    expect(items[0].latestReview).toMatchObject({
      decision: JourneyEventReviewDecision.APPROVE,
    });
  });

  it('a CORRECT that fixes the arithmetic removes the issue row (fold resolves)', async () => {
    const pickup = reviewRequiredEvent('e-pickup', {
      eventType: CustomerJourneyEventType.PRODUCT_PICKUP,
      productId: 'prod-a',
      sku: 'SKU-A',
      productName: 'Product A',
      occurredAt: new Date('2026-08-10T10:00:00.000Z'),
      fusionRunId: null,
      videoAssetId: null,
    });
    const overReturn = reviewRequiredEvent('e-over-return', {
      eventType: CustomerJourneyEventType.PRODUCT_RETURN,
      productId: 'prod-a',
      sku: 'SKU-A',
      productName: 'Product A',
      quantity: 2,
      occurredAt: new Date('2026-08-10T10:05:00.000Z'),
      fusionRunId: null,
      videoAssetId: null,
      // Reviewer corrected the over-return down to the single unit that
      // was actually put back: pickup 1 − corrected return 1 = 0.
      reviews: [
        {
          id: 'r-correct-qty',
          eventId: 'e-over-return',
          decision: JourneyEventReviewDecision.CORRECT,
          correctedEventType: null,
          correctedProductId: 'prod-a',
          correctedSku: 'SKU-A',
          correctedProductName: 'Product A',
          correctedQuantity: 1,
          createdAt: new Date('2026-08-12T10:00:00.000Z'),
        },
      ],
    });
    const { service } = buildService(
      [pickup, overReturn],
      [
        {
          id: 'j-1',
          status: CustomerJourneyStatus.REVIEW_REQUIRED,
          decision: CustomerJourneyDecision.NEEDS_JOURNEY_REVIEW,
          startedAt: new Date('2026-08-10T09:00:00.000Z'),
        },
      ],
    );
    const items = await service.reviewQueue(TENANT);
    expect(items).toHaveLength(0);
  });

  it('300+ older non-queueable review journeys do not hide a newer fold issue (paged scan, Codex P1)', async () => {
    const journeys: JourneyRow[] = [];
    const events: QueueEventRow[] = [];
    for (let i = 0; i < 310; i++) {
      const journeyId = `j-old-${String(i).padStart(3, '0')}`;
      journeys.push({
        id: journeyId,
        status: CustomerJourneyStatus.REVIEW_REQUIRED,
        decision: CustomerJourneyDecision.NEEDS_EVENT_REVIEW,
        startedAt: new Date(Date.UTC(2026, 7, 1, 0, 0, i)),
      });
      // Handled observation: REJECTed REVIEW_REQUIRED — excluded from the
      // direct pass (has a review) AND raises no fold issue. The journey
      // is a review-decision journey with NOTHING queueable.
      events.push(
        reviewRequiredEvent(`e-old-${String(i).padStart(3, '0')}`, {
          journeyId,
          occurredAt: new Date(Date.UTC(2026, 7, 1, 0, 0, i)),
          reviews: [
            review(
              `e-old-${String(i).padStart(3, '0')}`,
              JourneyEventReviewDecision.REJECT,
            ),
          ],
        }),
      );
    }
    journeys.push({
      id: 'j-new',
      status: CustomerJourneyStatus.REVIEW_REQUIRED,
      decision: CustomerJourneyDecision.NEEDS_JOURNEY_REVIEW,
      startedAt: new Date('2026-08-15T09:00:00.000Z'),
    });
    events.push(
      reviewRequiredEvent('e-new-return', {
        journeyId: 'j-new',
        eventType: CustomerJourneyEventType.PRODUCT_RETURN,
        productId: 'prod-a',
        sku: 'SKU-A',
        productName: 'Product A',
        occurredAt: new Date('2026-08-15T10:00:00.000Z'),
        fusionRunId: null,
        videoAssetId: null,
      }),
    );
    const { service, prisma } = buildService(events, journeys);
    const items = await service.reviewQueue(TENANT);
    expect(items.map((item) => item.eventId)).toEqual(['e-new-return']);
    expect(items[0].reason).toBe('RETURN_WITHOUT_PICKUP');
    // The scan really paged: candidate journeys were fetched in batches,
    // never in one capped gulp.
    const pagedCalls = prisma.customerJourney.findMany.mock.calls.filter(
      (
        call: {
          where: { tenantId?: string; decision?: { in?: unknown } };
          take?: number;
        }[],
      ) => call[0].where.decision?.in,
    );
    expect(pagedCalls.length).toBeGreaterThan(1);
    for (const call of pagedCalls) {
      expect(call[0].take).toBe(REVIEW_QUEUE_JOURNEY_BATCH);
      expect(call[0].where.tenantId).toBe(TENANT);
    }
  });

  it('a REJECTed issue event leaves the queue (fold no longer raises it)', async () => {
    const returnEvent = reviewRequiredEvent('e-return', {
      eventType: CustomerJourneyEventType.PRODUCT_RETURN,
      productId: 'prod-a',
      sku: 'SKU-A',
      productName: 'Product A',
      fusionRunId: null,
      videoAssetId: null,
      reviews: [review('e-return', JourneyEventReviewDecision.REJECT)],
    });
    const { service } = buildService(
      [returnEvent],
      [
        {
          id: 'j-1',
          status: CustomerJourneyStatus.REVIEW_REQUIRED,
          decision: CustomerJourneyDecision.NEEDS_JOURNEY_REVIEW,
          startedAt: new Date('2026-08-10T09:00:00.000Z'),
        },
      ],
    );
    const items = await service.reviewQueue(TENANT);
    expect(items).toHaveLength(0);
  });

  it(`caps the page at ${REVIEW_QUEUE_MAX_ITEMS} oldest items`, async () => {
    const events = Array.from({ length: REVIEW_QUEUE_MAX_ITEMS + 50 }, (_, i) =>
      reviewRequiredEvent(`e-${String(i).padStart(3, '0')}`, {
        occurredAt: new Date(Date.UTC(2026, 7, 10, 10, 0, i)),
      }),
    );
    const { service } = buildService(events);
    const items = await service.reviewQueue(TENANT);
    expect(items).toHaveLength(REVIEW_QUEUE_MAX_ITEMS);
    expect(items[0].eventId).toBe('e-000');
  });
});
