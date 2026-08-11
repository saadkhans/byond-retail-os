import {
  FusionPolicyResult,
  GroundTruthEventKind,
  InferenceJobStatus,
} from '@prisma/client';
import { pickupSourceId } from './pickup-detection.service';
import {
  PickupValidationService,
  SUMMARY_MAX_ROWS,
} from './pickup-validation.service';

/**
 * summary() fusion-scoring contract: only a non-FAILED fusion run is a
 * RESULT. A crashed pipeline persists a FAILED PickupFusionRun row for
 * debugging, but that row must never make a ground-truth video count as
 * reviewed or score fusion accuracy — it behaves exactly as if no run
 * existed (while a completed v1 job still makes the row reviewable, per
 * the either-pipeline rule).
 *
 * Query-shape contract: summary() is bounded (take: SUMMARY_MAX_ROWS on
 * the ground-truth query) and batched — one findMany per dependency
 * (jobs, fusion runs, vision events) keyed by IN lists, never one query
 * per ground-truth row. The mocks below honor the where clauses the
 * service sends so these tests pin the QUERY-level behavior, not just
 * null handling.
 */

const TENANT = 'tenant-1';
const ASSET = 'asset-1';
const SKU = 'WATER-BOTTLE-500ML';

interface FusionRunFixture {
  id: string;
  tenantId: string;
  videoAssetId: string;
  policy: FusionPolicyResult;
  fusedTopSku: string | null;
  fusedTopScore: number | null;
  createdAt: Date;
}

interface JobFixture {
  id: string;
  sourceId: string;
  status: InferenceJobStatus;
  errorCode: string | null;
  visionEventId: string | null;
  result: { candidates: { sku: string; score: number | null }[] } | null;
  createdAt: Date;
}

function truth(videoAssetId: string, updatedAt = '2026-08-10T00:00:00Z') {
  return {
    videoAssetId,
    eventKind: GroundTruthEventKind.PICKUP,
    productId: 'prod-1',
    actualTimestampMs: 1600,
    quantity: 1,
    note: null,
    updatedAt: new Date(updatedAt),
    product: { sku: SKU },
    videoAsset: { originalFilename: `${videoAssetId}.mp4`, deletedAt: null },
  };
}

const pickupRecord = {
  version: 1,
  kind: 'PRODUCT_PICKUP_DETECTION',
  result: 'PRODUCT_MATCHED',
  confidence: 0.9,
  eventStartMs: 1000,
  eventPeakMs: 1500,
  eventEndMs: 2000,
  boundingBox: { x: 0, y: 0, width: 10, height: 10 },
  sourceFrameArtifactId: null,
  cropArtifactId: null,
  productId: 'prod-1',
  sku: SKU,
  analysisFps: 5,
  modelKey: 'classical-hsv-histogram',
  modelVersion: '1',
  processingMs: 1200,
};

function succeededJob(
  id: string,
  videoAssetId: string,
  visionEventId: string,
  createdAt = '2026-08-10T01:00:00Z',
): JobFixture {
  return {
    id,
    sourceId: pickupSourceId(videoAssetId),
    status: InferenceJobStatus.SUCCEEDED,
    errorCode: null,
    visionEventId,
    result: { candidates: [] },
    createdAt: new Date(createdAt),
  };
}

