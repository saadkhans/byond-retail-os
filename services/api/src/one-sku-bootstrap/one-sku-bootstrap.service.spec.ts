import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { JourneyService } from '../journey/journey.service';
import { PilotEvaluationService } from '../pilot-evaluation/pilot-evaluation.service';
import { PlatformModulesService } from '../platform-modules/platform-modules.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  OneSkuBootstrapService,
  bootstrapRunName,
  isBootstrapRunNameFor,
} from './one-sku-bootstrap.service';

const TENANT = 'tenant-1';
const OTHER_TENANT = 'tenant-2';
const PRODUCT = {
  id: 'prod-1',
  sku: 'SKU-LIME-GREEN',
  name: 'Lime Green Can',
  status: 'ACTIVE',
};
const LINKED_RUN = {
  id: 'eval-1',
  name: bootstrapRunName(PRODUCT.sku),
  status: 'OPEN',
  bootstrapProductId: null,
  _count: { reviews: 1 },
};

type Row = Record<string, unknown>;

function asset(over: Row = {}): Row {
  return {
    originalFilename: 'clip.mp4',
    status: 'READY',
    durationMs: 8000,
    width: 1920,
    height: 1080,
    locationId: 'loc-1',
    sessionId: null,
    deletedAt: null,
    ...over,
  };
}

function evidence(over: Row = {}): Row {
  return {
    detector: {
      yoloReady: false,
      events: [{ kind: 'PICKUP', startMs: 800, peakMs: 1500, endMs: 2200 }],
    },
    cropArtifactId: 'artifact-auto-1',
    crops: [
      {
        phase: 'peak',
        timestampMs: 1500,
        box: { x: 120, y: 80, width: 160, height: 200 },
        quality: { sharpness: 22, occlusion: 0.08, brightness: 120 },
        selected: true,
      },
    ],
    fused: [{ sku: PRODUCT.sku, fusedScore: 0.66 }],
    vlm: {
      invoked: false,
      status: null,
      verdict: null,
      selectedSku: null,
      requiresHumanReview: null,
    },
    barcode: { results: [], matchedSku: PRODUCT.sku },
    ocr: { rawText: '', normalizedText: '', status: 'OK' },
    inventoryValidation: [
      { sku: PRODUCT.sku, verdict: 'PLAUSIBLE', onHandQuantity: 4 },
    ],
    ...over,
  };
}

function truthRow(over: Row = {}): Row {
  return {
    videoAssetId: 'va-1',
    eventKind: 'PICKUP',
    testType: null,
    quantity: 1,
    actualTimestampMs: 1500,
    product: { sku: PRODUCT.sku },
    videoAsset: asset(),
    ...over,
  };
}

function importedEvent(over: Row = {}): Row {
  return {
    id: 'jevt-1',
    videoAssetId: 'va-1',
    fusionRunId: 'fusion-1',
    productId: PRODUCT.id,
    sku: PRODUCT.sku,
    eventType: 'PRODUCT_PICKUP',
    ...over,
  };
}

function pilotReview(over: Row = {}): Row {
  return {
    journeyEventId: 'jevt-1',
    verdict: 'CORRECT',
    expectedAction: 'PICKUP',
    expectedProductId: null,
    expectedSku: null,
    operatorCropArtifactId: null,
    createdAt: new Date('2026-08-24T11:00:00Z'),
    ...over,
  };
}

function fusionRun(over: Row = {}): Row {
  return {
    id: 'fusion-1',
    videoAssetId: 'va-1',
    createdAt: new Date('2026-08-24T10:00:00Z'),
    policy: 'AUTO_PROPOSE',
    evidence: evidence(),
    ...over,
  };
}

interface HarnessData {
  product?: Row | null;
  referenceCount?: number;
  embeddingCount?: number;
  levels?: Row[];
  truths?: Row[];
  runs?: Row[];
  jobs?: Row[];
  events?: Row[];
  operatorCrops?: Row[];
  evaluationRun?: Row | null;
  /** Full bootstrap-run family (newest first) — overrides evaluationRun. */
  evaluationRuns?: Row[];
  videoAsset?: Row | null;
  groundTruth?: Row | null;
  importedEvents?: Row[];
  pilotReviews?: Row[];
  /** Queue for reviewClip's customerJourneyEvent.findFirst calls. */
  journeyEventLookups?: (Row | null)[];
  /** reviewClip's operator-crop findFirst result. */
  reviewOperatorCrop?: Row | null;
  /** Whether the tenant has the inventory module enabled (default true). */
  inventoryModuleEnabled?: boolean;
  /** Full-aggregate on-hand total; defaults to the sum of `levels`. */
  totalOnHand?: number;
}

function buildHarness(data: HarnessData) {
  const journeyEventQueue = [...(data.journeyEventLookups ?? [])];
  // Advisory-lock transaction wrapper for the per-clip import: the
  // callback receives a tx whose only job here is the lock query.
  const txQueryRaw = jest.fn(async () => []);
  const prisma = {
    $transaction: jest.fn(
      async (fn: (tx: { $queryRaw: jest.Mock }) => Promise<unknown>) =>
        fn({ $queryRaw: txQueryRaw }),
    ),
    product: {
      findFirst: jest.fn(async (args: { where: { tenantId: string } }) =>
        args.where.tenantId === TENANT ? (data.product ?? PRODUCT) : null,
      ),
    },
    productReferenceImage: {
      count: jest.fn(async () => data.referenceCount ?? 0),
    },
    productReferenceEmbedding: {
      count: jest.fn(async () => data.embeddingCount ?? 0),
    },
    inventoryLevel: {
      findMany: jest.fn(async () => data.levels ?? []),
      // Readiness reads the FULL aggregate, never the display rows.
      aggregate: jest.fn(async () => ({
        _sum: {
          quantity:
            data.totalOnHand ??
            ((data.levels ?? []).length === 0
              ? null
              : (data.levels ?? []).reduce(
                  (sum, level) => sum + ((level as Row).quantity as number),
                  0,
                )),
        },
      })),
    },
    pilotEvaluationRun: {
      // The run FAMILY lookup (base name + " (n)" successors), newest
      // first — mirrors the startsWith query.
      findMany: jest.fn(async () =>
        data.evaluationRuns ?? (data.evaluationRun ? [data.evaluationRun] : []),
      ),
    },
    pilotObservationReview: {
      findMany: jest.fn(async () => data.pilotReviews ?? []),
    },
    videoGroundTruth: {
      findMany: jest.fn(async () => data.truths ?? []),
      findFirst: jest.fn(async () => data.groundTruth ?? null),
    },
    pickupFusionRun: {
      findFirst: jest.fn(async () => (data.runs ?? [])[0] ?? null),
      findMany: jest.fn(async () => data.runs ?? []),
    },
    inferenceJob: {
      findMany: jest.fn(async () => data.jobs ?? []),
    },
    visionEvent: {
      findMany: jest.fn(async () => data.events ?? []),
    },
    videoArtifact: {
      findMany: jest.fn(async () => data.operatorCrops ?? []),
      findFirst: jest.fn(async () => data.reviewOperatorCrop ?? null),
    },
    videoAsset: {
      findFirst: jest.fn(async () => data.videoAsset ?? null),
    },
    customerJourneyEvent: {
      findFirst: jest.fn(async () => journeyEventQueue.shift() ?? null),
      findMany: jest.fn(async () => data.importedEvents ?? []),
    },
  };
  const evaluations = {
    createRun: jest.fn(async (_tenant: string, input: { name: string }) => ({
      evaluationRunId: 'eval-1',
      name: input.name,
      status: 'OPEN',
    })),
    reviewObservation: jest.fn(async () => ({
      reviewId: 'review-1',
      verdict: 'WRONG_SKU',
    })),
  };
  const journeys = {
    create: jest.fn(async () => ({ id: 'journey-1' })),
    appendFromFusionRun: jest.fn(async () => ({})),
  };
  const platformModules = {
    isEnabledForTenant: jest.fn(
      async () => data.inventoryModuleEnabled ?? true,
    ),
  };
  const service = new OneSkuBootstrapService(
    prisma as unknown as PrismaService,
    evaluations as unknown as PilotEvaluationService,
    journeys as unknown as JourneyService,
    platformModules as unknown as PlatformModulesService,
  );
  return { prisma, evaluations, journeys, platformModules, service, txQueryRaw };
}

