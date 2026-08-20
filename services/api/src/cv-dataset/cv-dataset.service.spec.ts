import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CvDatasetService } from './cv-dataset.service';

const TENANT = 'tenant-1';

/** Runtime-assembled risky needles (assemble idiom): no URL/secret-shaped
 *  literal may appear in this file. */
const assemble = (...parts: string[]) => parts.join('');

interface ObservationFixture {
  journeyEventId: string;
  liveSessionId: string | null;
  eventType: string;
  occurredAt: Date;
  predictedProductId: string | null;
  predictedSku: string | null;
  predictedProductName: string | null;
  matchScore: number | null;
  latestReview: Record<string, unknown> | null;
}

function observation(
  over: Partial<ObservationFixture> = {},
): ObservationFixture {
  return {
    journeyEventId: 'evt-1',
    liveSessionId: 'live-1',
    eventType: 'PRODUCT_PICKUP',
    occurredAt: new Date('2026-08-19T10:00:00.000Z'),
    predictedProductId: 'prod-a',
    predictedSku: 'SKU-A',
    predictedProductName: 'Product A',
    matchScore: 0.9,
    latestReview: null,
    ...over,
  };
}

function review(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    reviewId: 'rev-1',
    verdict: 'CORRECT',
    expectedAction: 'PICKUP',
    expectedProductId: null,
    expectedSku: null,
    notes: null,
    reviewedById: null,
    reviewedAt: new Date('2026-08-19T11:00:00.000Z'),
    ...over,
  };
}

function buildHarness(
  options: {
    observations?: ObservationFixture[];
    missedEvents?: Record<string, unknown>[];
    summary?: Record<string, unknown> | null;
    scenarios?: Record<string, unknown>[];
    zones?: { zoneType: string }[];
  } = {},
) {
  let seq = 0;
  let clock = 0;
  const nextId = (prefix: string) => `${prefix}-${(seq += 1)}`;
  const nextDate = () => new Date(Date.UTC(2026, 7, 20, 9, 0, (clock += 1)));
  const runs: Record<string, unknown>[] = [];
  const candidates: Record<string, unknown>[] = [];

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
    cvDatasetImprovementRun: {
      create: jest.fn(async (args: { data: Record<string, unknown> }) => {
        const row = {
          id: nextId('dsrun'),
          status: 'DRAFT',
          exportedAt: null,
          archivedAt: null,
          createdAt: nextDate(),
          updatedAt: nextDate(),
          ...args.data,
        };
        runs.push(row);
        return row;
      }),
      findFirst: jest.fn(
        async (args: { where: Record<string, unknown> }) =>
          runs.find((row) => whereMatch(row, args.where)) ?? null,
      ),
      findMany: jest.fn(async (args: { where: Record<string, unknown> }) =>
        runs.filter((row) => whereMatch(row, args.where)),
      ),
      updateMany: jest.fn(
        async (args: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          const hits = runs.filter((row) => whereMatch(row, args.where));
          for (const row of hits) {
            Object.assign(row, args.data, { updatedAt: nextDate() });
          }
          return { count: hits.length };
        },
      ),
    },
    cvDatasetCandidate: {
      findMany: jest.fn(async (args: { where: Record<string, unknown> }) =>
        candidates.filter((row) => whereMatch(row, args.where)),
      ),
      deleteMany: jest.fn(async (args: { where: Record<string, unknown> }) => {
        const keep = candidates.filter(
          (row) => !whereMatch(row, args.where),
        );
        const removed = candidates.length - keep.length;
        candidates.length = 0;
        candidates.push(...keep);
        return { count: removed };
      }),
      createMany: jest.fn(async (args: { data: Record<string, unknown>[] }) => {
        for (const data of args.data) {
          candidates.push({
            id: nextId('cand'),
            createdAt: nextDate(),
            updatedAt: nextDate(),
            ...data,
          });
        }
        return { count: args.data.length };
      }),
      updateMany: jest.fn(
        async (args: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          const hits = candidates.filter((row) => whereMatch(row, args.where));
          for (const row of hits) {
            Object.assign(row, args.data, { updatedAt: nextDate() });
          }
          return { count: hits.length };
        },
      ),
    },
    pilotEvaluationRun: {
      findFirst: jest.fn(
        async (args: { where: { tenantId?: string; id?: string } }) =>
          args.where.tenantId === TENANT && args.where.id === 'eval-1'
            ? { id: 'eval-1' }
            : null,
      ),
      updateMany: jest.fn(),
    },
    cvTestProtocol: {
      findFirst: jest.fn(
        async (args: { where: { tenantId?: string; id?: string } }) =>
          args.where.tenantId === TENANT && args.where.id === 'proto-1'
            ? { id: 'proto-1' }
            : null,
      ),
      updateMany: jest.fn(),
    },
    cvTestProtocolScenario: {
      findMany: jest.fn(async () => options.scenarios ?? []),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    cameraCalibrationProfile: {
      findFirst: jest.fn(
        async (args: { where: { tenantId?: string; id?: string } }) =>
          args.where.tenantId === TENANT && args.where.id === 'cal-1'
            ? {
                id: 'cal-1',
                name: 'Front shelf profile',
                calibrationVersion: 2,
                orientation: 'LANDSCAPE',
                cameraMount: 'FRONT_SHELF',
              }
            : null,
      ),
      updateMany: jest.fn(),
    },
    cameraCalibrationZone: {
      findMany: jest.fn(async () => options.zones ?? []),
      updateMany: jest.fn(),
    },
    pilotObservationReview: {
      update: jest.fn(),
      updateMany: jest.fn(),
      deleteMany: jest.fn(),
    },
    $queryRaw: jest.fn(async () => []),
  };
  prisma.$transaction = jest.fn(
    async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
  );
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const evaluations = {
    observations: jest.fn(async (tenantId: string, evaluationRunId: string) => {
      if (tenantId !== TENANT || evaluationRunId !== 'eval-1') {
        throw new NotFoundException('Evaluation run not found');
      }
      return {
        evaluationRunId,
        observations: options.observations ?? [],
        missedEvents: options.missedEvents ?? [],
      };
    }),
    summary: jest.fn(async (tenantId: string, evaluationRunId: string) => {
      if (tenantId !== TENANT || evaluationRunId !== 'eval-1') {
        throw new NotFoundException('Evaluation run not found');
      }
      return (
        options.summary ?? {
          confusion: { action: [], sku: [] },
        }
      );
    }),
  };
  const service = new CvDatasetService(prisma as never, evaluations as never);
  return { service, prisma, evaluations, runs, candidates };
}