function buildService(overrides: {
  truths?: ReturnType<typeof truth>[];
  fusionRuns?: FusionRunFixture[];
  jobs?: JobFixture[];
  events?: { id: string; metadata: unknown }[];
}) {
  const byNewest = <T extends { createdAt: Date; id: string }>(
    a: T,
    b: T,
  ): number =>
    b.createdAt.getTime() - a.createdAt.getTime() ||
    b.id.localeCompare(a.id);
  const groundTruthFindMany = jest.fn(
    async () => overrides.truths ?? [truth(ASSET)],
  );
  const jobFindMany = jest.fn(
    async (args: { where: { sourceId: { in: string[] } } }) =>
      (overrides.jobs ?? [])
        .filter((job) => args.where.sourceId.in.includes(job.sourceId))
        .sort(byNewest),
  );
  const fusionFindMany = jest.fn(
    async (args: {
      where: {
        tenantId: string;
        videoAssetId: { in: string[] };
        policy?: { not: FusionPolicyResult };
      };
    }) =>
      (overrides.fusionRuns ?? [])
        .filter(
          (run) =>
            run.tenantId === args.where.tenantId &&
            args.where.videoAssetId.in.includes(run.videoAssetId) &&
            (args.where.policy === undefined ||
              run.policy !== args.where.policy.not),
        )
        .sort(byNewest),
  );
  const visionEventFindMany = jest.fn(
    async (args: { where: { id: { in: string[] } } }) =>
      (overrides.events ?? [{ id: 'event-1', metadata: pickupRecord }]).filter(
        (event) => args.where.id.in.includes(event.id),
      ),
  );
  const prisma = {
    videoGroundTruth: { findMany: groundTruthFindMany },
    inferenceJob: { findMany: jobFindMany },
    pickupFusionRun: { findMany: fusionFindMany },
    visionEvent: { findMany: visionEventFindMany },
  };
  return {
    service: new PickupValidationService(prisma as never),
    groundTruthFindMany,
    jobFindMany,
    fusionFindMany,
    visionEventFindMany,
  };
}

function failedRun(id: string, createdAt: string): FusionRunFixture {
  return {
    id,
    tenantId: TENANT,
    videoAssetId: ASSET,
    policy: FusionPolicyResult.FAILED,
    fusedTopSku: null,
    fusedTopScore: null,
    createdAt: new Date(createdAt),
  };
}

describe('summary — FAILED fusion runs are not results', () => {
  it('ground truth + FAILED run + no v1 job => not counted reviewed, fusion fields null', async () => {
    const { service, fusionFindMany } = buildService({
      fusionRuns: [failedRun('run-1', '2026-08-10T01:00:00Z')],
      jobs: [],
    });
    const summary = await service.summary(TENANT);
    expect(summary.rows).toHaveLength(0);
    expect(summary.totals.reviewed).toBe(0);
    expect(summary.totals.unscored).toBe(0);
    // The exclusion lives in the query itself.
    expect(fusionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          policy: { not: FusionPolicyResult.FAILED },
        }),
      }),
    );
  });

  it('FAILED run + completed v1 job => row reviewable via v1, fusion unscored', async () => {
    const { service } = buildService({
      fusionRuns: [failedRun('run-1', '2026-08-10T01:00:00Z')],
      jobs: [succeededJob('job-1', ASSET, 'event-1')],
    });
    const summary = await service.summary(TENANT);
    expect(summary.rows).toHaveLength(1);
    const row = summary.rows[0];
    // v1 still scores against ground truth...
    expect(row.outcome).toBe('correct');
    // ...but fusion behaves exactly as if no run existed.
    expect(row.fusionTopSku).toBeNull();
    expect(row.fusionTopScore).toBeNull();
    expect(row.fusionPolicy).toBeNull();
    expect(row.fusionVerdict).toBeNull();
  });

  it('a later FAILED run does not shadow an earlier completed run', async () => {
    const { service } = buildService({
      fusionRuns: [
        {
          id: 'run-1',
          tenantId: TENANT,
          videoAssetId: ASSET,
          policy: FusionPolicyResult.AUTO_PROPOSE,
          fusedTopSku: SKU,
          fusedTopScore: 0.8,
          createdAt: new Date('2026-08-10T01:00:00Z'),
        },
        failedRun('run-2', '2026-08-10T02:00:00Z'),
      ],
      jobs: [],
    });
    const summary = await service.summary(TENANT);
    expect(summary.rows).toHaveLength(1);
    const row = summary.rows[0];
    expect(row.fusionTopSku).toBe(SKU);
    expect(row.fusionVerdict).toBe('correct');
    // Fusion-only row: v1 stays unscored per the either-pipeline rule.
    expect(row.outcome).toBe('unscored');
  });
});