describe('OneSkuBootstrapService.report', () => {
  it('404s for a product outside the tenant', async () => {
    const { service } = buildHarness({});
    await expect(service.report(OTHER_TENANT, PRODUCT.id)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('scopes every query to the tenant AND pilot reviews to the linked run', async () => {
    const { prisma, service } = buildHarness({
      evaluationRun: LINKED_RUN,
      truths: [truthRow()],
      runs: [fusionRun()],
      importedEvents: [importedEvent()],
      pilotReviews: [pilotReview()],
    });
    await service.report(TENANT, PRODUCT.id);
    for (const delegate of [
      prisma.productReferenceImage.count,
      prisma.productReferenceEmbedding.count,
      prisma.inventoryLevel.findMany,
      prisma.inventoryLevel.aggregate,
      prisma.pilotEvaluationRun.findMany,
      prisma.videoGroundTruth.findMany,
      prisma.pickupFusionRun.findMany,
      prisma.inferenceJob.findMany,
      prisma.videoArtifact.findMany,
      prisma.customerJourneyEvent.findMany,
    ]) {
      expect(delegate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ tenantId: TENANT }),
        }),
      );
    }
    // Reviews are SCOPED to the linked bootstrap evaluation run — a
    // review from another run must never count here (Codex P1).
    expect(prisma.pilotObservationReview.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: TENANT,
          evaluationRunId: LINKED_RUN.id,
        }),
      }),
    );
  });

  it('counts nothing reviewed when no evaluation run is linked', async () => {
    const { prisma, service } = buildHarness({
      evaluationRun: null,
      truths: [truthRow()],
      runs: [fusionRun()],
      importedEvents: [importedEvent()],
      // Reviews exist in the store but belong to no linked run — the
      // service must not even query them.
      pilotReviews: [pilotReview()],
    });
    const report = await service.report(TENANT, PRODUCT.id);
    expect(prisma.pilotObservationReview.findMany).not.toHaveBeenCalled();
    expect(report.videos[0].reviewed).toBe(false);
    expect(report.counts.reviewedPickupExamples).toBe(0);
  });

  it('counts a latest-run-bound ELIGIBLE review as reviewed', async () => {
    const { service } = buildHarness({
      evaluationRun: LINKED_RUN,
      truths: [truthRow()],
      runs: [fusionRun()],
      importedEvents: [importedEvent()],
      pilotReviews: [pilotReview()],
    });
    const report = await service.report(TENANT, PRODUCT.id);
    expect(report.videos[0].reviewed).toBe(true);
    expect(report.videos[0].bootstrapReviewEligible).toBe(true);
    expect(report.counts.reviewedPickupExamples).toBe(1);
  });

  it('does NOT count a review bound to an OLDER fusion run (needs fresh review)', async () => {
    const { service } = buildHarness({
      evaluationRun: LINKED_RUN,
      truths: [truthRow()],
      runs: [
        fusionRun({ id: 'fusion-new', createdAt: new Date('2026-08-24T12:00:00Z') }),
      ],
      // The reviewed event belongs to the OLD run.
      importedEvents: [importedEvent({ fusionRunId: 'fusion-old' })],
      pilotReviews: [pilotReview()],
    });
    const report = await service.report(TENANT, PRODUCT.id);
    expect(report.videos[0].reviewed).toBe(false);
    expect(report.videos[0].staleReview).toBe(true);
    expect(report.videos[0].needsReview).toBe(true);
    expect(report.counts.reviewedPickupExamples).toBe(0);
    expect(report.counts.unreviewedClips).toBe(1);
  });

  it('does NOT count Phase 18-INELIGIBLE reviews (UNCERTAIN, unchanged corrections)', async () => {
    for (const badReview of [
      pilotReview({ verdict: 'UNCERTAIN', expectedAction: 'UNKNOWN' }),
      pilotReview({ verdict: 'WRONG_SKU' }), // MISSING_CORRECTED_SKU
      pilotReview({ verdict: 'WRONG_SKU', expectedProductId: PRODUCT.id }), // unchanged
      pilotReview({ verdict: 'WRONG_ACTION', expectedAction: 'PICKUP' }), // unchanged
      pilotReview({ verdict: 'WRONG_ACTION', expectedAction: 'UNKNOWN' }), // unusable
      pilotReview({ verdict: 'INCORRECT' }),
    ]) {
      const { service } = buildHarness({
        evaluationRun: LINKED_RUN,
        truths: [truthRow()],
        runs: [fusionRun()],
        importedEvents: [importedEvent()],
        pilotReviews: [badReview],
      });
      const report = await service.report(TENANT, PRODUCT.id);
      expect(report.videos[0].reviewed).toBe(false);
      expect(report.videos[0].bootstrapReviewEligible).toBe(false);
      expect(report.counts.reviewedPickupExamples).toBe(0);
      expect(report.gates.readyForDatasetImprovement).toBe(false);
    }
  });

  it('counts valid WRONG_SKU / WRONG_ACTION / FALSE_TOUCH corrections', async () => {
    const cases: [Row, 'pickup' | 'falseTouch'][] = [
      [
        pilotReview({
          verdict: 'WRONG_SKU',
          expectedProductId: 'prod-other',
          expectedSku: 'SKU-OTHER',
        }),
        'pickup',
      ],
      [
        pilotReview({ verdict: 'WRONG_ACTION', expectedAction: 'RETURN' }),
        'pickup',
      ],
      [
        pilotReview({ verdict: 'FALSE_TOUCH', expectedAction: 'NO_OP' }),
        'falseTouch',
      ],
    ];
    for (const [review, bucket] of cases) {
      const { service } = buildHarness({
        evaluationRun: LINKED_RUN,
        truths: [truthRow()],
        runs: [fusionRun()],
        importedEvents: [importedEvent()],
        pilotReviews: [review],
      });
      const report = await service.report(TENANT, PRODUCT.id);
      expect(report.videos[0].reviewed).toBe(true);
      if (bucket === 'pickup') {
        expect(report.counts.reviewedPickupExamples).toBe(1);
        expect(report.counts.reviewedFalseTouchExamples).toBe(0);
      } else {
        expect(report.counts.reviewedFalseTouchExamples).toBe(1);
        expect(report.counts.reviewedPickupExamples).toBe(0);
      }
    }
  });

  it('excludes session-bound and location-less clips from every count and gate', async () => {
    const { service } = buildHarness({
      evaluationRun: LINKED_RUN,
      truths: [
        truthRow({
          videoAssetId: 'va-session',
          videoAsset: asset({ sessionId: 'session-1' }),
        }),
        truthRow({
          videoAssetId: 'va-no-store',
          videoAsset: asset({ locationId: null }),
        }),
        truthRow({ videoAssetId: 'va-good' }),
      ],
      runs: [fusionRun({ videoAssetId: 'va-good' })],
      importedEvents: [importedEvent({ videoAssetId: 'va-good' })],
      pilotReviews: [pilotReview()],
    });
    const report = await service.report(TENANT, PRODUCT.id);
    expect(
      report.videos.find((row) => row.videoAssetId === 'va-session')
        ?.excludedReason,
    ).toBe('SESSION_BOUND');
    expect(
      report.videos.find((row) => row.videoAssetId === 'va-no-store')
        ?.excludedReason,
    ).toBe('MISSING_STORE_CONTEXT');
    // Excluded rows neither satisfy nor block: the one good clip is
    // reviewed, so nothing is pending and ALL_REVIEWED is satisfied.
    expect(report.counts.totalClips).toBe(1);
    expect(report.counts.excludedClips).toBe(2);
    expect(report.counts.unreviewedClips).toBe(0);
    expect(
      report.gates.items.find((item) => item.key === 'ALL_REVIEWED')?.satisfied,
    ).toBe(true);
  });

  it('never counts a missed PICKUP/RETURN as reviewed', async () => {
    const { service } = buildHarness({
      evaluationRun: LINKED_RUN,
      truths: [truthRow({ videoAssetId: 'va-4' })],
      jobs: [
        { sourceId: 'pickup:va-4', status: 'SUCCEEDED', visionEventId: null },
      ],
    });
    const report = await service.report(TENANT, PRODUCT.id);
    expect(report.videos[0].reviewed).toBe(false);
    expect(report.videos[0].missedPositiveEvent).toBe(true);
    expect(report.videos[0].needsReview).toBe(true);
    expect(
      report.failureReasons.find((r) => r.reason === 'MISSED_POSITIVE_EVENT')
        ?.count,
    ).toBe(1);
  });

  it('auto-reviews a NONE clip only when nothing was proposed', async () => {
    const { service } = buildHarness({
      evaluationRun: LINKED_RUN,
      truths: [
        truthRow({
          videoAssetId: 'va-none-clean',
          eventKind: 'NONE',
          product: null,
        }),
        truthRow({
          videoAssetId: 'va-none-proposed',
          eventKind: 'NONE',
          product: null,
        }),
      ],
      runs: [
        fusionRun({ videoAssetId: 'va-none-clean', policy: 'NEEDS_VLM' }),
        fusionRun({
          id: 'fusion-2',
          videoAssetId: 'va-none-proposed',
          policy: 'AUTO_PROPOSE',
        }),
      ],
    });
    const report = await service.report(TENANT, PRODUCT.id);
    const clean = report.videos.find(
      (row) => row.videoAssetId === 'va-none-clean',
    );
    const proposed = report.videos.find(
      (row) => row.videoAssetId === 'va-none-proposed',
    );
    // Nothing proposed → the NONE label is the record.
    expect(clean?.reviewed).toBe(true);
    // A (false) proposal exists → it needs an explicit FALSE_TOUCH review.
    expect(proposed?.reviewed).toBe(false);
    // But an event-less true negative is NOT a Phase 18 example.
    expect(report.counts.reviewedFalseTouchExamples).toBe(0);
  });

  it('selects the latest fusion evidence by run timestamp, not ground-truth order', async () => {
    const { service } = buildHarness({
      evaluationRun: LINKED_RUN,
      truths: [
        truthRow({ videoAssetId: 'va-old-run' }),
        truthRow({ videoAssetId: 'va-new-run' }),
      ],
      runs: [
        fusionRun({
          id: 'fusion-new',
          videoAssetId: 'va-new-run',
          createdAt: new Date('2026-08-24T12:00:00Z'),
          evidence: evidence({ fused: [{ sku: 'SKU-NEWEST', fusedScore: 0.9 }] }),
        }),
        fusionRun({
          id: 'fusion-old',
          videoAssetId: 'va-old-run',
          createdAt: new Date('2026-08-24T08:00:00Z'),
          policy: 'NEEDS_VLM',
          evidence: evidence({ fused: [{ sku: 'SKU-STALE', fusedScore: 0.2 }] }),
        }),
      ],
    });
    const report = await service.report(TENANT, PRODUCT.id);
    expect(report.latest?.predictedSku).toBe('SKU-NEWEST');
    expect(report.latest?.policy).toBe('AUTO_PROPOSE');
  });

  it('marks an operator crop CONNECTED only when a review carries its marker', async () => {
    const operatorCrop = {
      id: 'artifact-manual-1',
      videoAssetId: 'va-1',
      timestampMs: 2100,
      cropX: 600,
      cropY: 300,
      cropWidth: 500,
      cropHeight: 600,
      createdAt: new Date('2026-08-24T11:00:00Z'),
    };
    // Case 1: the review STRUCTURALLY references the crop → connected,
    // CLEAN_CROP can pass (same field Phase 18 copies into candidates).
    const connected = buildHarness({
      evaluationRun: LINKED_RUN,
      truths: [truthRow()],
      runs: [fusionRun()],
      importedEvents: [importedEvent()],
      pilotReviews: [
        pilotReview({
          operatorCropArtifactId: 'artifact-manual-1',
          createdAt: new Date('2026-08-24T12:00:00Z'),
        }),
      ],
      operatorCrops: [operatorCrop],
    });
    const connectedReport = await connected.service.report(TENANT, PRODUCT.id);
    const connectedFusion = connectedReport.videos[0].fusion;
    expect(connectedFusion?.cropSource).toBe('OPERATOR');
    expect(connectedFusion?.cropArtifactId).toBe('artifact-manual-1');
    expect(connectedFusion?.cropEvidenceConnected).toBe(true);
    expect(
      connectedReport.gates.items.find((item) => item.key === 'CLEAN_CROP')
        ?.satisfied,
    ).toBe(true);

    // Case 2: no structured reference → display-only crop, CLEAN_CROP
    // must fail.
    const unconnected = buildHarness({
      evaluationRun: LINKED_RUN,
      truths: [truthRow()],
      runs: [fusionRun()],
      importedEvents: [importedEvent()],
      pilotReviews: [pilotReview()],
      operatorCrops: [operatorCrop],
    });
    const unconnectedReport = await unconnected.service.report(
      TENANT,
      PRODUCT.id,
    );
    expect(unconnectedReport.videos[0].fusion?.cropEvidenceConnected).toBe(
      false,
    );
    const gate = unconnectedReport.gates.items.find(
      (item) => item.key === 'CLEAN_CROP',
    );
    expect(gate?.satisfied).toBe(false);
    expect(gate?.detail).toContain('not connected to evidence');
  });

  it('ignores an operator crop that is OLDER than the latest fusion run', async () => {
    const { service } = buildHarness({
      evaluationRun: LINKED_RUN,
      truths: [truthRow()],
      runs: [fusionRun({ createdAt: new Date('2026-08-24T12:00:00Z') })],
      operatorCrops: [
        {
          id: 'artifact-manual-old',
          videoAssetId: 'va-1',
          timestampMs: 900,
          cropX: 0,
          cropY: 0,
          cropWidth: 10,
          cropHeight: 10,
          createdAt: new Date('2026-08-24T09:00:00Z'),
        },
      ],
    });
    const report = await service.report(TENANT, PRODUCT.id);
    expect(report.videos[0].fusion?.cropSource).toBe('AUTO');
  });

  it('never leaks raw evidence text, storage keys, or paths in the response', async () => {
    const { service } = buildHarness({
      evaluationRun: LINKED_RUN,
      truths: [truthRow()],
      runs: [
        fusionRun({
          policy: 'NEEDS_VLM',
          evidence: evidence({
            ocr: {
              rawText: 'LEAKED-OCR-TEXT-4111111111111111',
              normalizedText: 'leaked-normalized',
              status: 'OK',
            },
            barcode: {
              results: [{ value: 'LEAKED-BARCODE-VALUE', format: 'EAN13' }],
              matchedSku: null,
            },
            stages: [{ stage: 'decode', note: 'C:/videos/raw/secret.mp4' }],
          }),
        }),
      ],
    });
    const serialized = JSON.stringify(await service.report(TENANT, PRODUCT.id));
    expect(serialized).not.toContain('LEAKED-OCR-TEXT');
    expect(serialized).not.toContain('4111111111111111');
    expect(serialized).not.toContain('leaked-normalized');
    expect(serialized).not.toContain('LEAKED-BARCODE-VALUE');
    expect(serialized).not.toContain('secret.mp4');
    expect(serialized).not.toContain('storageKey');
  });

  it('reports an empty-but-honest baseline for a fresh SKU', async () => {
    const { service } = buildHarness({});
    const report = await service.report(TENANT, PRODUCT.id);
    expect(report.counts.totalClips).toBe(0);
    expect(report.latest).toBeNull();
    expect(report.linkedEvaluationRun).toBeNull();
    expect(report.references.inferenceReady).toBe(false);
    expect(report.inventory.stocked).toBe(false);
    expect(report.gates.readyForDatasetImprovement).toBe(false);
    expect(report.scoreNote).toContain('no accuracy claim');
  });
});

