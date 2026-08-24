import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OneSkuBootstrapService } from './one-sku-bootstrap.service';

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
    deletedAt: null,
    ...over,
  };
}

function evidence(over: Row = {}): Row {
  return {
    detector: { yoloReady: false },
    crops: [
      {
        phase: 'peak',
        timestampMs: 1500,
        box: { x: 30, y: 25, width: 50, height: 60 },
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
}

function buildHarness(data: HarnessData) {
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
    videoGroundTruth: {
      findMany: jest.fn(async () => data.truths ?? []),
    },
    pickupFusionRun: {
      findMany: jest.fn(async () => data.runs ?? []),
    },
    inferenceJob: {
      findMany: jest.fn(async () => data.jobs ?? []),
    },
    visionEvent: {
      findMany: jest.fn(async () => data.events ?? []),
    },
  };
  const service = new OneSkuBootstrapService(prisma as unknown as PrismaService);
  return { prisma, service };
}

describe('OneSkuBootstrapService.report', () => {
  it('404s for a product outside the tenant', async () => {
    const { service } = buildHarness({});
    // The double returns the product ONLY for TENANT — the same id under
    // another tenant must not resolve.
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
      prisma.videoGroundTruth.findMany,
      prisma.pickupFusionRun.findMany,
      prisma.inferenceJob.findMany,
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
    // Reviewed examples still short of 5 pickups / 2 returns.
    expect(report.gates.readyForDatasetImprovement).toBe(false);
  });

  it('marks a NONE clip as mismatched when fusion auto-proposes a product', async () => {
    const { service } = buildHarness({
      truths: [
        {
          videoAssetId: 'va-9',
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
          videoAssetId: 'va-9',
          createdAt: new Date(),
          policy: 'AUTO_PROPOSE',
          evidence: evidence(),
        },
      ],
    });
    const report = await service.report(TENANT, PRODUCT.id);
    expect(report.videos[0].predictionMatchesExpected).toBe(false);
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
    expect(report.references.inferenceReady).toBe(false);
    expect(report.inventory.stocked).toBe(false);
    expect(report.gates.readyForDatasetImprovement).toBe(false);
    expect(
      report.failureReasons.find((r) => r.reason === 'MISSING_REFERENCES'),
    ).toBeDefined();
    expect(report.scoreNote).toContain('no accuracy claim');
  });
});
