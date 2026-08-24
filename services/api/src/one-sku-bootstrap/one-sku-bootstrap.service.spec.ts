import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { JourneyService } from '../journey/journey.service';
import { PilotEvaluationService } from '../pilot-evaluation/pilot-evaluation.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  OneSkuBootstrapService,
  bootstrapRunName,
} from './one-sku-bootstrap.service';

const TENANT = 'tenant-1';
const OTHER_TENANT = 'tenant-2';
const PRODUCT = {
  id: 'prod-1',
  sku: 'SKU-LIME-GREEN',
  name: 'Lime Green Can',
  status: 'ACTIVE',
};

type Row = Record<string, unknown>;

function asset(over: Row = {}): Row {
  return {
    originalFilename: 'clip.mp4',
    status: 'READY',
    durationMs: 8000,
    width: 1920,
    height: 1080,
    sessionId: null,
    deletedAt: null,
    ...over,
  };
}

function evidence(over: Row = {}): Row {
  return {
    detector: { yoloReady: false },
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
  videoAsset?: Row | null;
  journeyEvents?: Row[];
  /** FUSION_SHADOW journey events per asset for the report's bootstrap-
   *  review lookup: [{id, videoAssetId}]. */
  importedEvents?: Row[];
  pilotReviews?: Row[];
}

function buildHarness(data: HarnessData) {
  const journeyEventQueue = [...(data.journeyEvents ?? [])];
  const prisma = {
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
    },
    pilotEvaluationRun: {
      findFirst: jest.fn(async () => data.evaluationRun ?? null),
    },
    pilotObservationReview: {
      findMany: jest.fn(async () => data.pilotReviews ?? []),
    },
    videoGroundTruth: {
      findMany: jest.fn(async () => data.truths ?? []),
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
    },
    videoAsset: {
      findFirst: jest.fn(async () => data.videoAsset ?? null),
    },
    customerJourneyEvent: {
      // First call returns the first queued row (or null), the next call
      // the next row — models "not imported yet, then imported".
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
  const service = new OneSkuBootstrapService(
    prisma as unknown as PrismaService,
    evaluations as unknown as PilotEvaluationService,
    journeys as unknown as JourneyService,
  );
  return { prisma, evaluations, journeys, service };
}

describe('OneSkuBootstrapService.report', () => {
  it('404s for a product outside the tenant', async () => {
    const { service } = buildHarness({});
    await expect(service.report(OTHER_TENANT, PRODUCT.id)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('scopes every query to the tenant', async () => {
    const { prisma, service } = buildHarness({
      truths: [
        {
          videoAssetId: 'va-1',
          eventKind: 'PICKUP',
          testType: null,
          quantity: 1,
          actualTimestampMs: 1000,
          product: { sku: PRODUCT.sku },
          videoAsset: asset(),
        },
      ],
    });
    await service.report(TENANT, PRODUCT.id);
    expect(prisma.product.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: PRODUCT.id, tenantId: TENANT },
      }),
    );
    for (const delegate of [
      prisma.productReferenceImage.count,
      prisma.productReferenceEmbedding.count,
      prisma.inventoryLevel.findMany,
      prisma.pilotEvaluationRun.findFirst,
      prisma.videoGroundTruth.findMany,
      prisma.pickupFusionRun.findMany,
      prisma.inferenceJob.findMany,
      prisma.videoArtifact.findMany,
    ]) {
      expect(delegate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ tenantId: TENANT }),
        }),
      );
    }
    // False-touch clips (NONE) ride along without a product binding.
    expect(prisma.videoGroundTruth.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ productId: PRODUCT.id }, { eventKind: 'NONE' }],
        }),
      }),
    );
  });

  it('counts reviewed examples per action and flags unreviewed clips', async () => {
    const { service } = buildHarness({
      referenceCount: 9,
      embeddingCount: 9,
      levels: [
        {
          locationId: 'loc-1',
          quantity: 6,
          location: { name: 'Pilot store', code: 'PS1' },
        },
      ],
      truths: [
        {
          // Reviewed pickup: fusion run + reviewed vision event.
          videoAssetId: 'va-1',
          eventKind: 'PICKUP',
          testType: 'PICKUP_SINGLE',
          quantity: 2,
          actualTimestampMs: 1500,
          product: { sku: PRODUCT.sku },
          videoAsset: asset(),
        },
        {
          // Unreviewed pickup: fusion run but the event is still pending.
          videoAssetId: 'va-2',
          eventKind: 'PICKUP',
          testType: null,
          quantity: 1,
          actualTimestampMs: 2000,
          product: { sku: PRODUCT.sku },
          videoAsset: asset(),
        },
        {
          // Reviewed false touch: succeeded detection, no event produced —
          // the operator's NONE label is the record.
          videoAssetId: 'va-3',
          eventKind: 'NONE',
          testType: 'FALSE_TOUCH',
          quantity: 1,
          actualTimestampMs: null,
          product: null,
          videoAsset: asset(),
        },
      ],
      runs: [
        {
          videoAssetId: 'va-1',
          createdAt: new Date('2026-08-24T10:00:00Z'),
          policy: 'AUTO_PROPOSE',
          evidence: evidence(),
        },
        {
          videoAssetId: 'va-2',
          createdAt: new Date('2026-08-24T09:00:00Z'),
          policy: 'NEEDS_VLM',
          evidence: evidence({
            fused: [{ sku: 'WATER-BOTTLE-500ML', fusedScore: 0.4 }],
          }),
        },
      ],
      jobs: [
        {
          sourceId: 'pickup:va-1',
          status: 'SUCCEEDED',
          visionEventId: 'ev-1',
        },
        {
          sourceId: 'pickup:va-2',
          status: 'SUCCEEDED',
          visionEventId: 'ev-2',
        },
        { sourceId: 'pickup:va-3', status: 'SUCCEEDED', visionEventId: null },
      ],
      events: [
        {
          id: 'ev-1',
          status: 'APPROVED',
          review: { decision: 'APPROVE' },
        },
        { id: 'ev-2', status: 'PENDING_REVIEW', review: null },
      ],
    });
    const report = await service.report(TENANT, PRODUCT.id);

    expect(report.counts).toEqual({
      totalClips: 3,
      reviewedPickupExamples: 1,
      reviewedReturnExamples: 0,
      reviewedFalseTouchExamples: 1,
      unreviewedClips: 1,
    });

    const [reviewedRow, pendingRow, falseTouchRow] = report.videos;
    expect(reviewedRow.reviewed).toBe(true);
    expect(reviewedRow.missedPositiveEvent).toBe(false);
    expect(reviewedRow.expectedBasketDelta).toBe(2);
    expect(reviewedRow.predictionMatchesExpected).toBe(true);
    expect(pendingRow.reviewed).toBe(false);
    expect(pendingRow.needsReview).toBe(true);
    expect(pendingRow.predictionMatchesExpected).toBe(false);
    expect(falseTouchRow.reviewed).toBe(true);
    expect(falseTouchRow.expectedBasketDelta).toBe(0);
    expect(falseTouchRow.expectedSku).toBeNull();

    expect(report.references.inferenceReady).toBe(true);
    expect(report.references.embeddingsBuilt).toBe(true);
    expect(report.inventory.stocked).toBe(true);
    expect(report.latest?.predictedSku).toBe(PRODUCT.sku);
    // Reviewed examples still short of 5 pickups / 2 returns, and no
    // evaluation run is linked yet.
    expect(report.gates.readyForDatasetImprovement).toBe(false);
  });

  it('never counts a missed PICKUP/RETURN as reviewed (Codex P1)', async () => {
    const { service } = buildHarness({
      truths: [
        {
          // Succeeded analysis, NO vision event: a MISSED positive.
          videoAssetId: 'va-4',
          eventKind: 'PICKUP',
          testType: null,
          quantity: 1,
          actualTimestampMs: 900,
          product: { sku: PRODUCT.sku },
          videoAsset: asset(),
        },
        {
          videoAssetId: 'va-5',
          eventKind: 'RETURN',
          testType: null,
          quantity: 1,
          actualTimestampMs: 900,
          product: { sku: PRODUCT.sku },
          videoAsset: asset(),
        },
      ],
      jobs: [
        { sourceId: 'pickup:va-4', status: 'SUCCEEDED', visionEventId: null },
        { sourceId: 'pickup:va-5', status: 'SUCCEEDED', visionEventId: null },
      ],
    });
    const report = await service.report(TENANT, PRODUCT.id);
    for (const row of report.videos) {
      expect(row.reviewed).toBe(false);
      expect(row.missedPositiveEvent).toBe(true);
      expect(row.needsReview).toBe(true);
    }
    expect(report.counts.reviewedPickupExamples).toBe(0);
    expect(report.counts.reviewedReturnExamples).toBe(0);
    expect(report.counts.unreviewedClips).toBe(2);
    expect(
      report.failureReasons.find((r) => r.reason === 'MISSED_POSITIVE_EVENT')
        ?.count,
    ).toBe(2);
    expect(report.gates.readyForDatasetImprovement).toBe(false);
  });

  it('marks a clip reviewed via a bootstrap pilot review (record-only path)', async () => {
    const { service } = buildHarness({
      truths: [
        {
          videoAssetId: 'va-1',
          eventKind: 'PICKUP',
          testType: null,
          quantity: 1,
          actualTimestampMs: 900,
          product: { sku: PRODUCT.sku },
          videoAsset: asset(),
        },
      ],
      runs: [
        {
          videoAssetId: 'va-1',
          createdAt: new Date('2026-08-24T10:00:00Z'),
          policy: 'NEEDS_VLM',
          evidence: evidence(),
        },
      ],
      // Vision event exists but is UNREVIEWED — the basket-affecting
      // review path was never used.
      jobs: [
        { sourceId: 'pickup:va-1', status: 'SUCCEEDED', visionEventId: 'ev-1' },
      ],
      events: [{ id: 'ev-1', status: 'PENDING_REVIEW', review: null }],
      importedEvents: [{ id: 'jevt-1', videoAssetId: 'va-1' }],
      pilotReviews: [
        {
          journeyEventId: 'jevt-1',
          verdict: 'WRONG_SKU',
          createdAt: new Date('2026-08-24T11:00:00Z'),
        },
      ],
    });
    const report = await service.report(TENANT, PRODUCT.id);
    expect(report.videos[0].reviewed).toBe(true);
    expect(report.videos[0].bootstrapReviewVerdict).toBe('WRONG_SKU');
    expect(report.counts.reviewedPickupExamples).toBe(1);
  });

  it('selects the latest fusion evidence by run timestamp, not ground-truth order', async () => {
    const { service } = buildHarness({
      truths: [
        {
          // FIRST in ground-truth order (edited most recently) but its
          // fusion run is OLDER.
          videoAssetId: 'va-old-run',
          eventKind: 'PICKUP',
          testType: null,
          quantity: 1,
          actualTimestampMs: 900,
          product: { sku: PRODUCT.sku },
          videoAsset: asset(),
        },
        {
          videoAssetId: 'va-new-run',
          eventKind: 'PICKUP',
          testType: null,
          quantity: 1,
          actualTimestampMs: 900,
          product: { sku: PRODUCT.sku },
          videoAsset: asset(),
        },
      ],
      runs: [
        {
          videoAssetId: 'va-new-run',
          createdAt: new Date('2026-08-24T12:00:00Z'),
          policy: 'AUTO_PROPOSE',
          evidence: evidence({ fused: [{ sku: 'SKU-NEWEST', fusedScore: 0.9 }] }),
        },
        {
          videoAssetId: 'va-old-run',
          createdAt: new Date('2026-08-24T08:00:00Z'),
          policy: 'NEEDS_VLM',
          evidence: evidence({ fused: [{ sku: 'SKU-STALE', fusedScore: 0.2 }] }),
        },
      ],
    });
    const report = await service.report(TENANT, PRODUCT.id);
    expect(report.latest?.predictedSku).toBe('SKU-NEWEST');
    expect(report.latest?.policy).toBe('AUTO_PROPOSE');
  });

  it('lets a newer operator crop supersede the automatic crop evidence', async () => {
    const { service } = buildHarness({
      truths: [
        {
          videoAssetId: 'va-1',
          eventKind: 'PICKUP',
          testType: null,
          quantity: 1,
          actualTimestampMs: 1500,
          product: { sku: PRODUCT.sku },
          videoAsset: asset(),
        },
      ],
      runs: [
        {
          videoAssetId: 'va-1',
          createdAt: new Date('2026-08-24T10:00:00Z'),
          policy: 'NEEDS_VLM',
          evidence: evidence({
            crops: [
              {
                phase: 'peak',
                timestampMs: 1500,
                box: { x: 10, y: 10, width: 60, height: 60 },
                // The bad auto crop: blurry, heavily occluded.
                quality: { sharpness: 1.2, occlusion: 0.55, brightness: 90 },
                selected: true,
              },
            ],
          }),
        },
      ],
      operatorCrops: [
        {
          id: 'artifact-manual-1',
          videoAssetId: 'va-1',
          timestampMs: 2100,
          cropX: 600,
          cropY: 300,
          cropWidth: 500,
          cropHeight: 600,
          createdAt: new Date('2026-08-24T11:00:00Z'),
        },
      ],
    });
    const report = await service.report(TENANT, PRODUCT.id);
    const fusion = report.videos[0].fusion;
    expect(fusion?.cropSource).toBe('OPERATOR');
    expect(fusion?.cropArtifactId).toBe('artifact-manual-1');
    expect(fusion?.selectedCrop?.box).toEqual({
      x: 600,
      y: 300,
      width: 500,
      height: 600,
    });
    // The auto crop's HIGH_OCCLUSION/LOW_SHARPNESS warnings are replaced
    // by the operator crop's (clean) geometric assessment.
    expect(fusion?.cropWarnings).toEqual([]);
    const cleanCropGate = report.gates.items.find(
      (item) => item.key === 'CLEAN_CROP',
    );
    expect(cleanCropGate?.satisfied).toBe(true);
  });

  it('ignores an operator crop that is OLDER than the latest fusion run', async () => {
    const { service } = buildHarness({
      truths: [
        {
          videoAssetId: 'va-1',
          eventKind: 'PICKUP',
          testType: null,
          quantity: 1,
          actualTimestampMs: 1500,
          product: { sku: PRODUCT.sku },
          videoAsset: asset(),
        },
      ],
      runs: [
        {
          videoAssetId: 'va-1',
          createdAt: new Date('2026-08-24T12:00:00Z'),
          policy: 'AUTO_PROPOSE',
          evidence: evidence(),
        },
      ],
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

  it('flags session-bound clips so the UI excludes them from corrections', async () => {
    const { service } = buildHarness({
      truths: [
        {
          videoAssetId: 'va-1',
          eventKind: 'PICKUP',
          testType: null,
          quantity: 1,
          actualTimestampMs: 900,
          product: { sku: PRODUCT.sku },
          videoAsset: asset({ sessionId: 'session-1' }),
        },
      ],
    });
    const report = await service.report(TENANT, PRODUCT.id);
    expect(report.videos[0].sessionBound).toBe(true);
  });

  it('surfaces the linked bootstrap evaluation run and its review count', async () => {
    const { service } = buildHarness({
      evaluationRun: {
        id: 'eval-1',
        name: bootstrapRunName(PRODUCT.sku),
        status: 'OPEN',
        _count: { reviews: 4 },
      },
    });
    const report = await service.report(TENANT, PRODUCT.id);
    expect(report.linkedEvaluationRun).toEqual({
      evaluationRunId: 'eval-1',
      name: bootstrapRunName(PRODUCT.sku),
      status: 'OPEN',
      reviewCount: 4,
    });
    const gate = report.gates.items.find(
      (item) => item.key === 'EVALUATION_RUN_LINKED',
    );
    expect(gate?.satisfied).toBe(true);
  });

  it('never leaks raw evidence text, storage keys, or paths in the response', async () => {
    const { service } = buildHarness({
      truths: [
        {
          videoAssetId: 'va-1',
          eventKind: 'PICKUP',
          testType: null,
          quantity: 1,
          actualTimestampMs: 900,
          product: { sku: PRODUCT.sku },
          videoAsset: asset(),
        },
      ],
      runs: [
        {
          videoAssetId: 'va-1',
          createdAt: new Date(),
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
        },
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
    expect(
      report.failureReasons.find((r) => r.reason === 'MISSING_REFERENCES'),
    ).toBeDefined();
    expect(report.scoreNote).toContain('no accuracy claim');
  });
});

describe('OneSkuBootstrapService.ensureEvaluationRun', () => {
  it('returns the existing run without creating a duplicate', async () => {
    const { service, evaluations } = buildHarness({
      evaluationRun: {
        id: 'eval-1',
        name: bootstrapRunName(PRODUCT.sku),
        status: 'OPEN',
        _count: { reviews: 0 },
      },
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
    expect(result.evaluationRunId).toBe('eval-1');
    expect(evaluations.createRun).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ name: bootstrapRunName(PRODUCT.sku) }),
      'user-1',
    );
  });
});

describe('OneSkuBootstrapService.reviewClip', () => {
  const reviewInput = {
    verdict: 'WRONG_SKU' as never,
    expectedAction: 'PICKUP' as never,
    expectedProductId: PRODUCT.id,
    notes: null,
  };

  it('refuses session-bound clips outright (basket safety)', async () => {
    const { service, evaluations, journeys } = buildHarness({
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

  it('requires a fusion run before a correction can be recorded', async () => {
    const { service } = buildHarness({
      videoAsset: { id: 'va-1', locationId: 'loc-1', unitId: null, sessionId: null },
      runs: [],
    });
    await expect(
      service.reviewClip(TENANT, PRODUCT.id, 'va-1', reviewInput),
    ).rejects.toThrow(ConflictException);
  });

  it('imports the fusion run as a shadow journey event and appends a pilot review', async () => {
    const { service, evaluations, journeys, prisma } = buildHarness({
      videoAsset: { id: 'va-1', locationId: 'loc-1', unitId: 'unit-1', sessionId: null },
      runs: [{ id: 'fusion-1' }],
      evaluationRun: {
        id: 'eval-1',
        name: bootstrapRunName(PRODUCT.sku),
        status: 'OPEN',
        _count: { reviews: 0 },
      },
      // First lookup: not imported yet; second (after import): the event.
      journeyEvents: [null as never, { id: 'event-1' }],
    });
    // The queue helper shifts; replace the first null properly:
    prisma.customerJourneyEvent.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'event-1' });

    const result = await service.reviewClip(
      TENANT,
      PRODUCT.id,
      'va-1',
      reviewInput,
      'user-1',
    );
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
        expectedAction: 'PICKUP',
        journeyEventId: 'event-1',
        expectedProductId: PRODUCT.id,
      }),
      'user-1',
    );
    expect(result).toEqual({
      evaluationRunId: 'eval-1',
      journeyEventId: 'event-1',
      reviewId: 'review-1',
      verdict: 'WRONG_SKU',
    });
  });

  it('reuses an already-imported journey event without opening a new journey', async () => {
    const { service, journeys, prisma } = buildHarness({
      videoAsset: { id: 'va-1', locationId: 'loc-1', unitId: null, sessionId: null },
      runs: [{ id: 'fusion-1' }],
      evaluationRun: {
        id: 'eval-1',
        name: bootstrapRunName(PRODUCT.sku),
        status: 'OPEN',
        _count: { reviews: 1 },
      },
    });
    prisma.customerJourneyEvent.findFirst.mockResolvedValueOnce({
      id: 'event-existing',
    });
    const result = await service.reviewClip(
      TENANT,
      PRODUCT.id,
      'va-1',
      reviewInput,
    );
    expect(journeys.create).not.toHaveBeenCalled();
    expect(journeys.appendFromFusionRun).not.toHaveBeenCalled();
    expect(result.journeyEventId).toBe('event-existing');
  });
});