const BASE_INPUT = {
  name: 'Improve pilot dataset',
  purpose: 'MIXED' as const,
  trainSplitPercent: 70,
  validationSplitPercent: 15,
  testSplitPercent: 15,
};

/** The reviewed/corrected mixed fixture used across the suite. */
function mixedFixtureOptions() {
  return {
    observations: [
      observation({
        journeyEventId: 'evt-correct',
        latestReview: review({ reviewId: 'rev-c', verdict: 'CORRECT' }),
      }),
      observation({
        journeyEventId: 'evt-wrong-sku',
        matchScore: 0.6,
        latestReview: review({
          reviewId: 'rev-ws',
          verdict: 'WRONG_SKU',
          expectedProductId: 'prod-b',
          expectedSku: 'SKU-B',
        }),
      }),
      observation({
        journeyEventId: 'evt-wrong-action',
        eventType: 'PRODUCT_PICKUP',
        latestReview: review({
          reviewId: 'rev-wa',
          verdict: 'WRONG_ACTION',
          expectedAction: 'RETURN',
          expectedProductId: 'prod-a',
          expectedSku: 'SKU-A',
        }),
      }),
      observation({
        journeyEventId: 'evt-false-touch',
        matchScore: 0.2,
        latestReview: review({ reviewId: 'rev-ft', verdict: 'FALSE_TOUCH' }),
      }),
      observation({
        journeyEventId: 'evt-uncertain',
        latestReview: review({ reviewId: 'rev-u', verdict: 'UNCERTAIN' }),
      }),
      observation({
        journeyEventId: 'evt-incorrect',
        latestReview: review({ reviewId: 'rev-i', verdict: 'INCORRECT' }),
      }),
      observation({ journeyEventId: 'evt-unreviewed', matchScore: null }),
    ],
    missedEvents: [
      {
        reviewId: 'rev-missed',
        liveSessionId: 'live-1',
        expectedAction: 'RETURN',
        expectedProductId: 'prod-b',
        expectedSku: 'SKU-B',
        notes: null,
        reviewedAt: new Date('2026-08-19T11:30:00.000Z'),
      },
    ],
    scenarios: [
      {
        id: 'scen-pass',
        scenarioType: 'SINGLE_PICKUP',
        expectedAction: 'PICKUP',
        expectedProductId: 'prod-a',
        expectedSku: 'SKU-A',
        liveSessionId: 'live-2',
        result: 'PASS',
      },
      {
        id: 'scen-fail',
        scenarioType: 'MISSED_PICKUP',
        expectedAction: 'PICKUP',
        expectedProductId: 'prod-b',
        expectedSku: 'SKU-B',
        liveSessionId: 'live-2',
        result: 'FAIL',
      },
      {
        id: 'scen-inconclusive',
        scenarioType: 'LOW_LIGHT',
        expectedAction: 'PICKUP',
        expectedProductId: null,
        expectedSku: null,
        liveSessionId: null,
        result: 'INCONCLUSIVE',
      },
      {
        id: 'scen-pending',
        scenarioType: 'SINGLE_RETURN',
        expectedAction: 'RETURN',
        expectedProductId: null,
        expectedSku: null,
        liveSessionId: null,
        result: null,
      },
    ],
  };
}

