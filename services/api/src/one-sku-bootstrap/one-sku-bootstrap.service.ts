import { Injectable, NotFoundException } from '@nestjs/common';
import {
  FusionRunScope,
  GroundTruthEventKind,
  InferenceJobStatus,
} from '@prisma/client';
import { pickupSourceId } from '../pickup-detection/pickup-detection.service';
import { PICKUP_MIN_REFERENCE_IMAGES } from '../pickup-detection/reference-images.service';
import { EMBEDDING_MODEL_KEY, EMBEDDING_MODEL_VERSION } from '../pickup-fusion/primitives';
import { PrismaService } from '../prisma/prisma.service';
import {
  BOOTSTRAP_MAX_CLIPS,
  BootstrapFailureReason,
  GateItem,
  RECOMMENDED_REFERENCE_IMAGES,
  SCORE_NOTE,
  SafeFusionSummary,
  analysisDimsFor,
  deriveFailureReasons,
  evaluateGates,
  safeFusionSummary,
} from './one-sku-bootstrap.report';

/**
 * One-SKU bootstrap — READ-ONLY aggregation guiding an operator through
 * proving out a single SKU (references → embeddings → inventory → clean
 * test clips → reviewed examples) before scaling to 5+ SKUs.
 *
 * This module writes NOTHING (pinned by shadow-mode.spec.ts): uploads,
 * reindexing, ground truth, detection/fusion runs, and corrections all
 * happen through their existing endpoints; this service only reports on
 * the rows those flows already produced.
 *
 * Response safety: only ids, SKUs, sanitized filenames, classified codes,
 * and numbers leave this service — never storage keys, OCR/barcode text,
 * or provider error text (see safeFusionSummary's allowlist).
 */

export interface BootstrapVideoRow {
  videoAssetId: string;
  originalFilename: string;
  assetStatus: string;
  durationMs: number | null;
  eventKind: GroundTruthEventKind;
  testType: string | null;
  expectedSku: string | null;
  quantity: number;
  actualTimestampMs: number | null;
  /** Signed provisional-basket change the clip SHOULD produce
   *  (+quantity pickup, -quantity return, 0 false touch). Display only —
   *  no basket, order, or inventory row is ever written from CV. */
  expectedBasketDelta: number;
  reviewed: boolean;
  reviewDecision: string | null;
  visionEventStatus: string | null;
  needsReview: boolean;
  predictedSku: string | null;
  /** null until a fusion run exists for the clip. */
  predictionMatchesExpected: boolean | null;
  fusion: SafeFusionSummary | null;
}

export interface OneSkuBootstrapReport {
  product: { id: string; sku: string; name: string; status: string };
  references: {
    referenceCount: number;
    minRequired: number;
    recommended: number;
    inferenceReady: boolean;
    embeddingCount: number;
    embeddingModelKey: string;
    embeddingModelVersion: string;
    embeddingsBuilt: boolean;
  };
  inventory: {
    stocked: boolean;
    totalOnHand: number;
    levels: {
      locationId: string;
      locationName: string;
      locationCode: string;
      quantity: number;
    }[];
  };
  videos: BootstrapVideoRow[];
  counts: {
    totalClips: number;
    reviewedPickupExamples: number;
    reviewedReturnExamples: number;
    /** NONE ground truth carries no SKU, so false-touch examples are
     *  counted tenant-wide by design. */
    reviewedFalseTouchExamples: number;
    unreviewedClips: number;
  };
  latest: {
    predictedSku: string | null;
    topScore: number | null;
    policy: string;
    vlmVerdict: string | null;
    vlmStatus: string | null;
    runCreatedAt: Date;
  } | null;
  failureReasons: { reason: BootstrapFailureReason; count: number }[];
  gates: { items: GateItem[]; readyForDatasetImprovement: boolean };
  scoreNote: string;
}

@Injectable()
export class OneSkuBootstrapService {
  constructor(private readonly prisma: PrismaService) {}

