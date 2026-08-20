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
  /** Owning tenant of the CameraSource row — defaults to TENANT. A
   *  foreign tenant simulates a malformed session→camera reference. */
  tenantId?: string;
}

/** Finds session ids whose STABLE bucket (tenant + session key, no run
 *  id) lands inside [lower, upper) — lets tests place groups in a split
 *  band deterministically instead of relying on hash luck. */
function sessionsInBand(
  prefix: string,
  count: number,
  lower: number,
  upper: number,
): string[] {
  const found: string[] = [];
  for (let index = 0; index < 20000 && found.length < count; index += 1) {
    const id = `${prefix}-${index}`;
    const bucket = splitBucket(`${TENANT}:${id}`);
    if (bucket >= lower && bucket < upper) {
      found.push(id);
    }
  }
  expect(found).toHaveLength(count);
  return found;
}

function buildHarness(
  options: {
    observations?: ObservationFixture[];
    missedEvents?: Record<string, unknown>[];
    summary?: Record<string, unknown> | null;
    scenarios?: Record<string, unknown>[];
    zones?: { zoneType: string; updatedAt?: Date }[];
    /** cal-1's updatedAt — read at call time, so tests can mutate the
     *  options object to simulate an edit after refresh. */
    profileUpdatedAt?: Date;
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
                updatedAt:
                  options.profileUpdatedAt ??
                  new Date('2026-08-20T08:00:00.000Z'),
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
              // Deliberately present, as an UNSCOPED include would
              // return it — the service must ignore this and resolve
              // sourceType through the tenant-scoped cameraSource query.
              cameraSource: { sourceType: camera.sourceType },
            };
          });
        },
      ),
    },
    cameraSource: {
      findMany: jest.fn(
        async (args: {
          where: { tenantId?: string; id?: { in?: string[] } };
        }) => {
          const ids = args.where.id?.in ?? [];
          const fixtures = [
            ...Object.values(options.cameraBySession ?? {}),
            options.defaultCamera ?? {
              cameraSourceId: 'camera-1',
              sourceType: 'RTSP_SHADOW',
            },
          ];
          const rows: { id: string; sourceType: string }[] = [];
          for (const id of new Set(ids)) {
            const camera = fixtures.find((fix) => fix.cameraSourceId === id);
            if (camera && (camera.tenantId ?? TENANT) === args.where.tenantId) {
              rows.push({ id, sourceType: camera.sourceType });
            }
          }
          return rows;
        },
      ),
      updateMany: jest.fn(),
    },
    cameraCalibrationZone: {
      findMany: jest.fn(async () =>
        (options.zones ?? []).map((zone) => ({
          updatedAt: new Date('2026-08-20T08:00:00.000Z'),
          ...zone,
        })),
      ),
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
    // SKU classes are CONFIRMED labels only: the false-touch row's
    // predicted SKU-A is reference metadata, not a fourth example.
    expect(report.examplesBySku[0]).toMatchObject({ sku: 'SKU-A', count: 3 });
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

  it('never overrides the stable assignment for low-coverage classes', async () => {
    // One rare-SKU session deterministically OUTSIDE the 70% TRAIN
    // band: the stable hash keeps it there. The planner warns and the
    // run is blocked (see the hardening suite) — the group is never
    // dragged into TRAIN for this run's composition only.
    const [rareSession] = sessionsInBand('session-x', 1, 7000, 10000);
    const trainSessions = sessionsInBand('session-t', 6, 0, 7000);
    const { service, candidates } = buildHarness({
      observations: [
        ...trainSessions.map((liveSessionId, index) =>
          observation({
            journeyEventId: `evt-a-${index}`,
            liveSessionId,
            latestReview: review({ reviewId: `rev-a-${index}` }),
          }),
        ),
        observation({
          journeyEventId: 'evt-rare',
          liveSessionId: rareSession,
          predictedProductId: 'prod-rare',
          predictedSku: 'SKU-RARE',
          latestReview: review({ reviewId: 'rev-rare' }),
        }),
      ],
    });
    const created = await createLinkedRun(service, {
      sourceTestProtocolId: undefined,
      sourceCalibrationProfileId: undefined,
    });
    await service.refreshCandidates(TENANT, created.id);
    const plan = await service.planSplits(TENANT, created.id);
    expect(plan.warnings).toContain('SMALL_DATASET');
    expect(plan.warnings).toContain('CLASS_MISSING_TRAIN_SPLIT');
    expect(plan.warnings).toContain('INSUFFICIENT_STABLE_SPLIT_COVERAGE');
    expect(plan.warnings).not.toContain('LOW_COVERAGE_SKU_FORCED_TRAIN');
    const rare = candidates.find((row) => row.sourceId === 'evt-rare')!;
    expect(rare.split).not.toBe('TRAIN');
    expect(rare.split).not.toBeNull();
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
  // The mixed fixture is a SMALL dataset: with three-way percentages
  // the stable hash could leave a requested split empty or a class
  // without TRAIN coverage, and export would (correctly) block. These
  // runs request 100/0/0 — explicitly allowed — so every group lands
  // in TRAIN deterministically.
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
    // 3 sessions that all hash into the 70% TRAIN band: the stable
    // assignment leaves the requested validation/test splits EMPTY,
    // which must block readiness and export — never be glossed over.
    const trainSessions = sessionsInBand('session-t', 3, 0, 7000);
    const trainOnlyObservations = trainSessions.map((liveSessionId, index) =>
      observation({
        journeyEventId: `evt-${index}`,
        liveSessionId,
        latestReview: review({ reviewId: `rev-${index}` }),
      }),
    );
    const harness = buildHarness({ observations: trainOnlyObservations });
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
        // Product-ID equality is canonical: same product id → not a
        // correction, even when the predicted SKU snapshot is null...
        observation({
          journeyEventId: 'evt-ws-id-same-null-sku',
          predictedSku: null,
          latestReview: review({
            verdict: 'WRONG_SKU',
            expectedProductId: 'prod-a',
            expectedSku: 'SKU-A2',
          }),
        }),
        // ...or when the SKU snapshots literally differ.
        observation({
          journeyEventId: 'evt-ws-id-same-diff-sku',
          latestReview: review({
            verdict: 'WRONG_SKU',
            expectedProductId: 'prod-a',
            expectedSku: 'SKU-A-VARIANT',
          }),
        }),
        // A genuinely different product stays eligible even when the
        // SKU snapshot text happens to match.
        observation({
          journeyEventId: 'evt-ws-id-diff',
          latestReview: review({
            verdict: 'WRONG_SKU',
            expectedProductId: 'prod-b',
            expectedSku: 'SKU-A',
          }),
        }),
      ],
    });
    const created = await createLinkedRun(harness.service, {
      sourceTestProtocolId: undefined,
      sourceCalibrationProfileId: undefined,
    });
    const result = await harness.service.refreshCandidates(TENANT, created.id);
    expect(result.eligible).toBe(2);
    const byId = (sourceId: string) =>
      harness.candidates.find((row) => row.sourceId === sourceId)!;
    expect(byId('evt-ws-id-same-null-sku')).toMatchObject({
      eligibility: 'EXCLUDED',
      exclusionReason: 'CORRECTION_NOT_DIFFERENT',
    });
    expect(byId('evt-ws-id-same-diff-sku')).toMatchObject({
      eligibility: 'EXCLUDED',
      exclusionReason: 'CORRECTION_NOT_DIFFERENT',
    });
    expect(byId('evt-ws-id-diff')).toMatchObject({
      eligibility: 'ELIGIBLE',
      skuId: 'prod-b',
    });
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

  it('a class stably hashed out of TRAIN stays put — the run is warned and blocked, never rearranged', async () => {
    // Groups placed deterministically: plenty of SKU-A in the TRAIN
    // band, one SKU-A group in each evaluation band (so no requested
    // split is empty), and the rare class ONLY in the validation band.
    const trainSessions = sessionsInBand('session-t', 6, 0, 7000);
    const [validationSession] = sessionsInBand('session-v', 1, 7000, 8500);
    const [testSession] = sessionsInBand('session-w', 1, 8500, 10000);
    const [rareSession] = sessionsInBand('session-x', 1, 7000, 8500);
    const harness = buildHarness({
      observations: [
        ...[...trainSessions, validationSession, testSession].map(
          (liveSessionId, index) =>
            observation({
              journeyEventId: `evt-a-${index}`,
              liveSessionId,
              latestReview: review({ reviewId: `rev-a-${index}` }),
            }),
        ),
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
    expect(plan.warnings).toContain('INSUFFICIENT_STABLE_SPLIT_COVERAGE');
    const rare = harness.candidates.find(
      (row) => row.sourceId === 'evt-rare',
    )!;
    // The stable assignment is preserved — no run-specific override.
    expect(rare.split).toBe('VALIDATION');
    const quality = await harness.service.qualityReport(TENANT, created.id);
    expect(quality.readiness).toBe('NOT_READY');
    expect(quality.leakageWarnings).toContain('CLASS_MISSING_TRAIN_SPLIT');
    await expect(
      harness.service.setStatus(TENANT, created.id, 'READY' as never),
    ).rejects.toThrow('run is not ready');
    harness.runs.find((row) => row.id === created.id)!.status = 'READY';
    await expect(
      harness.service.exportManifest(TENANT, created.id),
    ).rejects.toThrow('INSUFFICIENT_STABLE_SPLIT_COVERAGE');
  });

  it('a rare class group keeps its stable split even as the dataset grows across runs', async () => {
    const [rareSession] = sessionsInBand('session-x', 1, 7000, 8500);
    const trainSessions = sessionsInBand('session-t', 4, 0, 7000);
    const opts = {
      observations: [
        ...trainSessions.map((liveSessionId, index) =>
          observation({
            journeyEventId: `evt-a-${index}`,
            liveSessionId,
            latestReview: review({ reviewId: `rev-a-${index}` }),
          }),
        ),
        observation({
          journeyEventId: 'evt-rare',
          liveSessionId: rareSession,
          predictedProductId: 'prod-rare',
          predictedSku: 'SKU-RARE',
          latestReview: review({ reviewId: 'rev-rare' }),
        }),
      ],
    };
    const harness = buildHarness(opts);
    const linkOnly = {
      sourceTestProtocolId: undefined,
      sourceCalibrationProfileId: undefined,
    };
    const runA = await createLinkedRun(harness.service, linkOnly);
    await harness.service.refreshCandidates(TENANT, runA.id);
    await harness.service.planSplits(TENANT, runA.id);
    const splitIn = (runId: string) =>
      harness.candidates.find(
        (row) => row.runId === runId && row.sourceId === 'evt-rare',
      )!.split;
    const smallRunSplit = splitIn(runA.id);
    expect(smallRunSplit).toBe('VALIDATION');
    // A later, larger run over the same source family: the rare group
    // must NOT migrate (previously coverage overrides forced it to
    // TRAIN in small runs and released it in larger ones).
    opts.observations.push(
      ...sessionsInBand('session-m', 20, 0, 10000).map(
        (liveSessionId, index) =>
          observation({
            journeyEventId: `evt-m-${index}`,
            liveSessionId,
            latestReview: review({ reviewId: `rev-m-${index}` }),
          }),
      ),
    );
    const runB = await createLinkedRun(harness.service, linkOnly);
    await harness.service.refreshCandidates(TENANT, runB.id);
    await harness.service.planSplits(TENANT, runB.id);
    expect(splitIn(runB.id)).toBe(smallRunSplit);
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
    // 6 raw examples ≥ the minimum of 5, but only ONE independent
    // group — the class IS low coverage now (groups, not raw rows).
    expect(quality.lowCoverageSkus).toEqual([
      { sku: 'SKU-A', count: 6, groups: 1, minimum: 5 },
    ]);
    expect(quality.imbalanceWarnings).toContain(
      'LOW_INDEPENDENT_GROUP_COVERAGE',
    );
    expect(quality.imbalanceWarnings).toContain(
      'INSUFFICIENT_CLASS_GROUP_COVERAGE',
    );
  });

  it('many duplicates from FEW sessions never satisfy the class minimum', async () => {
    // 30 near-duplicate rows across just two sessions with a minimum of
    // 5: previously the raw count (30 ≥ 5) sailed through — now the two
    // independent groups are what counts.
    const harness = buildHarness({
      observations: Array.from({ length: 30 }, (_, index) =>
        observation({
          journeyEventId: `evt-dup-${index}`,
          liveSessionId: index % 2 === 0 ? 'session-one' : 'session-two',
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
    expect(quality.lowCoverageSkus).toEqual([
      { sku: 'SKU-A', count: 30, groups: 2, minimum: 5 },
    ]);
    expect(quality.imbalanceWarnings).toContain(
      'INSUFFICIENT_CLASS_GROUP_COVERAGE',
    );
    expect(quality.readiness).toBe('WARNING');
    // The tuning surface reflects group-based coverage too — never
    // "tuning-ready" on the strength of raw duplicates.
    const report = await harness.service.modelTuningReport(TENANT, created.id);
    expect(report.classCoverageSummary.belowMinimumSkus).toBe(1);
    expect(report.tuningReadiness).not.toBe('READY');
  });

  it('export rejects a scenario re-recorded against a different session even with the same verdict', async () => {
    const opts = mixedFixtureOptions();
    const harness = buildHarness(opts);
    const created = await createLinkedRun(harness.service, FULL_TRAIN);
    await harness.service.refreshCandidates(TENANT, created.id);
    await harness.service.setStatus(TENANT, created.id, 'READY' as never);
    await harness.service.planSplits(TENANT, created.id);
    // The still-open protocol scenario is re-recorded: same PASS
    // verdict, but the evidence now lives in a DIFFERENT session — the
    // cached candidate points at footage the label no longer describes.
    (opts.scenarios[0] as Record<string, unknown>).liveSessionId = 'live-9';
    const error = await harness.service
      .exportManifest(TENANT, created.id)
      .then(
        () => null,
        (thrown: Error) => thrown,
      );
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error!.message).toContain('CV_DATASET_STALE_CANDIDATES');
    // Controlled message: no session ids, no source values.
    expect(error!.message).not.toContain('live-9');
    expect(error!.message).not.toContain('live-2');
    await harness.service.refreshCandidates(TENANT, created.id);
    await harness.service.planSplits(TENANT, created.id);
    const result = await harness.service.exportManifest(TENANT, created.id);
    expect(result.rowCount).toBe(6);
  });

  it('export rejects when the calibration lineage of cached candidates changes', async () => {
    const opts = mixedFixtureOptions() as ReturnType<
      typeof mixedFixtureOptions
    > & { defaultCamera?: CameraFixture };
    const harness = buildHarness(opts);
    const created = await createLinkedRun(harness.service, FULL_TRAIN);
    await harness.service.refreshCandidates(TENANT, created.id);
    // Live sessions were stamped with cal-1 at refresh time.
    expect(
      harness.candidates.some((row) => row.calibrationProfileId === 'cal-1'),
    ).toBe(true);
    await harness.service.setStatus(TENANT, created.id, 'READY' as never);
    await harness.service.planSplits(TENANT, created.id);
    // The cameras behind the sessions change character (re-derived
    // stamps become null): the cached calibration lineage is stale.
    opts.defaultCamera = {
      cameraSourceId: 'camera-1',
      sourceType: 'FILE_REPLAY',
    };
    await expect(
      harness.service.exportManifest(TENANT, created.id),
    ).rejects.toThrow('CV_DATASET_STALE_CANDIDATES');
  });

  it('false-touch predicted SKUs never count as SKU-classification labels', async () => {
    const falseTouches = Array.from({ length: 3 }, (_, index) =>
      observation({
        journeyEventId: `evt-ft-${index}`,
        liveSessionId: `session-${index}`,
        latestReview: review({
          reviewId: `rev-ft-${index}`,
          verdict: 'FALSE_TOUCH',
        }),
      }),
    );
    const harness = buildHarness({ observations: falseTouches });
    const created = await createLinkedRun(harness.service, {
      purpose: 'SKU_CLASSIFICATION',
      sourceTestProtocolId: undefined,
      sourceCalibrationProfileId: undefined,
      ...FULL_TRAIN,
    });
    const refreshed = await harness.service.refreshCandidates(
      TENANT,
      created.id,
    );
    expect(refreshed.eligible).toBe(3); // valid NO_OP negatives...
    const quality = await harness.service.qualityReport(TENANT, created.id);
    // ...but ZERO confirmed SKU labels: the predicted SKUs were never
    // confirmed — the reviewer confirmed NO_OP, not the SKU identity.
    expect(quality.examplesBySku).toEqual([]);
    expect(quality.readiness).toBe('NOT_READY');
    expect(quality.imbalanceWarnings).toContain('NO_SKU_LABELS_FOR_TASK');
    await expect(
      harness.service.setStatus(TENANT, created.id, 'READY' as never),
    ).rejects.toThrow('run is not ready');
    await harness.service.planSplits(TENANT, created.id);
    harness.runs.find((row) => row.id === created.id)!.status = 'READY';
    await expect(
      harness.service.exportManifest(TENANT, created.id),
    ).rejects.toThrow('no usable labels for its purpose');
    const report = await harness.service.modelTuningReport(TENANT, created.id);
    expect(report.classCoverageSummary.skuClasses).toBe(0);
    expect(report.recommendedModelTask).not.toBe('SKU_CLASSIFICATION');

    // The SAME rows remain first-class negatives for false-touch
    // filtering (with a positive to pair against)...
    const filtering = buildHarness({
      observations: [
        ...falseTouches,
        observation({
          journeyEventId: 'evt-pickup',
          liveSessionId: 'session-p',
          latestReview: review({ reviewId: 'rev-p', verdict: 'CORRECT' }),
        }),
      ],
    });
    const filteringRun = await createLinkedRun(filtering.service, {
      purpose: 'FALSE_TOUCH_FILTERING',
      sourceTestProtocolId: undefined,
      sourceCalibrationProfileId: undefined,
      ...FULL_TRAIN,
    });
    await filtering.service.refreshCandidates(TENANT, filteringRun.id);
    const filteringQuality = await filtering.service.qualityReport(
      TENANT,
      filteringRun.id,
    );
    expect(filteringQuality.readiness).not.toBe('NOT_READY');
    expect(filteringQuality.imbalanceWarnings).not.toContain(
      'INSUFFICIENT_TASK_LABELS',
    );

    // ...and MIXED stays usable while calling the missing SKU family out.
    const mixed = buildHarness({ observations: falseTouches });
    const mixedRun = await createLinkedRun(mixed.service, {
      purpose: 'MIXED',
      sourceTestProtocolId: undefined,
      sourceCalibrationProfileId: undefined,
      ...FULL_TRAIN,
    });
    await mixed.service.refreshCandidates(TENANT, mixedRun.id);
    const mixedQuality = await mixed.service.qualityReport(TENANT, mixedRun.id);
    expect(mixedQuality.readiness).not.toBe('NOT_READY');
    expect(mixedQuality.imbalanceWarnings).toContain('NO_SKU_LABELS_FOR_TASK');
  });

  it('config changes atomically invalidate split plans and warn; frozen states reject edits', async () => {
    const harness = buildHarness(mixedFixtureOptions());
    const created = await createLinkedRun(harness.service);
    await harness.service.refreshCandidates(TENANT, created.id);
    await harness.service.planSplits(TENANT, created.id);
    const plannedCount = () =>
      harness.candidates.filter(
        (row) => row.runId === created.id && row.split !== null,
      ).length;
    expect(plannedCount()).toBeGreaterThan(0);

    // (1) Percent change → splits cleared + replan warning; export is
    // blocked until replanning even if READY is forced.
    const percentEdit = await harness.service.updateRun(TENANT, created.id, {
      trainSplitPercent: 80,
      validationSplitPercent: 10,
      testSplitPercent: 10,
    });
    expect(percentEdit.warnings).toEqual(['CV_DATASET_SPLITS_REQUIRE_REPLAN']);
    expect(plannedCount()).toBe(0);
    const quality = await harness.service.qualityReport(TENANT, created.id);
    expect(quality.leakageWarnings).toContain('SPLITS_NOT_PLANNED');
    harness.runs.find((row) => row.id === created.id)!.status = 'READY';
    await expect(
      harness.service.exportManifest(TENANT, created.id),
    ).rejects.toThrow('CV_DATASET_EXPORT_REQUIRES_PLANNED_SPLITS');
    harness.runs.find((row) => row.id === created.id)!.status = 'DRAFT';

    // (2) Coverage-minimum change → same invalidation.
    await harness.service.planSplits(TENANT, created.id);
    const minimumEdit = await harness.service.updateRun(TENANT, created.id, {
      minReviewedExamplesPerSku: 9,
    });
    expect(minimumEdit.warnings).toEqual(['CV_DATASET_SPLITS_REQUIRE_REPLAN']);
    expect(plannedCount()).toBe(0);

    // (3) Purpose change → same invalidation.
    await harness.service.planSplits(TENANT, created.id);
    const purposeEdit = await harness.service.updateRun(TENANT, created.id, {
      purpose: 'ACTION_RECOGNITION' as never,
    });
    expect(purposeEdit.warnings).toEqual(['CV_DATASET_SPLITS_REQUIRE_REPLAN']);
    expect(plannedCount()).toBe(0);

    // (4) Metadata-only edits invalidate nothing.
    await harness.service.planSplits(TENANT, created.id);
    const nameEdit = await harness.service.updateRun(TENANT, created.id, {
      name: 'Renamed dataset run',
    });
    expect(nameEdit.warnings).toEqual([]);
    expect(plannedCount()).toBeGreaterThan(0);

    // (5) Source-family change → the whole candidate ledger goes, and
    // both refresh and replan are required.
    const linkEdit = await harness.service.updateRun(TENANT, created.id, {
      sourceTestProtocolId: null,
    });
    expect(linkEdit.warnings).toEqual([
      'CV_DATASET_SPLITS_REQUIRE_REPLAN',
      'CV_DATASET_CANDIDATES_REQUIRE_REFRESH',
    ]);
    expect(
      harness.candidates.filter((row) => row.runId === created.id),
    ).toEqual([]);

    // (6) EXPORTED and ARCHIVED runs reject configuration changes.
    harness.runs.find((row) => row.id === created.id)!.status = 'EXPORTED';
    await expect(
      harness.service.updateRun(TENANT, created.id, { name: 'Nope' }),
    ).rejects.toThrow('only DRAFT runs can be edited');
    harness.runs.find((row) => row.id === created.id)!.status = 'ARCHIVED';
    await expect(
      harness.service.updateRun(TENANT, created.id, {
        trainSplitPercent: 100,
        validationSplitPercent: 0,
        testSplitPercent: 0,
      }),
    ).rejects.toThrow('only DRAFT runs can be edited');
  });
});

describe('CvDatasetService — Codex P1 final cleanup', () => {
  const maxCandidateCreatedAt = (
    harness: ReturnType<typeof buildHarness>,
    runId: string,
  ) =>
    Math.max(
      ...harness.candidates
        .filter((row) => row.runId === runId)
        .map((row) => (row.createdAt as Date).getTime()),
    );

  it('SKU_CLASSIFICATION is not blocked by an action-only class outside TRAIN; MIXED still is; assignment is purpose-independent', async () => {
    const [trainSession] = sessionsInBand('p18-sku-train', 1, 0, 7000);
    const [testSession] = sessionsInBand('p18-sku-test', 1, 7000, 10000);
    const options = {
      observations: [
        observation({
          journeyEventId: 'evt-sku-t',
          liveSessionId: trainSession,
          latestReview: review({ reviewId: 'r-t', verdict: 'CORRECT' }),
        }),
        // The corrected RETURN action class lives ONLY in the TEST-band
        // session — irrelevant to a pure SKU task, blocking for MIXED.
        observation({
          journeyEventId: 'evt-sku-x',
          liveSessionId: testSession,
          latestReview: review({
            reviewId: 'r-x',
            verdict: 'WRONG_ACTION',
            expectedAction: 'RETURN',
            expectedProductId: 'prod-a',
            expectedSku: 'SKU-A',
          }),
        }),
      ],
    };
    const percents = {
      trainSplitPercent: 70,
      validationSplitPercent: 0,
      testSplitPercent: 30,
    };
    const skuHarness = buildHarness(options);
    const skuRun = await skuHarness.service.createRun(TENANT, {
      ...BASE_INPUT,
      ...percents,
      purpose: 'SKU_CLASSIFICATION' as never,
      sourceEvaluationRunId: 'eval-1',
    });
    await skuHarness.service.refreshCandidates(TENANT, skuRun.id);
    const skuPlan = await skuHarness.service.planSplits(TENANT, skuRun.id);
    expect(skuPlan.warnings).not.toContain('CLASS_MISSING_TRAIN_SPLIT');
    expect(skuPlan.warnings).not.toContain('INSUFFICIENT_STABLE_SPLIT_COVERAGE');
    const skuQuality = await skuHarness.service.qualityReport(TENANT, skuRun.id);
    expect(skuQuality.readiness).not.toBe('NOT_READY');
    await skuHarness.service.setStatus(TENANT, skuRun.id, 'READY' as never);
    const exported = await skuHarness.service.exportManifest(TENANT, skuRun.id);
    expect(exported.rowCount).toBe(2);

    const mixedHarness = buildHarness(options);
    const mixedRun = await mixedHarness.service.createRun(TENANT, {
      ...BASE_INPUT,
      ...percents,
      purpose: 'MIXED' as never,
      sourceEvaluationRunId: 'eval-1',
    });
    await mixedHarness.service.refreshCandidates(TENANT, mixedRun.id);
    const mixedPlan = await mixedHarness.service.planSplits(TENANT, mixedRun.id);
    expect(mixedPlan.warnings).toContain('CLASS_MISSING_TRAIN_SPLIT');
    expect(mixedPlan.warnings).toContain('INSUFFICIENT_STABLE_SPLIT_COVERAGE');
    const mixedQuality = await mixedHarness.service.qualityReport(
      TENANT,
      mixedRun.id,
    );
    expect(mixedQuality.readiness).toBe('NOT_READY');
    // The purpose scopes only the GATES — the stable assignment itself
    // is identical for both runs.
    expect(mixedPlan.splitSummary).toEqual(skuPlan.splitSummary);
  });

  it('ACTION_RECOGNITION and FALSE_TOUCH_FILTERING are not blocked by a SKU-only TRAIN gap', async () => {
    const [trainSession] = sessionsInBand('p18-act-train', 1, 0, 7000);
    const [testSession] = sessionsInBand('p18-act-test', 1, 7000, 10000);
    const options = {
      observations: [
        observation({
          journeyEventId: 'evt-act-a',
          liveSessionId: trainSession,
          latestReview: review({ reviewId: 'r-a', verdict: 'CORRECT' }),
        }),
        observation({
          journeyEventId: 'evt-act-b',
          liveSessionId: trainSession,
          matchScore: 0.2,
          latestReview: review({ reviewId: 'r-b', verdict: 'FALSE_TOUCH' }),
        }),
        // SKU-B exists only in the TEST-band session — irrelevant to
        // action-family tasks.
        observation({
          journeyEventId: 'evt-act-c',
          liveSessionId: testSession,
          predictedProductId: 'prod-b',
          predictedSku: 'SKU-B',
          latestReview: review({ reviewId: 'r-c', verdict: 'CORRECT' }),
        }),
      ],
    };
    for (const purpose of ['ACTION_RECOGNITION', 'FALSE_TOUCH_FILTERING']) {
      const harness = buildHarness(options);
      const created = await harness.service.createRun(TENANT, {
        ...BASE_INPUT,
        trainSplitPercent: 70,
        validationSplitPercent: 0,
        testSplitPercent: 30,
        purpose: purpose as never,
        sourceEvaluationRunId: 'eval-1',
      });
      await harness.service.refreshCandidates(TENANT, created.id);
      const plan = await harness.service.planSplits(TENANT, created.id);
      expect(plan.warnings).not.toContain('CLASS_MISSING_TRAIN_SPLIT');
      expect(plan.warnings).not.toContain(
        'INSUFFICIENT_STABLE_SPLIT_COVERAGE',
      );
      const quality = await harness.service.qualityReport(TENANT, created.id);
      expect(quality.readiness).not.toBe('NOT_READY');
      await harness.service.setStatus(TENANT, created.id, 'READY' as never);
      const exported = await harness.service.exportManifest(TENANT, created.id);
      expect(exported.rowCount).toBe(3);
    }
  });

  it('export rejects profile edits after refresh, recovers on refresh+replan, and rejects a changed re-export', async () => {
    const options = {
      ...mixedFixtureOptions(),
      zones: [{ zoneType: 'SHELF_ZONE' }],
    } as ReturnType<typeof mixedFixtureOptions> & {
      zones: { zoneType: string; updatedAt?: Date }[];
      profileUpdatedAt?: Date;
    };
    const harness = buildHarness(options);
    const created = await createLinkedRun(harness.service, {
      trainSplitPercent: 100,
      validationSplitPercent: 0,
      testSplitPercent: 0,
    });
    await harness.service.refreshCandidates(TENANT, created.id);
    await harness.service.setStatus(TENANT, created.id, 'READY' as never);
    await harness.service.planSplits(TENANT, created.id);

    // Orientation/mount/version edits bump the profile's updatedAt —
    // any such edit after the refresh instant rejects the export.
    options.profileUpdatedAt = new Date(
      maxCandidateCreatedAt(harness, created.id) + 500,
    );
    let error: Error | null = null;
    await harness.service
      .exportManifest(TENANT, created.id)
      .catch((thrown: Error) => (error = thrown));
    expect(String(error)).toContain('CV_DATASET_STALE_CANDIDATES');
    expect(String(error)).toContain('refresh candidates and re-plan splits');
    // Controlled message: no profile name, zone text, or camera id.
    expect(String(error)).not.toContain('Front shelf profile');
    expect(String(error)).not.toContain('camera-1');

    // Refresh + replan captures the new calibration state → export OK.
    await harness.service.refreshCandidates(TENANT, created.id);
    await harness.service.planSplits(TENANT, created.id);
    const exported = await harness.service.exportManifest(TENANT, created.id);
    expect(exported.manifest.calibration).toMatchObject({
      calibrationProfileId: 'cal-1',
    });

    // A calibration change AFTER export can never silently alter the
    // manifest — re-export is rejected instead.
    options.profileUpdatedAt = new Date(
      maxCandidateCreatedAt(harness, created.id) + 500,
    );
    await expect(
      harness.service.exportManifest(TENANT, created.id),
    ).rejects.toThrow('CV_DATASET_STALE_CANDIDATES');
  });

  it('export rejects zones added/updated after refresh; FILE_REPLAY runs stay exempt', async () => {
    const options = {
      ...mixedFixtureOptions(),
      zones: [{ zoneType: 'SHELF_ZONE' }],
    } as ReturnType<typeof mixedFixtureOptions> & {
      zones: { zoneType: string; updatedAt?: Date }[];
    };
    const harness = buildHarness(options);
    const created = await createLinkedRun(harness.service, {
      trainSplitPercent: 100,
      validationSplitPercent: 0,
      testSplitPercent: 0,
    });
    await harness.service.refreshCandidates(TENANT, created.id);
    await harness.service.setStatus(TENANT, created.id, 'READY' as never);
    await harness.service.planSplits(TENANT, created.id);
    options.zones.push({
      zoneType: 'INTERACTION_ZONE',
      updatedAt: new Date(maxCandidateCreatedAt(harness, created.id) + 500),
    });
    await expect(
      harness.service.exportManifest(TENANT, created.id),
    ).rejects.toThrow('CV_DATASET_STALE_CANDIDATES');

    // FILE_REPLAY-only footage is never stamped with the profile, so
    // calibration edits cannot invalidate its export (NOT_APPLICABLE).
    const replayHarness = buildHarness({
      ...mixedFixtureOptions(),
      defaultCamera: { cameraSourceId: 'camera-1', sourceType: 'FILE_REPLAY' },
      profileUpdatedAt: new Date('2026-08-21T00:00:00.000Z'),
    });
    const replayRun = await createLinkedRun(replayHarness.service, {
      trainSplitPercent: 100,
      validationSplitPercent: 0,
      testSplitPercent: 0,
    });
    await replayHarness.service.refreshCandidates(TENANT, replayRun.id);
    await replayHarness.service.setStatus(TENANT, replayRun.id, 'READY' as never);
    await replayHarness.service.planSplits(TENANT, replayRun.id);
    const exported = await replayHarness.service.exportManifest(
      TENANT,
      replayRun.id,
    );
    expect(exported.manifest.calibration).toBeNull();
  });

  it('a foreign tenant camera source can never masquerade as FILE_REPLAY', async () => {
    const foreignCamera = {
      'live-1': {
        cameraSourceId: 'camera-x',
        sourceType: 'FILE_REPLAY',
        tenantId: 'tenant-2',
      },
    };
    const observations = [
      observation({
        journeyEventId: 'evt-f',
        liveSessionId: 'live-1',
        latestReview: review({ reviewId: 'r-f', verdict: 'CORRECT' }),
      }),
    ];

    // (1) Readiness advice: the unresolved camera reads UNKNOWN — a
    // live-like source — so calibration advice IS recommended, even
    // though the nested (unscoped) relation claims FILE_REPLAY.
    const foreignHarness = buildHarness({
      observations,
      cameraBySession: foreignCamera,
    });
    const foreignRun = await foreignHarness.service.createRun(TENANT, {
      ...BASE_INPUT,
      sourceEvaluationRunId: 'eval-1',
    });
    await foreignHarness.service.refreshCandidates(TENANT, foreignRun.id);
    const foreignQuality = await foreignHarness.service.qualityReport(
      TENANT,
      foreignRun.id,
    );
    expect(foreignQuality.recommendedNextActions).toContain(
      'IMPROVE_CAMERA_CALIBRATION',
    );

    // Same-tenant FILE_REPLAY keeps the exemption.
    const replayHarness = buildHarness({
      observations,
      cameraBySession: {
        'live-1': { cameraSourceId: 'camera-x', sourceType: 'FILE_REPLAY' },
      },
    });
    const replayRun = await replayHarness.service.createRun(TENANT, {
      ...BASE_INPUT,
      sourceEvaluationRunId: 'eval-1',
    });
    await replayHarness.service.refreshCandidates(TENANT, replayRun.id);
    const replayQuality = await replayHarness.service.qualityReport(
      TENANT,
      replayRun.id,
    );
    expect(replayQuality.recommendedNextActions).not.toContain(
      'IMPROVE_CAMERA_CALIBRATION',
    );

    // (2) Calibration stamping: the unresolved camera is non-matching,
    // so a linked profile rejects the refresh — the foreign FILE_REPLAY
    // type cannot bypass the camera-match rule either. No camera id is
    // echoed.
    const mismatchHarness = buildHarness({
      observations,
      cameraBySession: foreignCamera,
    });
    const mismatchRun = await mismatchHarness.service.createRun(TENANT, {
      ...BASE_INPUT,
      sourceEvaluationRunId: 'eval-1',
      sourceCalibrationProfileId: 'cal-1',
    });
    let error: Error | null = null;
    await mismatchHarness.service
      .refreshCandidates(TENANT, mismatchRun.id)
      .catch((thrown: Error) => (error = thrown));
    expect(String(error)).toContain('CV_DATASET_CALIBRATION_CAMERA_MISMATCH');
    expect(String(error)).not.toContain('camera-x');
  });
});