async function createLinkedRun(
  service: CvDatasetService,
  extra: Record<string, unknown> = {},
) {
  return service.createRun(TENANT, {
    ...BASE_INPUT,
    sourceEvaluationRunId: 'eval-1',
    sourceTestProtocolId: 'proto-1',
    sourceCalibrationProfileId: 'cal-1',
    ...extra,
  } as never);
}

describe('CvDatasetService — runs', () => {
  it('creates, lists, and details a run with defaulted minimums', async () => {
    const { service } = buildHarness();
    const created = await createLinkedRun(service);
    expect(created.status).toBe('DRAFT');
    expect(created.minReviewedExamplesPerSku).toBe(5);
    expect(created.minReviewedExamplesPerAction).toBe(5);
    const listed = await service.listRuns(TENANT);
    expect(listed).toHaveLength(1);
    const detail = await service.runDetail(TENANT, created.id);
    expect(detail.candidateSummary).toEqual({
      total: 0,
      eligible: 0,
      excluded: 0,
      bySplit: { TRAIN: 0, VALIDATION: 0, TEST: 0, HOLDOUT: 0, UNPLANNED: 0 },
    });
  });

  it('rejects split percentages that do not sum to 100', async () => {
    const { service } = buildHarness();
    await expect(
      service.createRun(TENANT, {
        ...BASE_INPUT,
        trainSplitPercent: 80,
      } as never),
    ).rejects.toThrow(BadRequestException);
  });

  it('is tenant-isolated: another tenant cannot see or edit the run', async () => {
    const { service } = buildHarness();
    const created = await createLinkedRun(service);
    await expect(service.runDetail('tenant-2', created.id)).rejects.toThrow(
      NotFoundException,
    );
    await expect(
      service.updateRun('tenant-2', created.id, { name: 'stolen' }),
    ).rejects.toThrow(NotFoundException);
  });

  it('rejects source links that are not tenant-scoped', async () => {
    const { service } = buildHarness();
    await expect(
      service.createRun(TENANT, {
        ...BASE_INPUT,
        sourceEvaluationRunId: 'eval-other',
      } as never),
    ).rejects.toThrow(NotFoundException);
    await expect(
      service.createRun(TENANT, {
        ...BASE_INPUT,
        sourceTestProtocolId: 'proto-other',
      } as never),
    ).rejects.toThrow(NotFoundException);
    await expect(
      service.createRun(TENANT, {
        ...BASE_INPUT,
        sourceCalibrationProfileId: 'cal-other',
      } as never),
    ).rejects.toThrow(NotFoundException);
  });

  it('rejects URL/path/stream/credential-slot text in name and notes without echoing it', async () => {
    const { service } = buildHarness();
    const url = assemble('rt', 'sp', ':', '/', '/cam.example', '/feed');
    const slot = assemble('CAMERA_', 'SECRET_', 'SLOT_', 'ALPHA');
    const streamSlot = assemble('CAMERA_', 'RT', 'SP_', 'SOURCE_', 'ALPHA');
    const path = assemble('C:', '\\', 'videos', '\\', 'clip');
    for (const bad of [url, slot, streamSlot, path]) {
      const error = await service
        .createRun(TENANT, { ...BASE_INPUT, name: bad } as never)
        .then(
          () => null,
          (thrown: Error) => thrown,
        );
      expect(error).toBeInstanceOf(BadRequestException);
      expect(error!.message).not.toContain(bad);
      const notesError = await service
        .createRun(TENANT, { ...BASE_INPUT, notes: bad } as never)
        .then(
          () => null,
          (thrown: Error) => thrown,
        );
      expect(notesError).toBeInstanceOf(BadRequestException);
      expect(notesError!.message).not.toContain(bad);
    }
    const fine = await service.createRun(TENANT, {
      ...BASE_INPUT,
      notes: 'Front shelf zone A needs more return examples',
    } as never);
    expect(fine.notes).toContain('Front shelf zone A');
  });

  it('only DRAFT runs can be edited; ARCHIVED is terminal', async () => {
    const { service } = buildHarness(mixedFixtureOptions());
    const created = await createLinkedRun(service);
    await service.refreshCandidates(TENANT, created.id);
    await service.setStatus(TENANT, created.id, 'READY' as never);
    await expect(
      service.updateRun(TENANT, created.id, { name: 'Renamed' }),
    ).rejects.toThrow(BadRequestException);
    const archived = await service.setStatus(
      TENANT,
      created.id,
      'ARCHIVED' as never,
    );
    expect(archived.status).toBe('ARCHIVED');
    expect(archived.archivedAt).not.toBeNull();
    await expect(
      service.setStatus(TENANT, created.id, 'ARCHIVED' as never),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.refreshCandidates(TENANT, created.id),
    ).rejects.toThrow(BadRequestException);
  });

  it('READY is gated on eligible reviewed data existing', async () => {
    const { service } = buildHarness();
    const created = await createLinkedRun(service);
    await expect(
      service.setStatus(TENANT, created.id, 'READY' as never),
    ).rejects.toThrow('run is not ready: minimum reviewed data is missing');
  });
});