describe('OneSkuBootstrapService.ensureEvaluationRun', () => {
  it('returns the existing run without creating a duplicate', async () => {
    const { service, evaluations } = buildHarness({
      evaluationRun: { ...LINKED_RUN, _count: { reviews: 0 } },
    });
    const result = await service.ensureEvaluationRun(TENANT, PRODUCT.id);
    expect(result).toEqual({
      evaluationRunId: 'eval-1',
      name: bootstrapRunName(PRODUCT.sku),
      status: 'OPEN',
      created: false,
    });
    expect(evaluations.createRun).not.toHaveBeenCalled();
  });

  it('creates the run through PilotEvaluationService (no raw prisma write)', async () => {
    const { service, evaluations } = buildHarness({});
    const result = await service.ensureEvaluationRun(TENANT, PRODUCT.id, 'user-1');
    expect(result.created).toBe(true);
    expect(evaluations.createRun).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ name: bootstrapRunName(PRODUCT.sku) }),
      'user-1',
    );
  });

  it.each([['COMPLETED'], ['CANCELLED']])(
    'replaces a terminal (%s) run with a NEW suffixed OPEN successor',
    async (status) => {
      const { service, evaluations } = buildHarness({
        evaluationRuns: [{ ...LINKED_RUN, status }],
      });
      const result = await service.ensureEvaluationRun(TENANT, PRODUCT.id);
      // Never writes to the terminal run: a fresh OPEN run is created
      // with a unique name so deterministic naming cannot block it.
      expect(result.created).toBe(true);
      expect(evaluations.createRun).toHaveBeenCalledWith(
        TENANT,
        expect.objectContaining({
          name: `${bootstrapRunName(PRODUCT.sku)} (2)`,
        }),
        undefined,
      );
    },
  );

  it('reuses the OPEN successor even when a terminal run is newer-named', async () => {
    const { service, evaluations } = buildHarness({
      evaluationRuns: [
        {
          id: 'eval-2',
          name: `${bootstrapRunName(PRODUCT.sku)} (2)`,
          status: 'OPEN',
          bootstrapProductId: null,
          _count: { reviews: 3 },
        },
        { ...LINKED_RUN, status: 'COMPLETED' },
      ],
    });
    const result = await service.ensureEvaluationRun(TENANT, PRODUCT.id);
    expect(result).toEqual({
      evaluationRunId: 'eval-2',
      name: `${bootstrapRunName(PRODUCT.sku)} (2)`,
      status: 'OPEN',
      created: false,
    });
    expect(evaluations.createRun).not.toHaveBeenCalled();
  });
});