  async report(
    tenantId: string,
    productId: string,
  ): Promise<OneSkuBootstrapReport> {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, tenantId },
      select: { id: true, sku: true, name: true, status: true },
    });
    if (!product) {
      throw new NotFoundException('product not found');
    }

    const [referenceCount, embeddingCount, levels] = await Promise.all([
      this.prisma.productReferenceImage.count({
        where: { tenantId, productId },
      }),
      this.prisma.productReferenceEmbedding.count({
        where: { tenantId, productId, modelKey: EMBEDDING_MODEL_KEY },
      }),
      this.prisma.inventoryLevel.findMany({
        where: { tenantId, productId },
        select: {
          locationId: true,
          quantity: true,
          location: { select: { name: true, code: true } },
        },
        take: 50,
      }),
    ]);

    // This SKU's PICKUP/RETURN clips plus every NONE (false-touch) clip:
    // NONE ground truth force-nulls productId, so negatives are shared.
    const truths = await this.prisma.videoGroundTruth.findMany({
      where: {
        tenantId,
        OR: [{ productId }, { eventKind: GroundTruthEventKind.NONE }],
        videoAsset: { deletedAt: null },
      },
      include: {
        product: { select: { sku: true } },
        videoAsset: {
          select: {
            originalFilename: true,
            status: true,
            durationMs: true,
            width: true,
            height: true,
            deletedAt: true,
          },
        },
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: BOOTSTRAP_MAX_CLIPS,
    });
    const liveTruths = truths.filter(
      (truth) => truth.videoAsset.deletedAt === null,
    );
    const assetIds = liveTruths.map((truth) => truth.videoAssetId);

    const [runs, jobs] = await Promise.all([
      assetIds.length === 0
        ? Promise.resolve([])
        : this.prisma.pickupFusionRun.findMany({
            // WHOLE_CLIP only — same rule as cv-evaluation: replay-window
            // runs of the same video must not displace whole-clip results.
            where: {
              tenantId,
              videoAssetId: { in: assetIds },
              runScope: FusionRunScope.WHOLE_CLIP,
            },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            select: {
              videoAssetId: true,
              createdAt: true,
              policy: true,
              evidence: true,
            },
          }),
      assetIds.length === 0
        ? Promise.resolve([])
        : this.prisma.inferenceJob.findMany({
            where: {
              tenantId,
              sourceId: { in: assetIds.map((id) => pickupSourceId(id)) },
            },
            orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
            select: {
              sourceId: true,
              status: true,
              visionEventId: true,
            },
          }),
    ]);

    const latestRunByAsset = new Map<string, (typeof runs)[number]>();
    for (const run of runs) {
      if (run.videoAssetId !== null && !latestRunByAsset.has(run.videoAssetId)) {
        latestRunByAsset.set(run.videoAssetId, run);
      }
    }
    const latestJobBySource = new Map<string, (typeof jobs)[number]>();
    for (const job of jobs) {
      if (job.sourceId !== null && !latestJobBySource.has(job.sourceId)) {
        latestJobBySource.set(job.sourceId, job);
      }
    }

    const visionEventIds = [...latestJobBySource.values()]
      .map((job) => job.visionEventId)
      .filter((id): id is string => id !== null);
    const events =
      visionEventIds.length === 0
        ? []
        : await this.prisma.visionEvent.findMany({
            where: { tenantId, id: { in: visionEventIds } },
            select: {
              id: true,
              status: true,
              review: { select: { decision: true } },
            },
          });
    const eventById = new Map(events.map((event) => [event.id, event]));

    const videos: BootstrapVideoRow[] = liveTruths.map((truth) => {
      const run = latestRunByAsset.get(truth.videoAssetId);
      const job = latestJobBySource.get(pickupSourceId(truth.videoAssetId));
      const event = job?.visionEventId
        ? eventById.get(job.visionEventId)
        : undefined;
      const expectedSku = truth.product?.sku ?? null;
      const fusion = run
        ? safeFusionSummary(
            run,
            expectedSku,
            analysisDimsFor({
              width: truth.videoAsset.width,
              height: truth.videoAsset.height,
            }),
          )
        : null;

      // Reviewed = the clip has been ANALYZED (fusion run or a succeeded
      // detection attempt) and any produced vision event was human-
      // reviewed. A clip whose analysis produced no event (e.g. a labeled
      // false touch where nothing was detected) has nothing left to
      // review — the operator's ground-truth label IS the record.
      const hasAnalysis =
        run !== undefined || job?.status === InferenceJobStatus.SUCCEEDED;
      const reviewed =
        hasAnalysis && (event === undefined || event.review !== null);

      const isNone = truth.eventKind === GroundTruthEventKind.NONE;
      const predictionMatchesExpected =
        fusion === null
          ? null
          : isNone
            ? fusion.policy !== 'AUTO_PROPOSE'
            : fusion.topSku !== null && fusion.topSku === expectedSku;

      return {
        videoAssetId: truth.videoAssetId,
        originalFilename: truth.videoAsset.originalFilename,
        assetStatus: truth.videoAsset.status,
        durationMs: truth.videoAsset.durationMs,
        eventKind: truth.eventKind,
        testType: truth.testType,
        expectedSku,
        quantity: truth.quantity,
        actualTimestampMs: truth.actualTimestampMs,
        expectedBasketDelta:
          truth.eventKind === GroundTruthEventKind.PICKUP
            ? truth.quantity
            : truth.eventKind === GroundTruthEventKind.RETURN
              ? -truth.quantity
              : 0,
        reviewed,
        reviewDecision: event?.review?.decision ?? null,
        visionEventStatus: event?.status ?? null,
        needsReview:
          event?.status === 'PENDING_REVIEW' ||
          fusion?.vlmRequiresHumanReview === true,
        predictedSku: fusion?.topSku ?? null,
        predictionMatchesExpected,
        fusion,
      };
    });

    const reviewedPickupExamples = videos.filter(
      (row) =>
        row.eventKind === GroundTruthEventKind.PICKUP &&
        row.expectedSku === product.sku &&
        row.reviewed,
    ).length;
    const reviewedReturnExamples = videos.filter(
      (row) =>
        row.eventKind === GroundTruthEventKind.RETURN &&
        row.expectedSku === product.sku &&
        row.reviewed,
    ).length;
    const reviewedFalseTouchExamples = videos.filter(
      (row) => row.eventKind === GroundTruthEventKind.NONE && row.reviewed,
    ).length;
    const unreviewedClips = videos.filter((row) => !row.reviewed).length;

    const latestWithFusion = videos.find((row) => row.fusion !== null);
    const latestFusion = latestWithFusion?.fusion ?? null;

    const inferenceReady = referenceCount >= PICKUP_MIN_REFERENCE_IMAGES;
    const totalOnHand = levels.reduce((sum, level) => sum + level.quantity, 0);

    return {
      product: {
        id: product.id,
        sku: product.sku,
        name: product.name,
        status: product.status,
      },
      references: {
        referenceCount,
        minRequired: PICKUP_MIN_REFERENCE_IMAGES,
        recommended: RECOMMENDED_REFERENCE_IMAGES,
        inferenceReady,
        embeddingCount,
        embeddingModelKey: EMBEDDING_MODEL_KEY,
        embeddingModelVersion: EMBEDDING_MODEL_VERSION,
        embeddingsBuilt:
          referenceCount > 0 && embeddingCount >= referenceCount,
      },
      inventory: {
        stocked: totalOnHand > 0,
        totalOnHand,
        levels: levels.map((level) => ({
          locationId: level.locationId,
          locationName: level.location.name,
          locationCode: level.location.code,
          quantity: level.quantity,
        })),
      },
      videos,
      counts: {
        totalClips: videos.length,
        reviewedPickupExamples,
        reviewedReturnExamples,
        reviewedFalseTouchExamples,
        unreviewedClips,
      },
      latest: latestFusion
        ? {
            predictedSku: latestFusion.topSku,
            topScore: latestFusion.topScore,
            policy: latestFusion.policy,
            vlmVerdict: latestFusion.vlmVerdict,
            vlmStatus: latestFusion.vlmStatus,
            runCreatedAt: latestFusion.createdAt,
          }
        : null,
      failureReasons: deriveFailureReasons(videos, { inferenceReady }),
      gates: evaluateGates({
        referenceCount,
        minRequiredReferences: PICKUP_MIN_REFERENCE_IMAGES,
        embeddingCount,
        stockedQuantity: totalOnHand,
        latestFusion,
        reviewedPickupExamples,
        reviewedReturnExamples,
        reviewedFalseTouchExamples,
        unreviewedClips,
      }),
      scoreNote: SCORE_NOTE,
    };
  }
}