describe('CvDatasetService — candidate collection (reviewed/corrected only)', () => {
  it('maps live reviews, missed events, and scenario results per the eligibility rules', async () => {
    const { service, candidates } = buildHarness(mixedFixtureOptions());
    const created = await createLinkedRun(service);
    const result = await service.refreshCandidates(TENANT, created.id);
    expect(result).toEqual({
      runId: created.id,
      total: 12,
      eligible: 7,
      excluded: 5,
    });
    const bydSource = (sourceId: string) =>
      candidates.find((row) => row.sourceId === sourceId)!;

    const correct = bydSource('evt-correct');
    expect(correct.eligibility).toBe('ELIGIBLE');
    expect(correct.skuCodeSnapshot).toBe('SKU-A');
    expect(correct.correctedActionLabel).toBeNull();
    expect(correct.confidenceBucket).toBe('HIGH');
    expect(correct.reviewSource).toBe('PILOT_EVALUATION');

    const wrongSku = bydSource('evt-wrong-sku');
    expect(wrongSku.eligibility).toBe('ELIGIBLE');
    expect(wrongSku.skuCodeSnapshot).toBe('SKU-B');
    expect(wrongSku.confidenceBucket).toBe('MEDIUM');

    const wrongAction = bydSource('evt-wrong-action');
    expect(wrongAction.eligibility).toBe('ELIGIBLE');
    expect(wrongAction.actionLabel).toBe('PICKUP');
    expect(wrongAction.correctedActionLabel).toBe('RETURN');

    const falseTouch = bydSource('evt-false-touch');
    expect(falseTouch.eligibility).toBe('ELIGIBLE');
    expect(falseTouch.correctedActionLabel).toBe('NO_OP');
    expect(falseTouch.confidenceBucket).toBe('LOW');

    expect(bydSource('evt-uncertain')).toMatchObject({
      eligibility: 'EXCLUDED',
      exclusionReason: 'UNCERTAIN_VERDICT',
    });
    expect(bydSource('evt-incorrect')).toMatchObject({
      eligibility: 'EXCLUDED',
      exclusionReason: 'INCORRECT_VERDICT',
    });
    expect(bydSource('evt-unreviewed')).toMatchObject({
      eligibility: 'EXCLUDED',
      exclusionReason: 'NOT_REVIEWED',
      reviewVerdict: 'UNREVIEWED',
      confidenceBucket: null,
    });

    expect(bydSource('rev-missed')).toMatchObject({
      sourceType: 'MISSED_EVENT',
      eligibility: 'ELIGIBLE',
      actionLabel: 'RETURN',
      skuCodeSnapshot: 'SKU-B',
      reviewVerdict: 'MISSED_EVENT',
    });

    expect(bydSource('scen-pass')).toMatchObject({
      sourceType: 'PROTOCOL_SCENARIO',
      eligibility: 'ELIGIBLE',
      reviewVerdict: 'PASS',
      reviewSource: 'CV_TEST_PROTOCOL',
      scenarioTypeSnapshot: 'SINGLE_PICKUP',
    });
    expect(bydSource('scen-fail')).toMatchObject({ eligibility: 'ELIGIBLE' });
    expect(bydSource('scen-inconclusive')).toMatchObject({
      eligibility: 'EXCLUDED',
      exclusionReason: 'INCONCLUSIVE_RESULT',
    });
    expect(bydSource('scen-pending')).toMatchObject({
      eligibility: 'EXCLUDED',
      exclusionReason: 'MISSING_RESULT',
    });

    // Every candidate carries the run's calibration profile snapshot and
    // the MVP nulls — never fabricated buckets.
    for (const row of candidates) {
      expect(row.calibrationProfileId).toBe('cal-1');
      expect(row.lightingBucket).toBeNull();
      expect(row.occlusionBucket).toBeNull();
      expect(row.calibrationZoneLabel).toBeNull();
    }
  });

  it('never mutates the reviewed/corrected source records it reads', async () => {
    const { service, prisma } = buildHarness(mixedFixtureOptions());
    const created = await createLinkedRun(service);
    await service.refreshCandidates(TENANT, created.id);
    await service.planSplits(TENANT, created.id);
    expect(prisma.cvTestProtocolScenario.update).not.toHaveBeenCalled();
    expect(prisma.cvTestProtocolScenario.updateMany).not.toHaveBeenCalled();
    expect(prisma.pilotObservationReview.update).not.toHaveBeenCalled();
    expect(prisma.pilotObservationReview.updateMany).not.toHaveBeenCalled();
    expect(prisma.pilotObservationReview.deleteMany).not.toHaveBeenCalled();
    expect(prisma.pilotEvaluationRun.updateMany).not.toHaveBeenCalled();
    expect(prisma.cvTestProtocol.updateMany).not.toHaveBeenCalled();
    expect(prisma.cameraCalibrationProfile.updateMany).not.toHaveBeenCalled();
  });

  it('yields zero rows when no sources are linked, plainly', async () => {
    const { service } = buildHarness();
    const created = await service.createRun(TENANT, BASE_INPUT as never);
    const result = await service.refreshCandidates(TENANT, created.id);
    expect(result).toEqual({
      runId: created.id,
      total: 0,
      eligible: 0,
      excluded: 0,
    });
  });

  it('cannot pull another tenant’s source data (tenant-scoped end to end)', async () => {
    const { service, runs } = buildHarness(mixedFixtureOptions());
    const created = await createLinkedRun(service);
    // Simulate a run row that somehow carries a foreign source id: the
    // tenant-scoped observation read must refuse, never leak.
    const row = runs.find((r) => r.id === created.id)!;
    row.sourceEvaluationRunId = 'eval-foreign';
    await expect(
      service.refreshCandidates(TENANT, created.id),
    ).rejects.toThrow(NotFoundException);
  });

  it('filters the candidate listing by eligibility', async () => {
    const { service } = buildHarness(mixedFixtureOptions());
    const created = await createLinkedRun(service);
    await service.refreshCandidates(TENANT, created.id);
    const eligible = await service.listCandidates(
      TENANT,
      created.id,
      'ELIGIBLE' as never,
    );
    expect(eligible.total).toBe(7);
    const excluded = await service.listCandidates(
      TENANT,
      created.id,
      'EXCLUDED' as never,
    );
    expect(excluded.total).toBe(5);
  });
});

