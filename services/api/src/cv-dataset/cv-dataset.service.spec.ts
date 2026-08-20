import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CvDatasetService } from './cv-dataset.service';
import { splitBucket } from './dataset-hash';

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

interface CameraFixture {
  cameraSourceId: string;
  sourceType: string;
}

function buildHarness(
  options: {
    observations?: ObservationFixture[];
    missedEvents?: Record<string, unknown>[];
    summary?: Record<string, unknown> | null;
    scenarios?: Record<string, unknown>[];
    zones?: { zoneType: string }[];
    /** Camera behind every live session unless overridden per session. */
    defaultCamera?: CameraFixture;
    cameraBySession?: Record<string, CameraFixture>;
    protocolEvaluationRunId?: string | null;
    profileCameraSourceId?: string;
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
            ? {
                id: 'proto-1',
                evaluationRunId:
                  'protocolEvaluationRunId' in options
                    ? (options.protocolEvaluationRunId ?? null)
                    : 'eval-1',
              }
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
                cameraSourceId: options.profileCameraSourceId ?? 'camera-1',
                name: 'Front shelf profile',
                calibrationVersion: 2,
                orientation: 'LANDSCAPE',
                cameraMount: 'FRONT_SHELF',
              }
            : null,
      ),
      updateMany: jest.fn(),
    },
    liveCameraSession: {
      findMany: jest.fn(
        async (args: { where: { id?: { in?: string[] } } }) => {
          const ids = args.where.id?.in ?? [];
          return ids.map((id) => {
            const camera = (options.cameraBySession ?? {})[id] ??
              options.defaultCamera ?? {
                cameraSourceId: 'camera-1',
                sourceType: 'RTSP_SHADOW',
              };
            return {
              id,
              cameraSourceId: camera.cameraSourceId,
              cameraSource: { sourceType: camera.sourceType },
            };
          });
        },
      ),
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
      eligible: 6,
      excluded: 6,
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

    // Missed-event reviews carry no evidence locator in Phase 15, so
    // they are EXCLUDED — visible, counted, never pretended trainable.
    expect(bydSource('rev-missed')).toMatchObject({
      sourceType: 'MISSED_EVENT',
      eligibility: 'EXCLUDED',
      exclusionReason: 'MISSING_EVIDENCE_LOCATOR',
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

    // Calibration is stamped ONLY on candidates whose live session's
    // camera matches the linked profile; sessionless rows get null. The
    // MVP nulls are never fabricated.
    for (const row of candidates) {
      expect(row.calibrationProfileId).toBe(
        row.liveSessionId ? 'cal-1' : null,
      );
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
    expect(eligible.total).toBe(6);
    const excluded = await service.listCandidates(
      TENANT,
      created.id,
      'EXCLUDED' as never,
    );
    expect(excluded.total).toBe(6);
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
    expect(report.totalEligibleExamples).toBe(6);
    expect(report.totalExcludedExamples).toBe(6);
    // Counted even though the missed-event row is EXCLUDED (no locator).
    expect(report.missedEventCount).toBe(1);
    expect(report.falseTouchCount).toBe(1);
    expect(report.examplesBySku[0]).toMatchObject({ count: 4 });
    // Low-coverage entries now also report INDEPENDENT group counts.
    expect(report.lowCoverageSkus[0]).toHaveProperty('groups');
    expect(report.imbalanceWarnings).toContain('SMALL_DATASET');
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
  // The mixed fixture is a SMALL dataset whose classes sit below the
  // default minimums, so the planner forces everything into TRAIN.
  // With nonzero validation/test percentages that would (correctly)
  // block export as REQUESTED_*_SPLIT_EMPTY — so these runs request
  // 100/0/0, which is explicitly allowed.
  async function readyRun(
    harness: ReturnType<typeof buildHarness>,
    extra: Record<string, unknown> = {},
  ) {
    const created = await createLinkedRun(harness.service, {
      trainSplitPercent: 100,
      validationSplitPercent: 0,
      testSplitPercent: 0,
      ...extra,
    });
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
    expect(result.rowCount).toBe(6);
    expect(result.manifestVersion).toBe(1);
    expect(result.manifest.candidates).toHaveLength(6);
    expect(result.manifest.status).toBe('EXPORTED');
    // Locator-less missed events can never reach a manifest.
    expect(
      result.manifest.candidates.every(
        (row: { sourceType: string }) => row.sourceType !== 'MISSED_EVENT',
      ),
    ).toBe(true);
    // The durable small-dataset warning ships with the manifest.
    expect(result.manifest.warnings).toContain('SMALL_DATASET');
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
    expect(again.rowCount).toBe(6);
    // ...but the exported snapshot is frozen: no refresh, no replan.
    await expect(
      harness.service.refreshCandidates(TENANT, created.id),
    ).rejects.toThrow('cannot be refreshed on a EXPORTED run');
    await expect(
      harness.service.planSplits(TENANT, created.id),
    ).rejects.toThrow('cannot be planned on a EXPORTED run');
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
  it('mirrors readiness, carries durable warnings, and never projects accuracy', async () => {
    const { service } = buildHarness(mixedFixtureOptions());
    const created = await createLinkedRun(service, {
      trainSplitPercent: 100,
      validationSplitPercent: 0,
      testSplitPercent: 0,
    });
    await service.refreshCandidates(TENANT, created.id);
    const before = await service.modelTuningReport(TENANT, created.id);
    expect(before.tuningReadiness).toBe('NOT_READY'); // splits unplanned
    await service.planSplits(TENANT, created.id);
    const report = await service.modelTuningReport(TENANT, created.id);
    expect(report.recommendedModelTask).toBe('MIXED');
    expect(report.tuningReadiness).toBe('WARNING');
    expect(report.datasetReadiness).toBe('WARNING');
    // Durable small-dataset caution restated on the tuning surface.
    expect(report.warnings).toContain('SMALL_DATASET');
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

  it('MISSED_EVENT_RECOVERY without locatable missed events is NOT_READY', async () => {
    const { service } = buildHarness(mixedFixtureOptions());
    const created = await createLinkedRun(service, {
      purpose: 'MISSED_EVENT_RECOVERY',
    });
    await service.refreshCandidates(TENANT, created.id);
    // Missed events are all EXCLUDED (no evidence locator), so this
    // purpose has zero usable labels — never READY, never overstated.
    const quality = await service.qualityReport(TENANT, created.id);
    expect(quality.readiness).toBe('NOT_READY');
    expect(quality.imbalanceWarnings).toContain('INSUFFICIENT_TASK_LABELS');
    const report = await service.modelTuningReport(TENANT, created.id);
    expect(report.datasetReadiness).toBe('NOT_READY');
    expect(report.tuningReadiness).toBe('NOT_READY');
    // The mapped task (action recognition) has usable labels, so the
    // recommendation stays honest without naming an unusable task.
    expect(report.recommendedModelTask).toBe('ACTION_RECOGNITION');
    await expect(
      service.setStatus(TENANT, created.id, 'READY' as never),
    ).rejects.toThrow('run is not ready');
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

describe('CvDatasetService — Codex P1 hardening', () => {
  const FULL_TRAIN = {
    trainSplitPercent: 100,
    validationSplitPercent: 0,
    testSplitPercent: 0,
  };

  function sessions(count: number, over: Partial<ObservationFixture> = {}) {
    return Array.from({ length: count }, (_, index) =>
      observation({
        journeyEventId: `evt-${index}`,
        liveSessionId: `session-${index}`,
        latestReview: review({ reviewId: `rev-${index}` }),
        ...over,
      }),
    );
  }

  it('export rejects stale candidates after a newer source review, then recovers on refresh', async () => {
    const opts = mixedFixtureOptions();
    const harness = buildHarness(opts);
    const created = await createLinkedRun(harness.service, FULL_TRAIN);
    await harness.service.refreshCandidates(TENANT, created.id);
    await harness.service.setStatus(TENANT, created.id, 'READY' as never);
    await harness.service.planSplits(TENANT, created.id);
    // An operator appends a newer UNCERTAIN review on the still-open
    // evaluation run AFTER the candidates were refreshed.
    (opts.observations[0].latestReview as Record<string, unknown>).verdict =
      'UNCERTAIN';
    const error = await harness.service
      .exportManifest(TENANT, created.id)
      .then(
        () => null,
        (thrown: Error) => thrown,
      );
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error!.message).toContain('CV_DATASET_STALE_CANDIDATES');
    expect(error!.message).toContain('refresh candidates');
    // The controlled message never echoes source values.
    expect(error!.message).not.toContain('UNCERTAIN');
    expect(error!.message).not.toContain('SKU-A');
    // Refresh + replan picks up the new truth; export then proceeds.
    await harness.service.refreshCandidates(TENANT, created.id);
    await harness.service.planSplits(TENANT, created.id);
    const result = await harness.service.exportManifest(TENANT, created.id);
    expect(result.rowCount).toBe(5);
  });

  it('export rejects stale candidates after a scenario result is re-recorded', async () => {
    const opts = mixedFixtureOptions();
    const harness = buildHarness(opts);
    const created = await createLinkedRun(harness.service, FULL_TRAIN);
    await harness.service.refreshCandidates(TENANT, created.id);
    await harness.service.setStatus(TENANT, created.id, 'READY' as never);
    await harness.service.planSplits(TENANT, created.id);
    (opts.scenarios![0] as Record<string, unknown>).result = 'INCONCLUSIVE';
    await expect(
      harness.service.exportManifest(TENANT, created.id),
    ).rejects.toThrow('CV_DATASET_STALE_CANDIDATES');
    await harness.service.refreshCandidates(TENANT, created.id);
    await harness.service.planSplits(TENANT, created.id);
    const result = await harness.service.exportManifest(TENANT, created.id);
    expect(result.rowCount).toBe(5);
  });

  it('export validation runs on the LOCKED candidate snapshot (refresh/plan races)', async () => {
    const harness = buildHarness(mixedFixtureOptions());
    const created = await createLinkedRun(harness.service, FULL_TRAIN);
    await harness.service.refreshCandidates(TENANT, created.id);
    await harness.service.setStatus(TENANT, created.id, 'READY' as never);
    await harness.service.planSplits(TENANT, created.id);
    // A concurrent planner reset lands JUST as the export lock is
    // acquired: the locked re-read must see it and refuse.
    harness.prisma.$queryRaw.mockImplementationOnce(async () => {
      const row = harness.candidates.find(
        (r: Record<string, unknown>) => r.eligibility === 'ELIGIBLE',
      )!;
      row.split = null;
      return [];
    });
    await expect(
      harness.service.exportManifest(TENANT, created.id),
    ).rejects.toThrow('plan splits before exporting');
    await harness.service.planSplits(TENANT, created.id);
    // A concurrent refresh deletes a candidate row at lock time: the
    // manifest would no longer cover an eligible source row → stale.
    harness.prisma.$queryRaw.mockImplementationOnce(async () => {
      const index = harness.candidates.findIndex(
        (r: Record<string, unknown>) => r.eligibility === 'ELIGIBLE',
      );
      harness.candidates.splice(index, 1);
      return [];
    });
    await expect(
      harness.service.exportManifest(TENANT, created.id),
    ).rejects.toThrow('CV_DATASET_STALE_CANDIDATES');
    // Recover, then the manifest matches the persisted snapshot exactly.
    await harness.service.refreshCandidates(TENANT, created.id);
    await harness.service.planSplits(TENANT, created.id);
    const result = await harness.service.exportManifest(TENANT, created.id);
    const persistedEligible = harness.candidates.filter(
      (r: Record<string, unknown>) => r.eligibility === 'ELIGIBLE',
    ).length;
    expect(result.rowCount).toBe(persistedEligible);
    expect(result.manifest.candidates).toHaveLength(persistedEligible);
  });

  it('SKU_CLASSIFICATION with zero SKU labels is NOT_READY and cannot export', async () => {
    const harness = buildHarness({
      observations: sessions(3, {
        predictedProductId: null,
        predictedSku: null,
      }),
    });
    const created = await createLinkedRun(harness.service, {
      purpose: 'SKU_CLASSIFICATION',
      sourceTestProtocolId: undefined,
      sourceCalibrationProfileId: undefined,
      ...FULL_TRAIN,
    });
    await harness.service.refreshCandidates(TENANT, created.id);
    const quality = await harness.service.qualityReport(TENANT, created.id);
    expect(quality.readiness).toBe('NOT_READY');
    expect(quality.imbalanceWarnings).toContain('NO_SKU_LABELS_FOR_TASK');
    await expect(
      harness.service.setStatus(TENANT, created.id, 'READY' as never),
    ).rejects.toThrow('run is not ready');
    await harness.service.planSplits(TENANT, created.id);
    // Even a run that somehow reached READY cannot export for a task
    // it has zero usable labels for.
    harness.runs.find((row) => row.id === created.id)!.status = 'READY';
    await expect(
      harness.service.exportManifest(TENANT, created.id),
    ).rejects.toThrow('no usable labels for its purpose');
    // The tuning report never recommends the label-less task.
    const report = await harness.service.modelTuningReport(TENANT, created.id);
    expect(report.recommendedModelTask).toBe('ACTION_RECOGNITION');
    expect(report.tuningReadiness).toBe('NOT_READY');
  });

  it('ACTION_RECOGNITION with usable action labels stays usable', async () => {
    const { service } = buildHarness(mixedFixtureOptions());
    const created = await createLinkedRun(service, {
      purpose: 'ACTION_RECOGNITION',
    });
    await service.refreshCandidates(TENANT, created.id);
    const quality = await service.qualityReport(TENANT, created.id);
    expect(quality.readiness).toBe('WARNING');
    expect(quality.imbalanceWarnings).not.toContain(
      'NO_ACTION_LABELS_FOR_TASK',
    );
  });

  it('requested validation/test splits must be nonempty; 100/0/0 stays allowed', async () => {
    // 3 examples of ONE sku, below the default minimum of 5: the
    // planner (correctly) forces everything into TRAIN.
    const harness = buildHarness({ observations: sessions(3) });
    const created = await createLinkedRun(harness.service, {
      sourceTestProtocolId: undefined,
      sourceCalibrationProfileId: undefined,
    });
    await harness.service.refreshCandidates(TENANT, created.id);
    const plan = await harness.service.planSplits(TENANT, created.id);
    expect(plan.warnings).toContain('REQUESTED_VALIDATION_SPLIT_EMPTY');
    expect(plan.warnings).toContain('REQUESTED_TEST_SPLIT_EMPTY');
    const quality = await harness.service.qualityReport(TENANT, created.id);
    expect(quality.leakageWarnings).toContain(
      'REQUESTED_VALIDATION_SPLIT_EMPTY',
    );
    expect(quality.readiness).toBe('NOT_READY');
    await expect(
      harness.service.setStatus(TENANT, created.id, 'READY' as never),
    ).rejects.toThrow('run is not ready');
    harness.runs.find((row) => row.id === created.id)!.status = 'READY';
    await expect(
      harness.service.exportManifest(TENANT, created.id),
    ).rejects.toThrow('requested validation/test split is empty');

    // Explicit 100/0/0 requests nothing it cannot fill.
    const explicit = buildHarness({ observations: sessions(3) });
    const trainOnly = await createLinkedRun(explicit.service, {
      sourceTestProtocolId: undefined,
      sourceCalibrationProfileId: undefined,
      ...FULL_TRAIN,
    });
    await explicit.service.refreshCandidates(TENANT, trainOnly.id);
    const trainPlan = await explicit.service.planSplits(TENANT, trainOnly.id);
    expect(trainPlan.warnings).not.toContain('REQUESTED_VALIDATION_SPLIT_EMPTY');
    expect(trainPlan.warnings).not.toContain('REQUESTED_TEST_SPLIT_EMPTY');
    await explicit.service.setStatus(TENANT, trainOnly.id, 'READY' as never);
    const result = await explicit.service.exportManifest(TENANT, trainOnly.id);
    expect(result.rowCount).toBe(3);
  });

  it('FILE_REPLAY-backed data never gets calibration advice; live data still does', async () => {
    const replay = buildHarness({
      ...mixedFixtureOptions(),
      defaultCamera: { cameraSourceId: 'camera-1', sourceType: 'FILE_REPLAY' },
    });
    const replayRun = await createLinkedRun(replay.service, {
      sourceCalibrationProfileId: undefined,
    });
    await replay.service.refreshCandidates(TENANT, replayRun.id);
    const replayQuality = await replay.service.qualityReport(
      TENANT,
      replayRun.id,
    );
    expect(replayQuality.recommendedNextActions).not.toContain(
      'IMPROVE_CAMERA_CALIBRATION',
    );

    const live = buildHarness(mixedFixtureOptions());
    const liveRun = await createLinkedRun(live.service, {
      sourceCalibrationProfileId: undefined,
    });
    await live.service.refreshCandidates(TENANT, liveRun.id);
    const liveQuality = await live.service.qualityReport(TENANT, liveRun.id);
    expect(liveQuality.recommendedNextActions).toContain(
      'IMPROVE_CAMERA_CALIBRATION',
    );
  });

  it('a calibration profile for a different camera is rejected for live data, exempt for FILE_REPLAY', async () => {
    const mismatched = buildHarness({
      ...mixedFixtureOptions(),
      profileCameraSourceId: 'camera-2',
    });
    const created = await createLinkedRun(mismatched.service);
    const error = await mismatched.service
      .refreshCandidates(TENANT, created.id)
      .then(
        () => null,
        (thrown: Error) => thrown,
      );
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error!.message).toContain('CV_DATASET_CALIBRATION_CAMERA_MISMATCH');
    expect(error!.message).not.toContain('camera-2');

    // FILE_REPLAY sessions are exempt (calibration NOT_APPLICABLE):
    // refresh succeeds, nothing is stamped, and the manifest carries no
    // calibration snapshot for footage it does not describe.
    const replay = buildHarness({
      ...mixedFixtureOptions(),
      profileCameraSourceId: 'camera-2',
      defaultCamera: { cameraSourceId: 'camera-1', sourceType: 'FILE_REPLAY' },
    });
    const replayRun = await createLinkedRun(replay.service, FULL_TRAIN);
    await replay.service.refreshCandidates(TENANT, replayRun.id);
    for (const row of replay.candidates) {
      expect(row.calibrationProfileId).toBeNull();
    }
    await replay.service.setStatus(TENANT, replayRun.id, 'READY' as never);
    await replay.service.planSplits(TENANT, replayRun.id);
    const result = await replay.service.exportManifest(TENANT, replayRun.id);
    expect(result.manifest.calibration).toBeNull();
  });

  it('evaluation/protocol lineage must be consistent; protocol-only runs keep the protocol lineage', async () => {
    const mismatched = buildHarness({
      ...mixedFixtureOptions(),
      protocolEvaluationRunId: 'eval-2',
    });
    await expect(createLinkedRun(mismatched.service)).rejects.toThrow(
      'CV_DATASET_SOURCE_LINEAGE_MISMATCH',
    );

    const protocolOnly = buildHarness(mixedFixtureOptions());
    const created = await protocolOnly.service.createRun(TENANT, {
      ...BASE_INPUT,
      sourceTestProtocolId: 'proto-1',
    } as never);
    await protocolOnly.service.refreshCandidates(TENANT, created.id);
    const scenarioRows = protocolOnly.candidates.filter(
      (row) => row.sourceType === 'PROTOCOL_SCENARIO',
    );
    expect(scenarioRows.length).toBeGreaterThan(0);
    for (const row of scenarioRows) {
      // The protocol's OWN evaluation run — never null, never an
      // unrelated linked run.
      expect(row.evaluationRunId).toBe('eval-1');
    }
  });

  it('correction verdicts without a real, different correction are EXCLUDED', async () => {
    const harness = buildHarness({
      observations: [
        observation({
          journeyEventId: 'evt-ws-missing',
          latestReview: review({
            verdict: 'WRONG_SKU',
            expectedProductId: null,
            expectedSku: null,
          }),
        }),
        observation({
          journeyEventId: 'evt-ws-same',
          latestReview: review({
            verdict: 'WRONG_SKU',
            expectedProductId: 'prod-a',
            expectedSku: 'SKU-A', // same as the prediction
          }),
        }),
        observation({
          journeyEventId: 'evt-wa-unknown',
          latestReview: review({
            verdict: 'WRONG_ACTION',
            expectedAction: 'UNKNOWN',
          }),
        }),
        observation({
          journeyEventId: 'evt-wa-same',
          latestReview: review({
            verdict: 'WRONG_ACTION',
            expectedAction: 'PICKUP', // same as the prediction
          }),
        }),
        observation({
          journeyEventId: 'evt-wa-valid',
          latestReview: review({
            verdict: 'WRONG_ACTION',
            expectedAction: 'RETURN',
          }),
        }),
      ],
    });
    const created = await createLinkedRun(harness.service, {
      sourceTestProtocolId: undefined,
      sourceCalibrationProfileId: undefined,
    });
    const result = await harness.service.refreshCandidates(TENANT, created.id);
    expect(result.eligible).toBe(1);
    const byId = (sourceId: string) =>
      harness.candidates.find((row) => row.sourceId === sourceId)!;
    expect(byId('evt-ws-missing')).toMatchObject({
      eligibility: 'EXCLUDED',
      exclusionReason: 'MISSING_CORRECTED_SKU',
    });
    expect(byId('evt-ws-same')).toMatchObject({
      eligibility: 'EXCLUDED',
      exclusionReason: 'CORRECTION_NOT_DIFFERENT',
    });
    expect(byId('evt-wa-unknown')).toMatchObject({
      eligibility: 'EXCLUDED',
      exclusionReason: 'MISSING_CORRECTED_ACTION',
    });
    expect(byId('evt-wa-same')).toMatchObject({
      eligibility: 'EXCLUDED',
      exclusionReason: 'CORRECTION_NOT_DIFFERENT',
    });
    expect(byId('evt-wa-valid')).toMatchObject({
      eligibility: 'ELIGIBLE',
      correctedActionLabel: 'RETURN',
    });
  });

  it('the same source group gets the same split across different dataset runs', async () => {
    const harness = buildHarness({ observations: sessions(40) });
    const linkOnly = {
      sourceTestProtocolId: undefined,
      sourceCalibrationProfileId: undefined,
    };
    const runA = await createLinkedRun(harness.service, linkOnly);
    const runB = await createLinkedRun(harness.service, linkOnly);
    await harness.service.refreshCandidates(TENANT, runA.id);
    await harness.service.refreshCandidates(TENANT, runB.id);
    await harness.service.planSplits(TENANT, runA.id);
    await harness.service.planSplits(TENANT, runB.id);
    const splitsOf = (runId: string) =>
      new Map(
        harness.candidates
          .filter((row) => row.runId === runId)
          .map((row) => [row.sourceId, row.split]),
      );
    const a = splitsOf(runA.id);
    const b = splitsOf(runB.id);
    expect(a.size).toBe(40);
    for (const [sourceId, split] of a) {
      expect(b.get(sourceId)).toBe(split);
    }
    // Sanity: the hash actually spread groups across more than one
    // split (otherwise stability would be vacuous).
    expect(new Set(a.values()).size).toBeGreaterThan(1);
  });

  it('a class hashed entirely out of TRAIN is pulled back in with a warning', async () => {
    // Pick a session id whose bucket deterministically lands OUTSIDE
    // the 70% TRAIN band, so the rare class starts in VALIDATION/TEST.
    let rareSession = '';
    for (let index = 0; index < 5000; index += 1) {
      const candidate = `session-x-${index}`;
      if (splitBucket(`${TENANT}:${candidate}`) >= 7000) {
        rareSession = candidate;
        break;
      }
    }
    expect(rareSession).not.toBe('');
    const harness = buildHarness({
      observations: [
        ...sessions(10),
        observation({
          journeyEventId: 'evt-rare',
          liveSessionId: rareSession,
          predictedProductId: 'prod-rare',
          predictedSku: 'SKU-RARE',
          latestReview: review({ reviewId: 'rev-rare' }),
        }),
      ],
    });
    const created = await createLinkedRun(harness.service, {
      sourceTestProtocolId: undefined,
      sourceCalibrationProfileId: undefined,
      minReviewedExamplesPerSku: 1,
      minReviewedExamplesPerAction: 1,
    });
    await harness.service.refreshCandidates(TENANT, created.id);
    const plan = await harness.service.planSplits(TENANT, created.id);
    expect(plan.warnings).toContain('CLASS_MISSING_TRAIN_SPLIT');
    const rare = harness.candidates.find(
      (row) => row.sourceId === 'evt-rare',
    )!;
    expect(rare.split).toBe('TRAIN');
  });

  it('many near-duplicates from one session count as ONE independent group', async () => {
    const harness = buildHarness({
      observations: Array.from({ length: 6 }, (_, index) =>
        observation({
          journeyEventId: `evt-dup-${index}`,
          liveSessionId: 'session-one',
          latestReview: review({ reviewId: `rev-dup-${index}` }),
        }),
      ),
    });
    const created = await createLinkedRun(harness.service, {
      sourceTestProtocolId: undefined,
      sourceCalibrationProfileId: undefined,
    });
    await harness.service.refreshCandidates(TENANT, created.id);
    const quality = await harness.service.qualityReport(TENANT, created.id);
    // 6 examples ≥ the minimum of 5, but only ONE independent group.
    expect(quality.lowCoverageSkus).toEqual([]);
    expect(quality.imbalanceWarnings).toContain(
      'LOW_INDEPENDENT_GROUP_COVERAGE',
    );
  });
});
