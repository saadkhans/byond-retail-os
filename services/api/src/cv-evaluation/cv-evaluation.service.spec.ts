import { FusionPolicyResult, GroundTruthEventKind } from '@prisma/client';
import { CvEvaluationService } from './cv-evaluation.service';

const TENANT = 'tenant-1';
const ASSET = 'asset-1';

/** Minimal WHOLE_CLIP evidence: one pickup event, one fused candidate. */
function evidence(sku: string) {
  return {
    detector: { events: [{ kind: 'PICKUP', peakMs: 1000 }] },
    fused: [{ productId: 'prod-1', sku, productName: sku, rank: 1 }],
    stages: [],
    vlm: { invoked: false },
  };
}

type RunFixture = {
  id: string;
  tenantId: string;
  videoAssetId: string;
  runScope: 'WHOLE_CLIP' | 'REPLAY_WINDOW';
  policy: FusionPolicyResult;
  fusedTopScore: number | null;
  processingMs: number;
  createdAt: Date;
  evidence: unknown;
};

/**
 * Honoring stub: filters runs the way the real database would, INCLUDING
 * the runScope predicate — a query missing it would surface the newer
 * REPLAY_WINDOW row and the displacement test below would fail.
 */
function buildService(runs: RunFixture[]) {
  const fusionFindMany = jest.fn(
    async (args: {
      where: {
        tenantId: string;
        videoAssetId: { in: string[] };
        runScope?: string;
      };
      orderBy: unknown;
    }) =>
      runs
        .filter(
          (run) =>
            run.tenantId === args.where.tenantId &&
            args.where.videoAssetId.in.includes(run.videoAssetId) &&
            (args.where.runScope === undefined ||
              run.runScope === args.where.runScope),
        )
        .sort(
          (a, b) =>
            b.createdAt.getTime() - a.createdAt.getTime() ||
            (a.id < b.id ? 1 : -1),
        ),
  );
  const prisma = {
    videoGroundTruth: {
      findMany: jest.fn(async () => [
        {
          videoAssetId: ASSET,
          eventKind: GroundTruthEventKind.PICKUP,
          testType: null,
          quantity: 1,
          product: { sku: 'WATER-BOTTLE-500ML' },
          videoAsset: { originalFilename: 'clip.mp4', deletedAt: null },
        },
      ]),
    },
    pickupFusionRun: { findMany: fusionFindMany },
  };
  return {
    service: new CvEvaluationService(prisma as never),
    fusionFindMany,
  };
}

describe('CvEvaluationService — whole-clip runs only (Codex P1)', () => {
  const wholeClip: RunFixture = {
    id: 'run-whole',
    tenantId: TENANT,
    videoAssetId: ASSET,
    runScope: 'WHOLE_CLIP',
    policy: FusionPolicyResult.AUTO_PROPOSE,
    fusedTopScore: 0.4,
    processingMs: 900,
    createdAt: new Date('2026-08-10T10:00:00Z'),
    evidence: evidence('WATER-BOTTLE-500ML'),
  };
  const newerWindowRun: RunFixture = {
    id: 'run-window',
    tenantId: TENANT,
    videoAssetId: ASSET,
    runScope: 'REPLAY_WINDOW',
    policy: FusionPolicyResult.NEEDS_HUMAN_REVIEW,
    fusedTopScore: 0.1,
    processingMs: 300,
    createdAt: new Date('2026-08-16T10:00:00Z'),
    evidence: {
      ...evidence('SKU-WRONG'),
      replayWindow: { startMs: 0, endMs: 2000, peakMs: 1000 },
    },
  };

  it('the query itself carries the WHOLE_CLIP scope predicate', async () => {
    const { service, fusionFindMany } = buildService([wholeClip]);
    await service.summary(TENANT);
    expect(fusionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: TENANT,
          runScope: 'WHOLE_CLIP',
        }),
      }),
    );
  });

  it('a NEWER replay-window run does not displace the whole-clip result', async () => {
    const { service } = buildService([wholeClip, newerWindowRun]);
    const { rows } = await service.testRuns(TENANT);
    expect(rows).toHaveLength(1);
    // Latest-run selection lands on the WHOLE_CLIP row despite the
    // window run being newer — a pilot replay cannot rewrite evaluation.
    expect(rows[0].run?.runId).toBe('run-whole');
    expect(rows[0].run?.predictedSku).toBe('WATER-BOTTLE-500ML');
  });

  it('replay-window runs alone leave the clip unevaluated (no run)', async () => {
    const { service } = buildService([newerWindowRun]);
    const { rows } = await service.testRuns(TENANT);
    expect(rows).toHaveLength(1);
    expect(rows[0].run).toBeNull();
  });
});