describe('summary — bounded and batched queries', () => {
  it('caps the ground-truth query and issues one batched query per dependency', async () => {
    const assets = ['asset-1', 'asset-2', 'asset-3'];
    const {
      service,
      groundTruthFindMany,
      jobFindMany,
      fusionFindMany,
      visionEventFindMany,
    } = buildService({
      truths: assets.map((assetId) => truth(assetId)),
      jobs: assets.map((assetId, index) =>
        succeededJob(`job-${index}`, assetId, 'event-1'),
      ),
      fusionRuns: [],
    });
    const summary = await service.summary(TENANT);
    expect(summary.rows).toHaveLength(3);
    expect(summary.rows.every((row) => row.outcome === 'correct')).toBe(true);
    // Bounded: the ground-truth scan carries a hard cap and covers the
    // deleted-asset filter in the query itself.
    expect(groundTruthFindMany).toHaveBeenCalledTimes(1);
    expect(groundTruthFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: SUMMARY_MAX_ROWS,
        where: expect.objectContaining({
          tenantId: TENANT,
          videoAsset: { deletedAt: null },
        }),
      }),
    );
    // Batched: exactly one query per dependency regardless of row count.
    expect(jobFindMany).toHaveBeenCalledTimes(1);
    expect(jobFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          sourceId: { in: assets.map(pickupSourceId) },
        }),
      }),
    );
    expect(fusionFindMany).toHaveBeenCalledTimes(1);
    expect(fusionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ videoAssetId: { in: assets } }),
      }),
    );
    expect(visionEventFindMany).toHaveBeenCalledTimes(1);
  });

  it('scores each asset against its own latest attempt, not another asset’s', async () => {
    const { service } = buildService({
      truths: [truth('asset-1'), truth('asset-2')],
      jobs: [
        // asset-1: an old success shadowed by a newer failed attempt —
        // the LATEST attempt is what gets scored.
        succeededJob('job-old', 'asset-1', 'event-1', '2026-08-10T01:00:00Z'),
        {
          id: 'job-new',
          sourceId: pickupSourceId('asset-1'),
          status: InferenceJobStatus.FAILED,
          errorCode: 'NO_MOTION_DETECTED',
          visionEventId: null,
          result: null,
          createdAt: new Date('2026-08-10T02:00:00Z'),
        },
        // asset-2: a single success.
        succeededJob('job-2', 'asset-2', 'event-1', '2026-08-10T01:00:00Z'),
      ],
      fusionRuns: [],
    });
    const summary = await service.summary(TENANT);
    expect(summary.rows).toHaveLength(2);
    const byAsset = new Map(
      summary.rows.map((row) => [row.videoAssetId, row]),
    );
    expect(byAsset.get('asset-1')?.outcome).toBe('not_detected');
    expect(byAsset.get('asset-1')?.jobErrorCode).toBe('NO_MOTION_DETECTED');
    expect(byAsset.get('asset-2')?.outcome).toBe('correct');
  });

  it('skips the vision-event query entirely when no completed job references one', async () => {
    const { service, visionEventFindMany } = buildService({
      truths: [truth(ASSET)],
      jobs: [
        {
          id: 'job-1',
          sourceId: pickupSourceId(ASSET),
          status: InferenceJobStatus.FAILED,
          errorCode: 'NO_MOTION_DETECTED',
          visionEventId: null,
          result: null,
          createdAt: new Date('2026-08-10T01:00:00Z'),
        },
      ],
      fusionRuns: [],
    });
    const summary = await service.summary(TENANT);
    expect(summary.rows).toHaveLength(1);
    expect(summary.rows[0].outcome).toBe('not_detected');
    expect(visionEventFindMany).not.toHaveBeenCalled();
  });
});