describe('CvDatasetService — quality report', () => {
  it('reports honest counts, low coverage, and controlled next actions', async () => {
    const { service } = buildHarness({
      ...mixedFixtureOptions(),
      summary: {
        confusion: {
          action: [{ predicted: 'PICKUP', expected: 'RETURN', count: 2 }],
          sku: [{ predicted: 'SKU-A', expected: 'SKU-B', count: 3 }],
        },
      },
    });
    const created = await createLinkedRun(service);
    await service.refreshCandidates(TENANT, created.id);
    const report = await service.qualityReport(TENANT, created.id);
    expect(report.totalEligibleExamples).toBe(7);
    expect(report.totalExcludedExamples).toBe(5);
    expect(report.missedEventCount).toBe(1);
    expect(report.falseTouchCount).toBe(1);
    expect(report.examplesBySku[0]).toMatchObject({ count: 3 });
    expect(report.confusionPairs).toEqual({
      action: [{ predicted: 'PICKUP', expected: 'RETURN', count: 2 }],
      sku: [{ predicted: 'SKU-A', expected: 'SKU-B', count: 3 }],
    });
    // Every class is under the minimum of 5 → warnings, not fake READY.
    expect(report.lowCoverageSkus.length).toBeGreaterThan(0);
    expect(report.lowCoverageActions.length).toBeGreaterThan(0);
    expect(report.leakageWarnings).toContain('SPLITS_NOT_PLANNED');
    expect(report.readiness).toBe('WARNING');
    expect(report.recommendedNextActions).toEqual(
      expect.arrayContaining([
        'COLLECT_MORE_EXAMPLES',
        'REVIEW_PENDING_EVENTS',
        'BALANCE_SKU_COVERAGE',
        'BALANCE_ACTION_COVERAGE',
        'HOLD_BACK_TEST_SET',
        'VERIFY_CONFUSION_PAIRS',
      ]),
    );
    expect(report.safety).toMatchObject({
      orders: 0,
      checkoutSessions: 0,
      paymentIntents: 0,
      paymentEvents: 0,
      inventoryMovements: 0,
    });
  });

  it('is NOT_READY with zero eligible examples and null confusion when nothing is linked', async () => {
    const { service } = buildHarness();
    const created = await service.createRun(TENANT, BASE_INPUT as never);
    const report = await service.qualityReport(TENANT, created.id);
    expect(report.readiness).toBe('NOT_READY');
    expect(report.totalEligibleExamples).toBe(0);
    expect(report.confusionPairs).toBeNull();
    expect(report.examplesBySku).toEqual([]);
  });
});

