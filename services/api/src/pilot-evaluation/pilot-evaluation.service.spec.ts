import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import {
  CustomerJourneyEventType,
  PilotEvaluationRunStatus,
  PilotExpectedAction,
  PilotObservationVerdict,
  Prisma,
} from '@prisma/client';
import {
  DATASET_EXPORTABLE_VERDICTS,
  EVIDENCE_NOT_AVAILABLE,
  PilotEvaluationService,
} from './pilot-evaluation.service';

const TENANT = 'tenant-1';

/** In-memory prisma stub over the three pilot tables plus READ-ONLY
 *  fixtures for locations, products, live sessions, and journey events.
 *  The pilot review store deliberately exposes NO update/delete — the
 *  service must be append-only by construction (the real table also
 *  carries a DB trigger). */
function buildHarness(
  options: {
    liveSessions?: Record<string, unknown>[];
    journeyEvents?: Record<string, unknown>[];
    products?: { id: string; tenantId: string; sku: string }[];
    videoArtifacts?: Record<string, unknown>[];
  } = {},
) {
  let seq = 0;
  const nextId = (prefix: string) => `${prefix}-${(seq += 1)}`;
  const runs: Record<string, unknown>[] = [];
  const sessions: Record<string, unknown>[] = [];
  const reviews: Record<string, unknown>[] = [];
  const liveSessions = options.liveSessions ?? [];
  const journeyEvents = options.journeyEvents ?? [];
  const products = options.products ?? [];

  const whereMatch = (
    row: Record<string, unknown>,
    where: Record<string, unknown>,
  ): boolean =>
    Object.entries(where).every(([key, cond]) => {
      if (cond !== null && typeof cond === 'object' && 'in' in (cond as object)) {
        return ((cond as { in: unknown[] }).in ?? []).includes(row[key]);
      }
      return row[key] === cond;
    });

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const prisma: any = {
    pilotEvaluationRun: {
      create: jest.fn(async (args: { data: Record<string, unknown> }) => {
        const row = {
          id: nextId('run'),
          status: PilotEvaluationRunStatus.OPEN,
          description: null,
          locationId: null,
          createdById: null,
          createdAt: new Date('2026-08-19T10:00:00.000Z'),
          completedAt: null,
          ...args.data,
        };
        runs.push(row);
        return row;
      }),
      findFirst: jest.fn(async (args: { where: Record<string, unknown> }) => {
        const row = runs.find((r) => whereMatch(r, args.where));
        return row ? { ...row, location: null } : null;
      }),
      findMany: jest.fn(async (args: { where: Record<string, unknown> }) =>
        runs
          .filter((r) => whereMatch(r, args.where))
          .map((row) => ({
            ...row,
            location: null,
            _count: {
              sessions: sessions.filter((s) => s.evaluationRunId === row.id)
                .length,
              reviews: reviews.filter((s) => s.evaluationRunId === row.id)
                .length,
            },
          })),
      ),
      updateMany: jest.fn(
        async (args: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          const hits = runs.filter((r) => whereMatch(r, args.where));
          for (const row of hits) {
            Object.assign(row, args.data);
          }
          return { count: hits.length };
        },
      ),
    },
    pilotEvaluationSession: {
      create: jest.fn(async (args: { data: Record<string, unknown> }) => {
        if (
          sessions.some(
            (s) =>
              s.evaluationRunId === args.data.evaluationRunId &&
              s.liveSessionId === args.data.liveSessionId,
          )
        ) {
          throw new Prisma.PrismaClientKnownRequestError('unique', {
            code: 'P2002',
            clientVersion: 'test',
          });
        }
        const row = {
          id: nextId('att'),
          createdAt: new Date('2026-08-19T10:01:00.000Z'),
          ...args.data,
        };
        sessions.push(row);
        return row;
      }),
      findMany: jest.fn(async (args: { where: Record<string, unknown> }) =>
        sessions
          .filter((s) => whereMatch(s, args.where))
          .map((row) => ({
            ...row,
            liveSession: liveSessions.find(
              (l) => l.id === row.liveSessionId,
            ) ?? {
              id: row.liveSessionId,
              journeyId: null,
              performance: null,
            },
          })),
      ),
      count: jest.fn(async () => sessions.length),
    },
    pilotObservationReview: {
      // APPEND-ONLY: create is the only write this stub exposes.
      create: jest.fn(async (args: { data: Record<string, unknown> }) => {
        const row = {
          id: nextId('rev'),
          liveSessionId: null,
          journeyEventId: null,
          expectedProductId: null,
          expectedSku: null,
          predictedProductId: null,
          predictedSku: null,
          predictedAction: null,
          notes: null,
          reviewedById: null,
          createdAt: new Date(Date.parse('2026-08-19T10:02:00.000Z') + seq),
          ...args.data,
        };
        reviews.push(row);
        return row;
      }),
      findMany: jest.fn(async (args: { where: Record<string, unknown> }) =>
        reviews.filter((r) => whereMatch(r, args.where)),
      ),
      count: jest.fn(async (args: { where: Record<string, unknown> }) =>
        reviews.filter((r) => whereMatch(r, args.where)).length,
      ),
    },
    location: {
      findFirst: jest.fn(async (args: { where: { id?: string } }) =>
        args.where.id === 'store-1' ? { id: 'store-1' } : null,
      ),
    },
    product: {
      findFirst: jest.fn(async (args: { where: Record<string, unknown> }) => {
        const row = products.find((p) => whereMatch(p as never, args.where));
        return row ? { sku: row.sku } : null;
      }),
    },
    liveCameraSession: {
      findFirst: jest.fn(async (args: { where: Record<string, unknown> }) => {
        const row = liveSessions.find((l) => whereMatch(l, args.where));
        return row ? { id: row.id } : null;
      }),
    },
    videoArtifact: {
      findFirst: jest.fn(async (args: { where: Record<string, unknown> }) => {
        const row = (options.videoArtifacts ?? []).find((a) =>
          whereMatch(a, args.where),
        );
        return row ?? null;
      }),
    },
    customerJourneyEvent: {
      // observations() now queries with an OR of provenance scopes
      // (session journeys → LIVE_SHADOW; review-referenced ids →
      // FUSION_SHADOW); honor both that shape and the legacy flat one.
      findMany: jest.fn(async (args: { where: Record<string, unknown> }) => {
        const eventTypeIn =
          (args.where.eventType as { in: string[] }).in ?? [];
        const scopes =
          (args.where.OR as Record<string, unknown>[] | undefined) ?? [
            args.where,
          ];
        return journeyEvents.filter(
          (e) =>
            whereMatch(e, { tenantId: args.where.tenantId }) &&
            eventTypeIn.includes(e.eventType as string) &&
            scopes.some((scope) => {
              const journeyIn = (
                scope.journeyId as { in: string[] } | undefined
              )?.in;
              const idIn = (scope.id as { in: string[] } | undefined)?.in;
              if (
                scope.sourceType !== undefined &&
                e.sourceType !== scope.sourceType
              ) {
                return false;
              }
              if (journeyIn && !journeyIn.includes(e.journeyId as string)) {
                return false;
              }
              if (idIn && !idIn.includes(e.id as string)) {
                return false;
              }
              return true;
            }),
        );
      }),
      findFirst: jest.fn(async (args: { where: Record<string, unknown> }) => {
        const { eventType, sourceType, ...rest } = args.where;
        const sourceIn = (sourceType as { in: string[] } | undefined)?.in;
        const row = journeyEvents.find(
          (e) =>
            whereMatch(e, rest) &&
            ((eventType as { in: string[] }).in ?? []).includes(
              e.eventType as string,
            ) &&
            (sourceIn
              ? sourceIn.includes(e.sourceType as string)
              : sourceType === undefined || e.sourceType === sourceType),
        );
        return row ?? null;
      }),
    },
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const service = new PilotEvaluationService(prisma as never);
  return { service, prisma, runs, sessions, reviews };
}

const LIVE_SESSIONS = [
  {
    id: 'live-1',
    tenantId: TENANT,
    journeyId: 'journey-1',
    status: 'STOPPED',
    decision: 'NEEDS_EVENT_REVIEW',
    startedAt: new Date(),
    stoppedAt: new Date(),
    framesSampled: 10,
    eventWindowsDetected: 2,
    eventWindowsProcessed: 2,
    reviewNeeded: 2,
    errorCode: null,
    performance: {
      fastMode: false,
      stages: {
        eventToReview: { count: 2, avgMs: 900, p50Ms: 800, p95Ms: 1200, maxMs: 1300 },
        fusion: { count: 2, avgMs: 400, p50Ms: 350, p95Ms: 600, maxMs: 700 },
        journeyImport: { count: 2, avgMs: 90, p50Ms: 80, p95Ms: 120, maxMs: 130 },
      },
    },
  },
];

const EVENTS = [
  {
    id: 'event-1',
    tenantId: TENANT,
    journeyId: 'journey-1',
    eventType: CustomerJourneyEventType.PRODUCT_PICKUP,
    occurredAt: new Date('2026-08-19T09:00:01.000Z'),
    productId: 'prod-a',
    sku: 'SKU-A',
    productName: 'Product A',
    matchScore: 0.82,
    sourceType: 'LIVE_SHADOW',
  },
  {
    id: 'event-2',
    tenantId: TENANT,
    journeyId: 'journey-1',
    eventType: CustomerJourneyEventType.PRODUCT_PICKUP,
    occurredAt: new Date('2026-08-19T09:00:05.000Z'),
    productId: 'prod-b',
    sku: 'SKU-B',
    productName: 'Product B',
    matchScore: 0.4,
    sourceType: 'LIVE_SHADOW',
  },
];

const PRODUCTS = [
  { id: 'prod-a', tenantId: TENANT, sku: 'SKU-A' },
  { id: 'prod-c', tenantId: TENANT, sku: 'SKU-C' },
];

async function buildRunWithSession() {
  const harness = buildHarness({
    liveSessions: LIVE_SESSIONS,
    journeyEvents: EVENTS,
    products: PRODUCTS,
  });
  const run = await harness.service.createRun(
    TENANT,
    { name: 'Pilot week 1' },
    'user-1',
  );
  await harness.service.attachSession(
    TENANT,
    run.evaluationRunId,
    'live-1',
  );
  return { harness, runId: run.evaluationRunId };
}

describe('PilotEvaluationService — runs', () => {
  it('creates, lists, and details a run (tenant-scoped)', async () => {
    const harness = buildHarness();
    const created = await harness.service.createRun(
      TENANT,
      { name: 'Pilot week 1', description: 'first eval', locationId: 'store-1' },
      'user-1',
    );
    expect(created.status).toBe(PilotEvaluationRunStatus.OPEN);
    expect(created.name).toBe('Pilot week 1');
    const list = await harness.service.listRuns(TENANT);
    expect(list).toHaveLength(1);
    expect(list[0].evaluationRunId).toBe(created.evaluationRunId);
    await expect(
      harness.service.runDetail('tenant-B', created.evaluationRunId),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects an unknown store', async () => {
    const harness = buildHarness();
    await expect(
      harness.service.createRun(TENANT, { name: 'x', locationId: 'store-x' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('attach is idempotent, OPEN-only, and validates the live session', async () => {
    const { harness, runId } = await buildRunWithSession();
    // Re-attach: no second row.
    await harness.service.attachSession(TENANT, runId, 'live-1');
    expect(harness.sessions).toHaveLength(1);
    await expect(
      harness.service.attachSession(TENANT, runId, 'live-missing'),
    ).rejects.toBeInstanceOf(NotFoundException);
    await harness.service.setStatus(
      TENANT,
      runId,
      PilotEvaluationRunStatus.COMPLETED,
    );
    await expect(
      harness.service.attachSession(TENANT, runId, 'live-1'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('status transitions: OPEN → COMPLETED only once; reopen forbidden', async () => {
    const { harness, runId } = await buildRunWithSession();
    const done = await harness.service.setStatus(
      TENANT,
      runId,
      PilotEvaluationRunStatus.COMPLETED,
    );
    expect(done.status).toBe(PilotEvaluationRunStatus.COMPLETED);
    expect(done.completedAt).not.toBeNull();
    await expect(
      harness.service.setStatus(
        TENANT,
        runId,
        PilotEvaluationRunStatus.CANCELLED,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      harness.service.setStatus(TENANT, runId, PilotEvaluationRunStatus.OPEN),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('PilotEvaluationService — reviews (append-only)', () => {
  it('appends a review with SERVER-side predicted snapshots — never caller-supplied', async () => {
    const { harness, runId } = await buildRunWithSession();
    await harness.service.reviewObservation(
      TENANT,
      runId,
      {
        verdict: PilotObservationVerdict.WRONG_SKU,
        expectedAction: PilotExpectedAction.PICKUP,
        journeyEventId: 'event-1',
        expectedProductId: 'prod-c',
      },
      'reviewer-1',
    );
    const row = harness.reviews[0];
    expect(row.predictedProductId).toBe('prod-a');
    expect(row.predictedSku).toBe('SKU-A');
    expect(row.predictedAction).toBe(PilotExpectedAction.PICKUP);
    expect(row.expectedSku).toBe('SKU-C');
    expect(row.reviewedById).toBe('reviewer-1');
  });

  it('a changed mind APPENDS a second row — the original stays; metrics use the latest', async () => {
    const { harness, runId } = await buildRunWithSession();
    await harness.service.reviewObservation(TENANT, runId, {
      verdict: PilotObservationVerdict.INCORRECT,
      expectedAction: PilotExpectedAction.NO_OP,
      journeyEventId: 'event-1',
    });
    await harness.service.reviewObservation(TENANT, runId, {
      verdict: PilotObservationVerdict.CORRECT,
      expectedAction: PilotExpectedAction.PICKUP,
      journeyEventId: 'event-1',
    });
    expect(harness.reviews).toHaveLength(2);
    const { observations } = await harness.service.observations(TENANT, runId);
    const event1 = observations.find((o) => o.journeyEventId === 'event-1')!;
    expect(event1.latestReview!.verdict).toBe(PilotObservationVerdict.CORRECT);
    // The stub exposes no update/delete on the review store at all —
    // append-only by construction (plus the DB trigger in production).
    expect(harness.prisma.pilotObservationReview.update).toBeUndefined();
    expect(harness.prisma.pilotObservationReview.delete).toBeUndefined();
  });

  it('rejects observations outside the run, foreign tenants, and closed runs', async () => {
    const { harness, runId } = await buildRunWithSession();
    await expect(
      harness.service.reviewObservation(TENANT, runId, {
        verdict: PilotObservationVerdict.CORRECT,
        expectedAction: PilotExpectedAction.PICKUP,
        journeyEventId: 'event-missing',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      harness.service.reviewObservation('tenant-B', runId, {
        verdict: PilotObservationVerdict.CORRECT,
        expectedAction: PilotExpectedAction.PICKUP,
        journeyEventId: 'event-1',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await harness.service.setStatus(
      TENANT,
      runId,
      PilotEvaluationRunStatus.COMPLETED,
    );
    await expect(
      harness.service.reviewObservation(TENANT, runId, {
        verdict: PilotObservationVerdict.CORRECT,
        expectedAction: PilotExpectedAction.PICKUP,
        journeyEventId: 'event-1',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('MISSED_EVENT reviews attribute to an attached session and need PICKUP/RETURN', async () => {
    const { harness, runId } = await buildRunWithSession();
    await harness.service.reviewObservation(TENANT, runId, {
      verdict: PilotObservationVerdict.MISSED_EVENT,
      expectedAction: PilotExpectedAction.PICKUP,
      liveSessionId: 'live-1',
      expectedProductId: 'prod-a',
    });
    expect(harness.reviews[0].journeyEventId).toBeNull();
    expect(harness.reviews[0].liveSessionId).toBe('live-1');
    await expect(
      harness.service.reviewObservation(TENANT, runId, {
        verdict: PilotObservationVerdict.MISSED_EVENT,
        expectedAction: PilotExpectedAction.NO_OP,
        liveSessionId: 'live-1',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      harness.service.reviewObservation(TENANT, runId, {
        verdict: PilotObservationVerdict.MISSED_EVENT,
        expectedAction: PilotExpectedAction.PICKUP,
        liveSessionId: 'live-unattached',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('notes are screened: sensitive free text is rejected, over-length rejected', async () => {
    const { harness, runId } = await buildRunWithSession();
    await expect(
      harness.service.reviewObservation(TENANT, runId, {
        verdict: PilotObservationVerdict.CORRECT,
        expectedAction: PilotExpectedAction.PICKUP,
        journeyEventId: 'event-1',
        notes: 'card 4111 1111 1111 1111 seen on shelf',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      harness.service.reviewObservation(TENANT, runId, {
        verdict: PilotObservationVerdict.CORRECT,
        expectedAction: PilotExpectedAction.PICKUP,
        journeyEventId: 'event-1',
        notes: 'x'.repeat(301),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(harness.reviews).toHaveLength(0);
  });
});

describe('PilotEvaluationService — metrics', () => {
  it('counts, accuracies, and confusion from the latest reviews; null rates on empty denominators', async () => {
    const { harness, runId } = await buildRunWithSession();
    // event-1: CORRECT pickup SKU-A. event-2: WRONG_SKU (expected C).
    await harness.service.reviewObservation(TENANT, runId, {
      verdict: PilotObservationVerdict.CORRECT,
      expectedAction: PilotExpectedAction.PICKUP,
      journeyEventId: 'event-1',
    });
    await harness.service.reviewObservation(TENANT, runId, {
      verdict: PilotObservationVerdict.WRONG_SKU,
      expectedAction: PilotExpectedAction.PICKUP,
      journeyEventId: 'event-2',
      expectedProductId: 'prod-c',
    });
    await harness.service.reviewObservation(TENANT, runId, {
      verdict: PilotObservationVerdict.MISSED_EVENT,
      expectedAction: PilotExpectedAction.RETURN,
      liveSessionId: 'live-1',
    });
    const summary = await harness.service.summary(TENANT, runId);
    expect(summary.totals).toMatchObject({
      observations: 2,
      reviewed: 2,
      unreviewed: 0,
      correct: 1,
      wrongSku: 1,
      missedEvents: 1,
    });
    // Action: both decided events had the right action → 1.0.
    expect(summary.accuracy.action).toBe(1);
    // SKU: 1 correct of 2 judged → 0.5.
    expect(summary.accuracy.sku).toBe(0.5);
    // Combined: 1 fully-correct of 2 decided → 0.5.
    expect(summary.accuracy.combined).toBe(0.5);
    expect(summary.confusion.sku).toEqual(
      expect.arrayContaining([
        { predicted: 'SKU-A', expected: 'SKU-A', count: 1 },
        { predicted: 'SKU-B', expected: 'SKU-C', count: 1 },
      ]),
    );
    expect(summary.confusion.action).toEqual(
      expect.arrayContaining([
        { predicted: 'PICKUP', expected: 'PICKUP', count: 2 },
        { predicted: 'NO_OP', expected: 'RETURN', count: 1 },
      ]),
    );
    expect(summary.safety).toMatchObject({
      orders: 0,
      checkoutSessions: 0,
      paymentIntents: 0,
      paymentEvents: 0,
      inventoryMovements: 0,
    });
  });

  it('an unreviewed run reports null accuracies — never fabricated numbers', async () => {
    const { harness, runId } = await buildRunWithSession();
    const summary = await harness.service.summary(TENANT, runId);
    expect(summary.totals.reviewed).toBe(0);
    expect(summary.accuracy.action).toBeNull();
    expect(summary.accuracy.sku).toBeNull();
    expect(summary.accuracy.combined).toBeNull();
  });

  it('latency passes through the single session stats; combined is null with multiple sessions', async () => {
    const { harness, runId } = await buildRunWithSession();
    const single = await harness.service.summary(TENANT, runId);
    expect(single.latency.combined?.eventToReview?.p95Ms).toBe(1200);
    expect(single.latency.combined?.slowestStage?.stage).toBe('eventToReview');
    // A second session (no performance data) → per-session rows, no
    // fabricated combined percentiles.
    LIVE_SESSIONS.push({
      ...LIVE_SESSIONS[0],
      id: 'live-2',
      journeyId: 'journey-2',
      performance: null,
    } as never);
    try {
      await harness.service.attachSession(TENANT, runId, 'live-2');
      const multi = await harness.service.summary(TENANT, runId);
      expect(multi.latency.combined).toBeNull();
      expect(multi.latency.sessions).toHaveLength(2);
      const second = multi.latency.sessions.find(
        (row) => row.liveSessionId === 'live-2',
      )!;
      expect(second.eventToReview).toBeNull();
      expect(second.slowestStage).toBeNull();
    } finally {
      LIVE_SESSIONS.pop();
    }
  });
});

describe('PilotEvaluationService — dataset export', () => {
  it('exports ONLY confirmed/corrected latest reviews as controlled JSONL', async () => {
    const { harness, runId } = await buildRunWithSession();
    await harness.service.reviewObservation(TENANT, runId, {
      verdict: PilotObservationVerdict.CORRECT,
      expectedAction: PilotExpectedAction.PICKUP,
      journeyEventId: 'event-1',
    });
    await harness.service.reviewObservation(TENANT, runId, {
      verdict: PilotObservationVerdict.UNCERTAIN,
      expectedAction: PilotExpectedAction.UNKNOWN,
      journeyEventId: 'event-2',
    });
    const exportResult = await harness.service.datasetExport(TENANT, runId);
    expect(exportResult.format).toBe('jsonl');
    expect(exportResult.rowCount).toBe(1);
    const row = JSON.parse(exportResult.manifest);
    // CORRECT: the confirmed prediction IS the label.
    expect(row).toMatchObject({
      tenantId: TENANT,
      evaluationRunId: runId,
      liveSessionId: 'live-1',
      journeyEventId: 'event-1',
      sourceType: 'LIVE_WINDOW',
      expectedAction: 'PICKUP',
      expectedSku: 'SKU-A',
      predictedSku: 'SKU-A',
      confidence: 0.82,
      reviewVerdict: 'CORRECT',
      evidenceStatus: EVIDENCE_NOT_AVAILABLE,
    });
  });

  it('a correction exports the OPERATOR label, not the prediction', async () => {
    const { harness, runId } = await buildRunWithSession();
    await harness.service.reviewObservation(TENANT, runId, {
      verdict: PilotObservationVerdict.WRONG_SKU,
      expectedAction: PilotExpectedAction.PICKUP,
      journeyEventId: 'event-2',
      expectedProductId: 'prod-c',
    });
    const exportResult = await harness.service.datasetExport(TENANT, runId);
    const row = JSON.parse(exportResult.manifest);
    expect(row.expectedSku).toBe('SKU-C');
    expect(row.predictedSku).toBe('SKU-B');
    expect(row.reviewVerdict).toBe('WRONG_SKU');
  });

  it('unreviewed and non-exportable verdicts never export; the manifest carries no URL/path/credential material', async () => {
    const { harness, runId } = await buildRunWithSession();
    await harness.service.reviewObservation(TENANT, runId, {
      verdict: PilotObservationVerdict.INCORRECT,
      expectedAction: PilotExpectedAction.NO_OP,
      journeyEventId: 'event-1',
    });
    const exportResult = await harness.service.datasetExport(TENANT, runId);
    // event-1 INCORRECT (not exportable), event-2 unreviewed.
    expect(exportResult.rowCount).toBe(0);
    expect(exportResult.manifest).toBe('');
    // The exportable set is pinned: confirmations and corrections only.
    expect(DATASET_EXPORTABLE_VERDICTS).toEqual([
      'CORRECT',
      'WRONG_SKU',
      'WRONG_ACTION',
    ]);
    // Leak scan over a populated manifest.
    await harness.service.reviewObservation(TENANT, runId, {
      verdict: PilotObservationVerdict.CORRECT,
      expectedAction: PilotExpectedAction.PICKUP,
      journeyEventId: 'event-2',
    });
    const populated = await harness.service.datasetExport(TENANT, runId);
    expect(populated.manifest).not.toContain('rtsp');
    expect(populated.manifest).not.toContain('://');
    expect(populated.manifest).not.toContain('CAMERA_');
    expect(populated.manifest).not.toContain('credential');
  });
});

describe('PilotEvaluationService — video-bootstrap (FUSION_SHADOW) observations', () => {
  const VIDEO_EVENT = {
    id: 'event-video-1',
    tenantId: TENANT,
    journeyId: 'journey-video',
    eventType: CustomerJourneyEventType.PRODUCT_PICKUP,
    occurredAt: new Date('2026-08-20T10:00:00.000Z'),
    productId: 'prod-a',
    sku: 'SKU-A',
    productName: 'Product A',
    matchScore: 0.35,
    sourceType: 'FUSION_SHADOW',
    videoAssetId: 'va-1',
  };

  it('records a review on a video-shadow event with NO attached session and surfaces it as an observation', async () => {
    const harness = buildHarness({
      journeyEvents: [VIDEO_EVENT],
      products: PRODUCTS,
    });
    const run = await harness.service.createRun(
      TENANT,
      { name: 'One SKU bootstrap — SKU-A' },
      'user-1',
    );
    const review = await harness.service.reviewObservation(
      TENANT,
      run.evaluationRunId,
      {
        verdict: PilotObservationVerdict.WRONG_SKU,
        expectedAction: PilotExpectedAction.PICKUP,
        journeyEventId: 'event-video-1',
        expectedProductId: 'prod-c',
      },
      'user-1',
      { allowVideoShadowEvent: true },
    );
    const stored = harness.reviews.find(
      (row) => row.id === review.reviewId,
    ) as Record<string, unknown>;
    // No live session exists for a video clip — the review row itself is
    // the run linkage, and the prediction snapshots are server-side.
    expect(stored.liveSessionId).toBeNull();
    expect(stored.predictedSku).toBe('SKU-A');
    expect(stored.expectedSku).toBe('SKU-C');

    // The reviewed video event is now an observation of the run — the
    // exact rows Phase 18 candidate refresh consumes.
    const result = await harness.service.observations(
      TENANT,
      run.evaluationRunId,
    );
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0].journeyEventId).toBe('event-video-1');
    expect(result.observations[0].liveSessionId).toBeNull();
    expect(result.observations[0].latestReview?.verdict).toBe(
      PilotObservationVerdict.WRONG_SKU,
    );
  });

  it('refuses a video-shadow event that lacks video provenance', async () => {
    const harness = buildHarness({
      journeyEvents: [
        { ...VIDEO_EVENT, id: 'event-video-2', videoAssetId: null },
      ],
      products: PRODUCTS,
    });
    const run = await harness.service.createRun(
      TENANT,
      { name: 'One SKU bootstrap — SKU-A' },
      'user-1',
    );
    await expect(
      harness.service.reviewObservation(
        TENANT,
        run.evaluationRunId,
        {
          verdict: PilotObservationVerdict.CORRECT,
          expectedAction: PilotExpectedAction.PICKUP,
          journeyEventId: 'event-video-2',
        },
        undefined,
        { allowVideoShadowEvent: true },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('REJECTS a video-shadow event on the public path (no bootstrap capability)', async () => {
    // The HTTP review endpoint calls reviewObservation WITHOUT the
    // service-internal capability — an arbitrary caller can never
    // attach a tenant-local video event to an open run and have
    // Phase 18 collect it as forged linkage (Codex P2).
    const harness = buildHarness({
      journeyEvents: [VIDEO_EVENT],
      products: PRODUCTS,
    });
    const run = await harness.service.createRun(
      TENANT,
      { name: 'One SKU bootstrap — SKU-A' },
      'user-1',
    );
    await expect(
      harness.service.reviewObservation(TENANT, run.evaluationRunId, {
        verdict: PilotObservationVerdict.CORRECT,
        expectedAction: PilotExpectedAction.PICKUP,
        journeyEventId: 'event-video-1',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(harness.reviews).toHaveLength(0);
  });

  it('still refuses a LIVE_SHADOW event whose session is not attached to the run', async () => {
    const harness = buildHarness({
      liveSessions: LIVE_SESSIONS,
      journeyEvents: EVENTS,
      products: PRODUCTS,
    });
    const run = await harness.service.createRun(
      TENANT,
      { name: 'Unattached' },
      'user-1',
    );
    await expect(
      harness.service.reviewObservation(TENANT, run.evaluationRunId, {
        verdict: PilotObservationVerdict.CORRECT,
        expectedAction: PilotExpectedAction.PICKUP,
        journeyEventId: 'event-1',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('PilotEvaluationService — structured operator-crop evidence', () => {
  const VIDEO_EVENT = {
    id: 'event-video-crop',
    tenantId: TENANT,
    journeyId: 'journey-video',
    eventType: CustomerJourneyEventType.PRODUCT_PICKUP,
    occurredAt: new Date('2026-08-20T10:00:00.000Z'),
    productId: 'prod-a',
    sku: 'SKU-A',
    productName: 'Product A',
    matchScore: 0.35,
    sourceType: 'FUSION_SHADOW',
    videoAssetId: 'va-1',
  };
  const CROP = {
    id: 'artifact-manual-1',
    tenantId: TENANT,
    videoAssetId: 'va-1',
    artifactType: 'CROP',
    createdById: 'user-1',
  };

  async function makeRun(harness: ReturnType<typeof buildHarness>) {
    const run = await harness.service.createRun(
      TENANT,
      { name: 'One SKU bootstrap — SKU-A' },
      'user-1',
    );
    return run.evaluationRunId;
  }

  it('stores the crop reference STRUCTURALLY and surfaces it in observations()', async () => {
    const harness = buildHarness({
      journeyEvents: [VIDEO_EVENT],
      products: PRODUCTS,
      videoArtifacts: [CROP],
    });
    const runId = await makeRun(harness);
    const review = await harness.service.reviewObservation(
      TENANT,
      runId,
      {
        verdict: PilotObservationVerdict.CORRECT,
        expectedAction: PilotExpectedAction.PICKUP,
        journeyEventId: VIDEO_EVENT.id,
        operatorCropArtifactId: CROP.id,
        notes: 'clean view',
      },
      'user-1',
      { allowVideoShadowEvent: true },
    );
    const stored = harness.reviews.find(
      (row) => row.id === review.reviewId,
    ) as Record<string, unknown>;
    expect(stored.operatorCropArtifactId).toBe(CROP.id);
    // Notes stay free text — the association is NEVER parsed from them.
    expect(stored.notes).toBe('clean view');

    const result = await harness.service.observations(TENANT, runId);
    expect(result.observations[0].latestReview?.operatorCropArtifactId).toBe(
      CROP.id,
    );
  });

  it('rejects a crop from another tenant (tenant isolation)', async () => {
    const harness = buildHarness({
      journeyEvents: [VIDEO_EVENT],
      products: PRODUCTS,
      videoArtifacts: [{ ...CROP, tenantId: 'tenant-2' }],
    });
    const runId = await makeRun(harness);
    await expect(
      harness.service.reviewObservation(TENANT, runId, {
        verdict: PilotObservationVerdict.CORRECT,
        expectedAction: PilotExpectedAction.PICKUP,
        journeyEventId: VIDEO_EVENT.id,
        operatorCropArtifactId: CROP.id,
      }, undefined, { allowVideoShadowEvent: true }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects a crop that belongs to a DIFFERENT video than the observation', async () => {
    const harness = buildHarness({
      journeyEvents: [VIDEO_EVENT],
      products: PRODUCTS,
      videoArtifacts: [{ ...CROP, videoAssetId: 'va-other' }],
    });
    const runId = await makeRun(harness);
    await expect(
      harness.service.reviewObservation(TENANT, runId, {
        verdict: PilotObservationVerdict.CORRECT,
        expectedAction: PilotExpectedAction.PICKUP,
        journeyEventId: VIDEO_EVENT.id,
        operatorCropArtifactId: CROP.id,
      }, undefined, { allowVideoShadowEvent: true }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a pipeline-created crop (only operator crops are evidence overrides)', async () => {
    const harness = buildHarness({
      journeyEvents: [VIDEO_EVENT],
      products: PRODUCTS,
      videoArtifacts: [{ ...CROP, createdById: null }],
    });
    const runId = await makeRun(harness);
    await expect(
      harness.service.reviewObservation(TENANT, runId, {
        verdict: PilotObservationVerdict.CORRECT,
        expectedAction: PilotExpectedAction.PICKUP,
        journeyEventId: VIDEO_EVENT.id,
        operatorCropArtifactId: CROP.id,
      }, undefined, { allowVideoShadowEvent: true }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