describe('isBootstrapRunNameFor', () => {
  it('matches the base name and " (n)" successors only', () => {
    expect(isBootstrapRunNameFor(bootstrapRunName('SKU-A'), 'SKU-A')).toBe(true);
    expect(
      isBootstrapRunNameFor(`${bootstrapRunName('SKU-A')} (2)`, 'SKU-A'),
    ).toBe(true);
    expect(
      isBootstrapRunNameFor(`${bootstrapRunName('SKU-A')} extra`, 'SKU-A'),
    ).toBe(false);
  });

  it('never matches a LONGER SKU that has this SKU as a prefix', () => {
    // startsWith alone would leak SKU-A2's run into SKU-A's family.
    expect(isBootstrapRunNameFor(bootstrapRunName('SKU-A2'), 'SKU-A')).toBe(
      false,
    );
  });
});

describe('OneSkuBootstrapService report — terminal runs are not the active link', () => {
  it('links only an OPEN family run; terminal runs leave the gate unsatisfied', async () => {
    const { service } = buildHarness({
      evaluationRuns: [{ ...LINKED_RUN, status: 'COMPLETED' }],
    });
    const report = await service.report(TENANT, PRODUCT.id);
    expect(report.linkedEvaluationRun).toBeNull();
    expect(
      report.gates.items.find((item) => item.key === 'EVALUATION_RUN_LINKED')
        ?.satisfied,
    ).toBe(false);
  });
});