describe('CvDatasetService — split planner', () => {
  function manySessionsOptions(count: number) {
    return {
      observations: Array.from({ length: count }, (_, index) =>
        observation({
          journeyEventId: `evt-${index}`,
          liveSessionId: `session-${index}`,
          latestReview: review({ reviewId: `rev-${index}` }),
        }),
      ),
    };
  }

  it('is deterministic: replanning produces identical assignments', async () => {
    const build = async () => {
      const harness = buildHarness(manySessionsOptions(60));
      const created = await createLinkedRun(harness.service, {
        sourceTestProtocolId: undefined,
        sourceCalibrationProfileId: undefined,
      });
      await harness.service.refreshCandidates(TENANT, created.id);
      await harness.service.planSplits(TENANT, created.id);
      return new Map(
        harness.candidates.map((row) => [row.sourceId, row.split]),
      );
    };
    const first = await build();
    const second = await build();
    expect([...second.entries()]).toEqual([...first.entries()]);
  });

  it('keeps examples from the same live session in the same split', async () => {
    const options = {
      observations: [
        ...Array.from({ length: 30 }, (_, index) =>
          observation({
            journeyEventId: `evt-a-${index}`,
            liveSessionId: 'session-shared',
            latestReview: review({ reviewId: `rev-a-${index}` }),
          }),
        ),
        ...Array.from({ length: 30 }, (_, index) =>
          observation({
            journeyEventId: `evt-b-${index}`,
            liveSessionId: `session-${index}`,
            latestReview: review({ reviewId: `rev-b-${index}` }),
          }),
        ),
      ],
    };
    const { service, candidates } = buildHarness(options);
    const created = await createLinkedRun(service, {
      sourceTestProtocolId: undefined,
      sourceCalibrationProfileId: undefined,
    });
    await service.refreshCandidates(TENANT, created.id);
    await service.planSplits(TENANT, created.id);
    const sharedSplits = new Set(
      candidates
        .filter((row) => row.liveSessionId === 'session-shared')
        .map((row) => row.split),
    );
    expect(sharedSplits.size).toBe(1);
  });

  it('approximately respects the split percentages over many groups', async () => {
    const { service, candidates } = buildHarness(manySessionsOptions(120));
    const created = await createLinkedRun(service, {
      sourceTestProtocolId: undefined,
      sourceCalibrationProfileId: undefined,
    });
    await service.refreshCandidates(TENANT, created.id);
    const plan = await service.planSplits(TENANT, created.id);
    expect(plan.groupCount).toBe(120);
    const share = (split: string) =>
      candidates.filter((row) => row.split === split).length / 120;
    expect(share('TRAIN')).toBeGreaterThan(0.55);
    expect(share('TRAIN')).toBeLessThan(0.85);
    expect(share('VALIDATION')).toBeGreaterThan(0.0);
    expect(share('VALIDATION')).toBeLessThan(0.3);
    expect(share('TEST')).toBeGreaterThan(0.0);
    expect(share('TEST')).toBeLessThan(0.3);
    expect(plan.splitSummary.HOLDOUT).toBe(0);
  });

  it('forces low-coverage classes into TRAIN with a warning instead of faking quality', async () => {
    const options = {
      observations: [
        // 6 well-covered SKU-A examples in separate sessions...
        ...Array.from({ length: 6 }, (_, index) =>
          observation({
            journeyEventId: `evt-a-${index}`,
            liveSessionId: `session-a-${index}`,
            latestReview: review({ reviewId: `rev-a-${index}` }),
          }),
        ),
        ...Array.from({ length: 6 }, (_, index) =>
          observation({
            journeyEventId: `evt-r-${index}`,
            liveSessionId: `session-a-${index}`,
            eventType: 'PRODUCT_RETURN',
            latestReview: review({
              reviewId: `rev-r-${index}`,
              expectedAction: 'RETURN',
            }),
          }),
        ),
        // ...and ONE rare SKU-RARE example.
        observation({
          journeyEventId: 'evt-rare',
          liveSessionId: 'session-rare',
          predictedProductId: 'prod-rare',
          predictedSku: 'SKU-RARE',
          latestReview: review({ reviewId: 'rev-rare' }),
        }),
      ],
    };
    const { service, candidates } = buildHarness(options);
    const created = await createLinkedRun(service, {
      sourceTestProtocolId: undefined,
      sourceCalibrationProfileId: undefined,
    });
    await service.refreshCandidates(TENANT, created.id);
    const plan = await service.planSplits(TENANT, created.id);
    expect(plan.warnings).toContain('LOW_COVERAGE_SKU_FORCED_TRAIN');
    expect(plan.warnings).toContain('SMALL_DATASET');
    const rare = candidates.find((row) => row.sourceId === 'evt-rare')!;
    expect(rare.split).toBe('TRAIN');
  });

  it('excluded candidates never get a split and empty runs are rejected', async () => {
    const { service, candidates } = buildHarness(mixedFixtureOptions());
    const created = await createLinkedRun(service);
    await service.refreshCandidates(TENANT, created.id);
    await service.planSplits(TENANT, created.id);
    for (const row of candidates.filter(
      (r) => r.eligibility === 'EXCLUDED',
    )) {
      expect(row.split).toBeNull();
    }
    const { service: emptyService } = buildHarness();
    const emptyRun = await emptyService.createRun(TENANT, BASE_INPUT as never);
    await expect(
      emptyService.planSplits(TENANT, emptyRun.id),
    ).rejects.toThrow('no eligible candidates');
  });
});

describe('CvDatasetService — export manifest', () => {
  async function readyRun(
    harness: ReturnType<typeof buildHarness>,
    extra: Record<string, unknown> = {},
  ) {
    const created = await createLinkedRun(harness.service, extra);
    await harness.service.refreshCandidates(TENANT, created.id);
    return created;
  }

  it('requires READY and a complete split plan, then stamps EXPORTED', async () => {
    const harness = buildHarness({
      ...mixedFixtureOptions(),
      zones: [
        { zoneType: 'SHELF_ZONE' },
        { zoneType: 'SHELF_ZONE' },
        { zoneType: 'INTERACTION_ZONE' },
      ],
    });
    const created = await readyRun(harness);
    await expect(
      harness.service.exportManifest(TENANT, created.id),
    ).rejects.toThrow('mark it READY first');
    await harness.service.setStatus(TENANT, created.id, 'READY' as never);
    await expect(
      harness.service.exportManifest(TENANT, created.id),
    ).rejects.toThrow('plan splits before exporting');
    await harness.service.planSplits(TENANT, created.id);
    const result = await harness.service.exportManifest(TENANT, created.id);
    expect(result.rowCount).toBe(7);
    expect(result.manifestVersion).toBe(1);
    expect(result.manifest.candidates).toHaveLength(7);
    expect(result.manifest.status).toBe('EXPORTED');
    expect(result.manifest.trainingNotes).toContain('NO_ACCURACY_GUARANTEE');
    expect(result.manifest.evidenceStatus).toBe(
      'REFERENCES_ONLY_NO_MEDIA_IN_PHASE18',
    );
    expect(result.manifest.calibration).toMatchObject({
      calibrationProfileId: 'cal-1',
      calibrationVersion: 2,
      zoneSummary: {
        total: 3,
        shelfZones: 2,
        interactionZones: 1,
        ignoreZones: 0,
        entryExitZones: 0,
      },
    });
    const detail = await harness.service.runDetail(TENANT, created.id);
    expect(detail.status).toBe('EXPORTED');
    expect(detail.exportedAt).not.toBeNull();
    // Re-export from EXPORTED is allowed (same data, fresh stamp).
    const again = await harness.service.exportManifest(TENANT, created.id);
    expect(again.rowCount).toBe(7);
  });

  it('emits no source/path/credential/media/weights text anywhere in the payload', async () => {
    const harness = buildHarness(mixedFixtureOptions());
    const created = await readyRun(harness);
    await harness.service.setStatus(TENANT, created.id, 'READY' as never);
    await harness.service.planSplits(TENANT, created.id);
    const result = await harness.service.exportManifest(TENANT, created.id);
    const raw = JSON.stringify(result);
    expect(raw).not.toContain(assemble('rt', 'sp'));
    expect(raw).not.toContain(assemble(':', '/', '/'));
    expect(raw).not.toContain(assemble('C:', '\\'));
    expect(raw).not.toContain(assemble('.m', 'p4'));
    expect(raw).not.toContain(assemble('credential', 'Ref'));
    expect(raw).not.toContain(assemble('CAMERA_', 'SECRET_SLOT'));
    expect(raw).not.toContain(assemble('base', '64'));
    expect(raw).not.toContain(assemble('model', 'Weights'));
    expect(raw.toLowerCase()).not.toContain('embedding');
  });

  it('null calibration when no profile is linked', async () => {
    const harness = buildHarness(mixedFixtureOptions());
    const created = await readyRun(harness, {
      sourceCalibrationProfileId: undefined,
    });
    await harness.service.setStatus(TENANT, created.id, 'READY' as never);
    await harness.service.planSplits(TENANT, created.id);
    const result = await harness.service.exportManifest(TENANT, created.id);
    expect(result.manifest.calibration).toBeNull();
  });
});