describe('OneSkuBootstrapService.reviewClip', () => {
  // A valid WRONG_SKU correction: the prediction named some OTHER
  // product, and the correction restores the clip's ground-truth product
  // (Codex P1: the corrected product may ONLY be the ground truth's).
  const reviewInput = {
    verdict: 'WRONG_SKU' as never,
    expectedAction: 'PICKUP' as never,
    expectedProductId: PRODUCT.id,
    notes: null,
  };
  const mispredictedEvent = (over: Row = {}) =>
    importedEvent({ productId: 'prod-other', sku: 'SKU-OTHER', ...over });
  const reviewClipBase: HarnessData = {
    videoAsset: { id: 'va-1', locationId: 'loc-1', unitId: 'unit-1', sessionId: null },
    groundTruth: { eventKind: 'PICKUP', productId: PRODUCT.id },
    runs: [{ id: 'fusion-1', createdAt: new Date('2026-08-24T10:00:00Z') }],
    evaluationRun: { ...LINKED_RUN, _count: { reviews: 0 } },
  };

  it('refuses session-bound clips outright (basket safety)', async () => {
    const { service, evaluations, journeys } = buildHarness({
      ...reviewClipBase,
      videoAsset: { id: 'va-1', locationId: 'loc-1', unitId: null, sessionId: 'session-1' },
    });
    await expect(
      service.reviewClip(TENANT, PRODUCT.id, 'va-1', reviewInput),
    ).rejects.toThrow(ConflictException);
    expect(evaluations.reviewObservation).not.toHaveBeenCalled();
    expect(journeys.create).not.toHaveBeenCalled();
  });

  it('refuses verdicts outside the bootstrap subset', async () => {
    const { service } = buildHarness({});
    await expect(
      service.reviewClip(TENANT, PRODUCT.id, 'va-1', {
        ...reviewInput,
        verdict: 'MISSED_EVENT' as never,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('requires ground truth before any correction', async () => {
    const { service } = buildHarness({ ...reviewClipBase, groundTruth: null });
    await expect(
      service.reviewClip(TENANT, PRODUCT.id, 'va-1', reviewInput),
    ).rejects.toThrow(ConflictException);
  });

  it('requires a fusion run before a correction can be recorded', async () => {
    const { service } = buildHarness({ ...reviewClipBase, runs: [] });
    await expect(
      service.reviewClip(TENANT, PRODUCT.id, 'va-1', reviewInput),
    ).rejects.toThrow(ConflictException);
  });

  it('rejects CORRECT when the predicted ACTION differs from ground truth', async () => {
    // Ground truth RETURN, prediction imported as PRODUCT_PICKUP.
    const { service, evaluations } = buildHarness({
      ...reviewClipBase,
      groundTruth: { eventKind: 'RETURN', productId: PRODUCT.id },
      journeyEventLookups: [importedEvent()],
    });
    await expect(
      service.reviewClip(TENANT, PRODUCT.id, 'va-1', {
        verdict: 'CORRECT' as never,
        expectedAction: 'RETURN' as never,
        expectedProductId: null,
        notes: null,
      }),
    ).rejects.toThrow(/WRONG_ACTION/);
    expect(evaluations.reviewObservation).not.toHaveBeenCalled();
  });

  it('rejects CORRECT when the predicted SKU differs from ground truth', async () => {
    const { service } = buildHarness({
      ...reviewClipBase,
      journeyEventLookups: [
        importedEvent({ productId: 'prod-other', sku: 'SKU-OTHER' }),
      ],
    });
    await expect(
      service.reviewClip(TENANT, PRODUCT.id, 'va-1', {
        verdict: 'CORRECT' as never,
        expectedAction: 'PICKUP' as never,
        expectedProductId: null,
        notes: null,
      }),
    ).rejects.toThrow(/WRONG_SKU/);
  });

  it('accepts CORRECT only when sku AND action both match, and WRONG_ACTION carries the corrected action', async () => {
    // CORRECT happy path.
    const correct = buildHarness({
      ...reviewClipBase,
      journeyEventLookups: [importedEvent()],
    });
    await correct.service.reviewClip(TENANT, PRODUCT.id, 'va-1', {
      verdict: 'CORRECT' as never,
      expectedAction: 'PICKUP' as never,
      expectedProductId: null,
      notes: null,
    });
    expect(correct.evaluations.reviewObservation).toHaveBeenCalledWith(
      TENANT,
      'eval-1',
      expect.objectContaining({ verdict: 'CORRECT' }),
      undefined,
      { allowVideoShadowEvent: true },
    );

    // Ground truth RETURN + predicted PICKUP → WRONG_ACTION with RETURN.
    const wrongAction = buildHarness({
      ...reviewClipBase,
      groundTruth: { eventKind: 'RETURN', productId: PRODUCT.id },
      journeyEventLookups: [importedEvent()],
    });
    await wrongAction.service.reviewClip(TENANT, PRODUCT.id, 'va-1', {
      verdict: 'WRONG_ACTION' as never,
      expectedAction: 'RETURN' as never,
      expectedProductId: null,
      notes: null,
    });
    expect(wrongAction.evaluations.reviewObservation).toHaveBeenCalledWith(
      TENANT,
      'eval-1',
      expect.objectContaining({
        verdict: 'WRONG_ACTION',
        expectedAction: 'RETURN',
      }),
      undefined,
      { allowVideoShadowEvent: true },
    );
  });

  it('rejects WRONG_ACTION whose corrected action equals the prediction', async () => {
    const { service } = buildHarness({
      ...reviewClipBase,
      journeyEventLookups: [importedEvent()],
    });
    await expect(
      service.reviewClip(TENANT, PRODUCT.id, 'va-1', {
        verdict: 'WRONG_ACTION' as never,
        expectedAction: 'PICKUP' as never,
        expectedProductId: null,
        notes: null,
      }),
    ).rejects.toThrow(/CORRECTION_NOT_DIFFERENT/);
  });

  it('rejects WRONG_SKU without a correction or with an unchanged one', async () => {
    const missing = buildHarness({
      ...reviewClipBase,
      journeyEventLookups: [importedEvent()],
    });
    await expect(
      missing.service.reviewClip(TENANT, PRODUCT.id, 'va-1', {
        verdict: 'WRONG_SKU' as never,
        expectedAction: 'PICKUP' as never,
        expectedProductId: null,
        notes: null,
      }),
    ).rejects.toThrow(/MISSING_CORRECTED_SKU/);

    const unchanged = buildHarness({
      ...reviewClipBase,
      journeyEventLookups: [importedEvent()],
    });
    await expect(
      unchanged.service.reviewClip(TENANT, PRODUCT.id, 'va-1', {
        verdict: 'WRONG_SKU' as never,
        expectedAction: 'PICKUP' as never,
        expectedProductId: PRODUCT.id,
        notes: null,
      }),
    ).rejects.toThrow(/CORRECTION_NOT_DIFFERENT/);
  });

  it('imports the fusion run as a shadow journey event and appends a pilot review', async () => {
    const { service, evaluations, journeys, prisma, txQueryRaw } = buildHarness({
      ...reviewClipBase,
    });
    // Lookup order: outside the lock (miss), inside the lock (still a
    // miss — this request wins the import), after the append (hit).
    prisma.customerJourneyEvent.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(mispredictedEvent() as never);

    const result = await service.reviewClip(
      TENANT,
      PRODUCT.id,
      'va-1',
      reviewInput,
      'user-1',
    );
    // The import ran INSIDE the advisory-lock transaction (Codex P2).
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(txQueryRaw).toHaveBeenCalledTimes(1);
    expect(journeys.create).toHaveBeenCalledWith(
      TENANT,
      { locationId: 'loc-1', unitId: 'unit-1' },
      'user-1',
    );
    expect(journeys.appendFromFusionRun).toHaveBeenCalledWith(
      TENANT,
      'journey-1',
      'va-1',
      'user-1',
      { fusionRunId: 'fusion-1', proposeBelowThreshold: true },
    );
    expect(evaluations.reviewObservation).toHaveBeenCalledWith(
      TENANT,
      'eval-1',
      expect.objectContaining({
        verdict: 'WRONG_SKU',
        journeyEventId: 'jevt-1',
        expectedProductId: PRODUCT.id,
      }),
      'user-1',
      { allowVideoShadowEvent: true },
    );
    expect(result.journeyEventId).toBe('jevt-1');
  });

  it('binds a newer operator crop STRUCTURALLY — never via notes', async () => {
    const { service, evaluations } = buildHarness({
      ...reviewClipBase,
      journeyEventLookups: [mispredictedEvent()],
      reviewOperatorCrop: { id: 'artifact-manual-1' },
    });
    await service.reviewClip(TENANT, PRODUCT.id, 'va-1', {
      ...reviewInput,
      notes: 'operator confirmed the can is visible',
    });
    expect(evaluations.reviewObservation).toHaveBeenCalledWith(
      TENANT,
      'eval-1',
      expect.objectContaining({
        operatorCropArtifactId: 'artifact-manual-1',
        // Notes pass through UNMODIFIED — the association is structured
        // data, not a parsed marker.
        notes: 'operator confirmed the can is visible',
      }),
      undefined,
      { allowVideoShadowEvent: true },
    );
  });

  it('passes operatorCropArtifactId null when no newer manual crop exists', async () => {
    const { service, evaluations } = buildHarness({
      ...reviewClipBase,
      journeyEventLookups: [mispredictedEvent()],
      reviewOperatorCrop: null,
    });
    await service.reviewClip(TENANT, PRODUCT.id, 'va-1', reviewInput);
    expect(evaluations.reviewObservation).toHaveBeenCalledWith(
      TENANT,
      'eval-1',
      expect.objectContaining({ operatorCropArtifactId: null }),
      undefined,
      { allowVideoShadowEvent: true },
    );
  });

  it('rejects WRONG_SKU when the predicted ACTION is also wrong (must be WRONG_ACTION)', async () => {
    // Ground truth RETURN, prediction imported as PRODUCT_PICKUP with a
    // different product: persisting WRONG_SKU would keep the wrong action.
    const { service, evaluations } = buildHarness({
      ...reviewClipBase,
      groundTruth: { eventKind: 'RETURN', productId: PRODUCT.id },
      journeyEventLookups: [
        importedEvent({ productId: 'prod-other', sku: 'SKU-OTHER' }),
      ],
    });
    await expect(
      service.reviewClip(TENANT, PRODUCT.id, 'va-1', {
        verdict: 'WRONG_SKU' as never,
        expectedAction: 'RETURN' as never,
        expectedProductId: PRODUCT.id,
        notes: null,
      }),
    ).rejects.toThrow(/WRONG_ACTION/);
    expect(evaluations.reviewObservation).not.toHaveBeenCalled();
  });

  it('requires the corrected product on WRONG_ACTION when the SKU is also wrong', async () => {
    const { service } = buildHarness({
      ...reviewClipBase,
      groundTruth: { eventKind: 'RETURN', productId: PRODUCT.id },
      journeyEventLookups: [
        importedEvent({ productId: 'prod-other', sku: 'SKU-OTHER' }),
      ],
    });
    await expect(
      service.reviewClip(TENANT, PRODUCT.id, 'va-1', {
        verdict: 'WRONG_ACTION' as never,
        expectedAction: 'RETURN' as never,
        expectedProductId: null,
        notes: null,
      }),
    ).rejects.toThrow(/corrected product/);
  });

  it('records a both-wrong correction as WRONG_ACTION with BOTH corrected fields', async () => {
    const { service, evaluations } = buildHarness({
      ...reviewClipBase,
      groundTruth: { eventKind: 'RETURN', productId: PRODUCT.id },
      journeyEventLookups: [
        importedEvent({ productId: 'prod-other', sku: 'SKU-OTHER' }),
      ],
    });
    await service.reviewClip(TENANT, PRODUCT.id, 'va-1', {
      verdict: 'WRONG_ACTION' as never,
      expectedAction: 'RETURN' as never,
      expectedProductId: PRODUCT.id,
      notes: null,
    });
    expect(evaluations.reviewObservation).toHaveBeenCalledWith(
      TENANT,
      'eval-1',
      expect.objectContaining({
        verdict: 'WRONG_ACTION',
        expectedAction: 'RETURN',
        expectedProductId: PRODUCT.id,
      }),
      undefined,
      { allowVideoShadowEvent: true },
    );
  });

  it('reuses an already-imported journey event without opening a new journey', async () => {
    const { service, journeys, prisma } = buildHarness({
      ...reviewClipBase,
      journeyEventLookups: [mispredictedEvent({ id: 'event-existing' })],
    });
    const result = await service.reviewClip(
      TENANT,
      PRODUCT.id,
      'va-1',
      reviewInput,
    );
    expect(journeys.create).not.toHaveBeenCalled();
    expect(journeys.appendFromFusionRun).not.toHaveBeenCalled();
    // No import needed → no lock transaction either.
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(result.journeyEventId).toBe('event-existing');
  });

  // Route-product binding (Codex P1): a positive clip ground-truthed for
  // ANOTHER product must never become this product's bootstrap evidence.
  it.each([['PICKUP'], ['RETURN']] as const)(
    'rejects a %s clip whose ground truth belongs to a different product',
    async (eventKind) => {
      const { service, evaluations, journeys } = buildHarness({
        ...reviewClipBase,
        groundTruth: { eventKind, productId: 'prod-other' },
      });
      await expect(
        service.reviewClip(TENANT, PRODUCT.id, 'va-1', reviewInput),
      ).rejects.toThrow(/different product/);
      // Nothing was created or attached: no evaluation run, no shadow
      // journey event, no pilot review — Phase 18 can collect nothing.
      expect(evaluations.createRun).not.toHaveBeenCalled();
      expect(evaluations.reviewObservation).not.toHaveBeenCalled();
      expect(journeys.create).not.toHaveBeenCalled();
      expect(journeys.appendFromFusionRun).not.toHaveBeenCalled();
    },
  );

  it('rejects a positive clip whose ground truth carries NO product', async () => {
    const { service, evaluations } = buildHarness({
      ...reviewClipBase,
      groundTruth: { eventKind: 'PICKUP', productId: null },
    });
    await expect(
      service.reviewClip(TENANT, PRODUCT.id, 'va-1', reviewInput),
    ).rejects.toThrow(ConflictException);
    expect(evaluations.reviewObservation).not.toHaveBeenCalled();
  });

  it('still accepts a NONE (false-touch) clip with a null ground-truth product', async () => {
    // NONE ground truth force-nulls productId — negatives stay
    // tenant-wide by design and must not be blocked by the binding.
    const { service, evaluations } = buildHarness({
      ...reviewClipBase,
      groundTruth: { eventKind: 'NONE', productId: null },
      journeyEventLookups: [importedEvent()],
    });
    await service.reviewClip(TENANT, PRODUCT.id, 'va-1', {
      verdict: 'FALSE_TOUCH' as never,
      expectedAction: 'NO_OP' as never,
      expectedProductId: null,
      notes: null,
    });
    expect(evaluations.reviewObservation).toHaveBeenCalledWith(
      TENANT,
      'eval-1',
      expect.objectContaining({ verdict: 'FALSE_TOUCH' }),
      undefined,
      { allowVideoShadowEvent: true },
    );
  });

  it('serializes the per-clip import and reuses a concurrently imported event', async () => {
    // The outside-lock lookup misses, but the in-lock re-check finds the
    // event a concurrent first review imported — no second journey, no
    // second FUSION_SHADOW event, no duplicate Phase 18 footage.
    const { service, journeys, evaluations, prisma, txQueryRaw } =
      buildHarness({
        ...reviewClipBase,
        journeyEventLookups: [
          null,
          mispredictedEvent({ id: 'event-winner' }),
        ],
      });
    const result = await service.reviewClip(
      TENANT,
      PRODUCT.id,
      'va-1',
      reviewInput,
    );
    expect(txQueryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(journeys.create).not.toHaveBeenCalled();
    expect(journeys.appendFromFusionRun).not.toHaveBeenCalled();
    expect(result.journeyEventId).toBe('event-winner');
    // The review binds to the winner's event — both concurrent reviews
    // resolve to the SAME Phase 18 source evidence.
    expect(evaluations.reviewObservation).toHaveBeenCalledWith(
      TENANT,
      'eval-1',
      expect.objectContaining({ journeyEventId: 'event-winner' }),
      undefined,
      { allowVideoShadowEvent: true },
    );
  });

  // Correction product lineage (Codex P1): the corrected product may
  // ONLY be the clip's ground-truth product.
  it('rejects a corrected product that is neither the prediction nor the ground truth', async () => {
    // Ground truth A (route product), predicted B — correcting to C
    // would hand Phase 18 a third SKU while the report counts the clip
    // toward A.
    const { service, evaluations, journeys, prisma } = buildHarness({
      ...reviewClipBase,
      journeyEventLookups: [mispredictedEvent()],
    });
    await expect(
      service.reviewClip(TENANT, PRODUCT.id, 'va-1', {
        verdict: 'WRONG_SKU' as never,
        expectedAction: 'PICKUP' as never,
        expectedProductId: 'prod-third',
        notes: null,
      }),
    ).rejects.toThrow(/ground-truth product/);
    // Nothing was created or attached — rejected before run/import/review.
    expect(evaluations.createRun).not.toHaveBeenCalled();
    expect(evaluations.reviewObservation).not.toHaveBeenCalled();
    expect(journeys.create).not.toHaveBeenCalled();
    expect(journeys.appendFromFusionRun).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects WRONG_SKU with a MISSING corrected product BEFORE anything is created', async () => {
    const { service, evaluations, journeys, prisma } = buildHarness({
      ...reviewClipBase,
    });
    await expect(
      service.reviewClip(TENANT, PRODUCT.id, 'va-1', {
        verdict: 'WRONG_SKU' as never,
        expectedAction: 'PICKUP' as never,
        expectedProductId: null,
        notes: null,
      }),
    ).rejects.toThrow(/MISSING_CORRECTED_SKU/);
    expect(evaluations.createRun).not.toHaveBeenCalled();
    expect(evaluations.reviewObservation).not.toHaveBeenCalled();
    expect(journeys.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('accepts WRONG_SKU when the correction restores the ground-truth product', async () => {
    const { service, evaluations } = buildHarness({
      ...reviewClipBase,
      journeyEventLookups: [mispredictedEvent()],
    });
    await service.reviewClip(TENANT, PRODUCT.id, 'va-1', reviewInput);
    expect(evaluations.reviewObservation).toHaveBeenCalledWith(
      TENANT,
      'eval-1',
      expect.objectContaining({
        verdict: 'WRONG_SKU',
        expectedProductId: PRODUCT.id,
      }),
      undefined,
      { allowVideoShadowEvent: true },
    );
  });

  it('rejects a both-wrong WRONG_ACTION whose corrected product is not the ground truth', async () => {
    const { service, evaluations } = buildHarness({
      ...reviewClipBase,
      groundTruth: { eventKind: 'RETURN', productId: PRODUCT.id },
      journeyEventLookups: [mispredictedEvent()],
    });
    await expect(
      service.reviewClip(TENANT, PRODUCT.id, 'va-1', {
        verdict: 'WRONG_ACTION' as never,
        expectedAction: 'RETURN' as never,
        expectedProductId: 'prod-third',
        notes: null,
      }),
    ).rejects.toThrow(/ground-truth product/);
    expect(evaluations.reviewObservation).not.toHaveBeenCalled();
  });

  it('rejects any corrected product on a NONE clip (no ground-truth product exists)', async () => {
    const { service, evaluations } = buildHarness({
      ...reviewClipBase,
      groundTruth: { eventKind: 'NONE', productId: null },
    });
    await expect(
      service.reviewClip(TENANT, PRODUCT.id, 'va-1', {
        verdict: 'WRONG_SKU' as never,
        expectedAction: 'PICKUP' as never,
        expectedProductId: 'prod-other',
        notes: null,
      }),
    ).rejects.toThrow(/ground-truth product/);
    expect(evaluations.reviewObservation).not.toHaveBeenCalled();
  });
});

describe('OneSkuBootstrapService.report — inventory redaction (Codex P1)', () => {
  const LEVELS = [
    {
      locationId: 'loc-1',
      quantity: 4,
      location: { name: 'Main Street Store', code: 'MAIN-01' },
    },
  ];

  it('redacts stock details for a caller without inventory:read', async () => {
    const { service, platformModules } = buildHarness({ levels: LEVELS });
    // Default viewer = no inventory permission (fail closed).
    const report = await service.report(TENANT, PRODUCT.id);
    expect(report.inventory.stocked).toBe(true);
    expect(report.inventory.detailsVisible).toBe(false);
    expect(report.inventory.totalOnHand).toBeNull();
    expect(report.inventory.levels).toEqual([]);
    // Without the permission the module lookup is not even consulted.
    expect(platformModules.isEnabledForTenant).not.toHaveBeenCalled();
    // No location name/code or exact quantity anywhere in the response.
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('Main Street Store');
    expect(serialized).not.toContain('MAIN-01');
    // The readiness gate still works — classification only, no number.
    const gate = report.gates.items.find(
      (item) => item.key === 'INVENTORY_STOCKED',
    );
    expect(gate?.satisfied).toBe(true);
    expect(gate?.detail).toBe(
      'stocked (details hidden — inventory permission required)',
    );
  });

  it('shows stock details when the caller has inventory:read AND the module', async () => {
    const { service, platformModules } = buildHarness({ levels: LEVELS });
    const report = await service.report(TENANT, PRODUCT.id, {
      hasInventoryReadPermission: true,
    });
    expect(platformModules.isEnabledForTenant).toHaveBeenCalledWith(
      TENANT,
      'inventory',
    );
    expect(report.inventory.detailsVisible).toBe(true);
    expect(report.inventory.totalOnHand).toBe(4);
    expect(report.inventory.levels).toEqual([
      {
        locationId: 'loc-1',
        locationName: 'Main Street Store',
        locationCode: 'MAIN-01',
        quantity: 4,
      },
    ]);
    expect(
      report.gates.items.find((item) => item.key === 'INVENTORY_STOCKED')
        ?.detail,
    ).toBe('4 on hand across stores');
  });

  it('redacts when the tenant does NOT have the inventory module enabled', async () => {
    const { service } = buildHarness({
      levels: LEVELS,
      inventoryModuleEnabled: false,
    });
    const report = await service.report(TENANT, PRODUCT.id, {
      hasInventoryReadPermission: true,
    });
    expect(report.inventory.detailsVisible).toBe(false);
    expect(report.inventory.totalOnHand).toBeNull();
    expect(report.inventory.levels).toEqual([]);
  });

  it('keeps the not-stocked classification honest for a redacted caller', async () => {
    const { service } = buildHarness({ levels: [] });
    const report = await service.report(TENANT, PRODUCT.id);
    expect(report.inventory.stocked).toBe(false);
    expect(
      report.gates.items.find((item) => item.key === 'INVENTORY_STOCKED')
        ?.detail,
    ).toBe('not stocked');
  });
});

describe('OneSkuBootstrapService.ensureEvaluationRun — race and prefix safety (Codex P2)', () => {
  it('stamps the structured bootstrap identity on creation', async () => {
    const { service, evaluations } = buildHarness({});
    await service.ensureEvaluationRun(TENANT, PRODUCT.id, 'user-1');
    expect(evaluations.createRun).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({
        name: bootstrapRunName(PRODUCT.sku),
        bootstrapProductId: PRODUCT.id,
      }),
      'user-1',
    );
  });

  it('resolves a concurrent-create loss (P2002) to the winner run', async () => {
    const { service, evaluations, prisma } = buildHarness({});
    // First family lookup: empty. The create then loses the race on the
    // one-open-bootstrap-run-per-product partial unique index; the
    // re-read sees the winner.
    (evaluations.createRun as jest.Mock).mockRejectedValueOnce({
      code: 'P2002',
    });
    (prisma.pilotEvaluationRun.findMany as jest.Mock)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 'eval-winner',
          name: bootstrapRunName(PRODUCT.sku),
          status: 'OPEN',
          bootstrapProductId: PRODUCT.id,
          _count: { reviews: 1 },
        },
      ]);
    const result = await service.ensureEvaluationRun(TENANT, PRODUCT.id);
    expect(result).toEqual({
      evaluationRunId: 'eval-winner',
      name: bootstrapRunName(PRODUCT.sku),
      status: 'OPEN',
      created: false,
    });
  });

  it('rethrows non-unique-violation createRun errors unchanged', async () => {
    const { service, evaluations } = buildHarness({});
    (evaluations.createRun as jest.Mock).mockRejectedValueOnce(
      new Error('db down'),
    );
    await expect(
      service.ensureEvaluationRun(TENANT, PRODUCT.id),
    ).rejects.toThrow('db down');
  });

  it('finds the exact-family open run among 60+ prefix-colliding runs (no pre-limit)', async () => {
    // 60 OPEN runs for LONGER SKUs sharing this SKU's prefix would have
    // overflowed the old take-50 window and hidden the real run.
    const noise = Array.from({ length: 60 }, (_, i) => ({
      id: `noise-${i}`,
      name: bootstrapRunName(`${PRODUCT.sku}-${i}`),
      status: 'OPEN',
      bootstrapProductId: null,
      _count: { reviews: 0 },
    }));
    const real = {
      id: 'eval-real',
      name: bootstrapRunName(PRODUCT.sku),
      status: 'OPEN',
      bootstrapProductId: null,
      _count: { reviews: 2 },
    };
    const { service, evaluations, prisma } = buildHarness({
      evaluationRuns: [...noise, real],
    });
    const ensured = await service.ensureEvaluationRun(TENANT, PRODUCT.id);
    expect(ensured.evaluationRunId).toBe('eval-real');
    expect(evaluations.createRun).not.toHaveBeenCalled();
    // The family query must not truncate before the exact filter runs.
    expect(prisma.pilotEvaluationRun.findMany).toHaveBeenCalledWith(
      expect.not.objectContaining({ take: expect.anything() }),
    );
    // ...and the report resolves the SAME run through the same lookup.
    const report = await service.report(TENANT, PRODUCT.id);
    expect(report.linkedEvaluationRun?.evaluationRunId).toBe('eval-real');
  });

  it('never adopts another product\'s structured-identity run, even with a matching name', async () => {
    const { service, evaluations } = buildHarness({
      evaluationRuns: [
        {
          id: 'eval-foreign',
          // Name collides (e.g. the SKU was renamed) but the structured
          // identity says this run bootstraps a DIFFERENT product.
          name: bootstrapRunName(PRODUCT.sku),
          status: 'OPEN',
          bootstrapProductId: 'prod-other',
          _count: { reviews: 5 },
        },
      ],
    });
    const ensured = await service.ensureEvaluationRun(TENANT, PRODUCT.id);
    expect(ensured.evaluationRunId).not.toBe('eval-foreign');
    expect(evaluations.createRun).toHaveBeenCalled();
  });
});

describe('OneSkuBootstrapService.report — full-set aggregation (Codex P2)', () => {
  it('derives stocked/totalOnHand from the FULL inventory aggregate, not the 50 displayed rows', async () => {
    // Display rows are empty (stock parked beyond the display window),
    // but the aggregate says 7 units exist somewhere.
    const { service, prisma } = buildHarness({ levels: [], totalOnHand: 7 });
    const report = await service.report(TENANT, PRODUCT.id, {
      hasInventoryReadPermission: true,
    });
    expect(report.inventory.stocked).toBe(true);
    expect(report.inventory.totalOnHand).toBe(7);
    const gate = report.gates.items.find(
      (item) => item.key === 'INVENTORY_STOCKED',
    );
    expect(gate?.satisfied).toBe(true);
    expect(gate?.detail).toBe('7 on hand across stores');
    // The display query stays bounded — only the aggregate is unlimited.
    expect(prisma.inventoryLevel.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 50 }),
    );
    expect(prisma.inventoryLevel.aggregate).toHaveBeenCalledWith({
      where: { tenantId: TENANT, productId: PRODUCT.id },
      _sum: { quantity: true },
    });
  });

  it('keeps the full-aggregate total redacted for a caller without inventory access', async () => {
    const { service } = buildHarness({ levels: [], totalOnHand: 7 });
    const report = await service.report(TENANT, PRODUCT.id);
    // Classification still true, exact number still hidden.
    expect(report.inventory.stocked).toBe(true);
    expect(report.inventory.totalOnHand).toBeNull();
    expect(report.inventory.levels).toEqual([]);
  });

  it('computes counts and gates across ALL clips while displaying only the newest 100', async () => {
    // 100 newest reviewed pickups + 1 OLDER unreviewed clip that falls
    // outside the display window: ALL_REVIEWED must still fail, and the
    // reviewed count must cover the full set.
    const reviewedTruths = Array.from({ length: 100 }, (_, i) =>
      truthRow({ videoAssetId: `va-r${i}` }),
    );
    const oldUnreviewed = truthRow({ videoAssetId: 'va-old-unreviewed' });
    const { service } = buildHarness({
      evaluationRun: LINKED_RUN,
      truths: [...reviewedTruths, oldUnreviewed],
      runs: [
        ...reviewedTruths.map((_, i) =>
          fusionRun({ id: `fusion-r${i}`, videoAssetId: `va-r${i}` }),
        ),
        fusionRun({ id: 'fusion-old', videoAssetId: 'va-old-unreviewed' }),
      ],
      importedEvents: reviewedTruths.map((_, i) =>
        importedEvent({
          id: `jevt-r${i}`,
          videoAssetId: `va-r${i}`,
          fusionRunId: `fusion-r${i}`,
        }),
      ),
      pilotReviews: reviewedTruths.map((_, i) =>
        pilotReview({ journeyEventId: `jevt-r${i}` }),
      ),
    });
    const report = await service.report(TENANT, PRODUCT.id);
    // Display bounded, readiness complete.
    expect(report.videos).toHaveLength(100);
    expect(
      report.videos.some((row) => row.videoAssetId === 'va-old-unreviewed'),
    ).toBe(false);
    expect(report.counts.totalClips).toBe(101);
    expect(report.counts.reviewedPickupExamples).toBe(100);
    expect(report.counts.unreviewedClips).toBe(1);
    const allReviewed = report.gates.items.find(
      (item) => item.key === 'ALL_REVIEWED',
    );
    expect(allReviewed?.satisfied).toBe(false);
    expect(allReviewed?.detail).toBe('1 awaiting review');
  });

  it('does not let recent tenant-wide negatives displace this SKU\'s positive examples', async () => {
    // 100 newest NONE clips push the SKU's only reviewed pickup past the
    // display window — the pickup must still count toward readiness.
    const negatives = Array.from({ length: 100 }, (_, i) =>
      truthRow({
        videoAssetId: `va-none${i}`,
        eventKind: 'NONE',
        product: null,
      }),
    );
    const { service } = buildHarness({
      evaluationRun: LINKED_RUN,
      truths: [...negatives, truthRow({ videoAssetId: 'va-pos' })],
      runs: [fusionRun({ videoAssetId: 'va-pos' })],
      importedEvents: [importedEvent({ videoAssetId: 'va-pos' })],
      pilotReviews: [pilotReview()],
    });
    const report = await service.report(TENANT, PRODUCT.id);
    expect(report.videos).toHaveLength(100);
    expect(report.videos.some((row) => row.videoAssetId === 'va-pos')).toBe(
      false,
    );
    // The displaced positive still counts for readiness.
    expect(report.counts.reviewedPickupExamples).toBe(1);
    expect(report.counts.totalClips).toBe(101);
  });

  it('never limits the ground-truth readiness query', async () => {
    const { service, prisma } = buildHarness({ truths: [truthRow()] });
    await service.report(TENANT, PRODUCT.id);
    expect(prisma.videoGroundTruth.findMany).toHaveBeenCalledWith(
      expect.not.objectContaining({ take: expect.anything() }),
    );
  });
});