describe('CvDatasetService — model tuning report (advisory only)', () => {
  it('maps purpose to task, mirrors readiness, and never projects accuracy', async () => {
    const { service } = buildHarness(mixedFixtureOptions());
    const created = await createLinkedRun(service, {
      purpose: 'MISSED_EVENT_RECOVERY',
    });
    await service.refreshCandidates(TENANT, created.id);
    const before = await service.modelTuningReport(TENANT, created.id);
    expect(before.recommendedModelTask).toBe('ACTION_RECOGNITION');
    expect(before.tuningReadiness).toBe('NOT_READY'); // splits unplanned
    await service.planSplits(TENANT, created.id);
    const report = await service.modelTuningReport(TENANT, created.id);
    expect(report.tuningReadiness).toBe('WARNING');
    expect(report.datasetReadiness).toBe('WARNING');
    expect(report.classCoverageSummary.skuClasses).toBeGreaterThan(0);
    expect(report.recommendedThresholdReview.suggested).toBe(true); // LOW bucket exists
    expect(report.suggestedHoldoutPlan).toEqual({
      holdoutCount: 0,
      note: 'HOLDOUT_NOT_AUTO_ASSIGNED_IN_MVP',
    });
    expect(report.advisory).toBe(
      'ADVISORY_ONLY_NO_TRAINING_PERFORMED_NO_ACCURACY_GUARANTEE',
    );
    const raw = JSON.stringify(report);
    // No percentage claims and no accuracy projections, ever.
    expect(raw).not.toMatch(/\d+(\.\d+)?\s*%/);
    expect(raw.toLowerCase()).not.toContain('will improve');
    expect(report.suggestedEvaluationMetrics).toContain('MISSED_EVENT_RATE');
  });

  it('is NOT_READY on an empty run', async () => {
    const { service } = buildHarness();
    const created = await service.createRun(TENANT, BASE_INPUT as never);
    const report = await service.modelTuningReport(TENANT, created.id);
    expect(report.datasetReadiness).toBe('NOT_READY');
    expect(report.tuningReadiness).toBe('NOT_READY');
    expect(report.likelyConfusionPairs).toEqual([]);
  });
});
