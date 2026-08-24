import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CustomerJourneyEventType,
  FusionRunScope,
  GroundTruthEventKind,
  InferenceJobStatus,
  PilotExpectedAction,
  PilotObservationVerdict,
} from '@prisma/client';
import { JourneyService } from '../journey/journey.service';
import { PilotEvaluationService } from '../pilot-evaluation/pilot-evaluation.service';
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
  applyOperatorCrop,
  deriveFailureReasons,
  evaluateGates,
  fusionFrameDimsFor,
  safeFusionSummary,
} from './one-sku-bootstrap.report';

/**
 * One-SKU bootstrap — guides an operator through proving out a single
 * SKU (references → embeddings → inventory → clean test clips → reviewed
 * examples) before scaling to 5+ SKUs.
 *
 * WRITE DISCIPLINE (pinned by shadow-mode.spec.ts): this module performs
 * NO raw Prisma write. The two mutating flows DELEGATE to the existing
 * shadow services and inherit their guarantees:
 * - PilotEvaluationService (append-only pilot reviews — the Phase 18
 *   candidate source), and
 * - JourneyService (shadow journeys/events only; its own guard pins that
 *   it never touches checkout, order, payment, or inventory tables).
 * Corrections NEVER go through the vision-event review endpoint, whose
 * APPROVE/OVERRIDE path can mutate checkout-session basket lines —
 * session-bound clips are flagged and excluded outright.
 *
 * Response safety: only ids, SKUs, sanitized filenames, classified codes,
 * and numbers leave this service — never storage keys, OCR/barcode text,
 * or provider error text (see safeFusionSummary's allowlist).
 */

/** Deterministic per-SKU evaluation-run name — the find-or-create key. */
export function bootstrapRunName(sku: string): string {
  return `One SKU bootstrap — ${sku}`;
}

/** Verdicts a bootstrap correction may record. MISSED_EVENT is excluded
 *  (it requires an attached live session, which video clips never have);
 *  missed positives stay visible in this report until corrected. */
export const BOOTSTRAP_REVIEW_VERDICTS = [
  PilotObservationVerdict.CORRECT,
  PilotObservationVerdict.WRONG_SKU,
  PilotObservationVerdict.WRONG_ACTION,
  PilotObservationVerdict.FALSE_TOUCH,
  PilotObservationVerdict.UNCERTAIN,
] as const;

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
  /** Bound to a checkout session: EXCLUDED from bootstrap corrections
   *  (the vision-event review path could mutate basket lines). */
  sessionBound: boolean;
  /** PICKUP/RETURN ground truth whose succeeded analysis produced NO
   *  event — needs a human missed-event correction, never auto-reviewed. */
  missedPositiveEvent: boolean;
  reviewed: boolean;
  reviewDecision: string | null;
  /** Latest bootstrap pilot-review verdict on this clip's imported
   *  journey event (the record-only correction path), if any. */
  bootstrapReviewVerdict: string | null;
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
  /** The Phase 18 candidate source this bootstrap feeds. */
  linkedEvaluationRun: {
    evaluationRunId: string;
    name: string;
    status: string;
    reviewCount: number;
  } | null;
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly evaluations: PilotEvaluationService,
    private readonly journeys: JourneyService,
  ) {}

  private async requireProduct(tenantId: string, productId: string) {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, tenantId },
      select: { id: true, sku: true, name: true, status: true },
    });
    if (!product) {
      throw new NotFoundException('product not found');
    }
    return product;
  }

  /** Find-or-create the per-SKU bootstrap evaluation run (Phase 15) —
   *  the ONLY source Phase 18 candidate refresh can read reviews from. */
  async ensureEvaluationRun(
    tenantId: string,
    productId: string,
    actorId?: string,
  ): Promise<{
    evaluationRunId: string;
    name: string;
    status: string;
    created: boolean;
  }> {
    const product = await this.requireProduct(tenantId, productId);
    const name = bootstrapRunName(product.sku);
    const existing = await this.prisma.pilotEvaluationRun.findFirst({
      where: { tenantId, name },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, name: true, status: true },
    });
    if (existing) {
      return {
        evaluationRunId: existing.id,
        name: existing.name,
        status: existing.status,
        created: false,
      };
    }
    const created = await this.evaluations.createRun(
      tenantId,
      {
        name,
        description:
          `Auto-created by the one-SKU bootstrap workflow for ${product.sku}. ` +
          'Holds reviewed/corrected bootstrap clip evidence for Phase 18 ' +
          'dataset improvement.',
      },
      actorId,
    );
    return {
      evaluationRunId: created.evaluationRunId,
      name: created.name,
      status: created.status,
      created: true,
    };
  }

  /**
   * Record ONE bootstrap correction as Phase 18-compatible evidence:
   * import the clip's latest whole-clip fusion run as a FUSION_SHADOW
   * journey event (JourneyService — shadow tables only) and append a
   * pilot review against it (PilotEvaluationService — append-only).
   * This path can NEVER touch a checkout basket: session-bound clips
   * are refused outright, and neither delegated service writes checkout,
   * order, payment, or inventory rows.
   */
  async reviewClip(
    tenantId: string,
    productId: string,
    videoAssetId: string,
    input: {
      verdict: PilotObservationVerdict;
      expectedAction: PilotExpectedAction;
      expectedProductId?: string | null;
      notes?: string | null;
    },
    actorId?: string,
  ): Promise<{
    evaluationRunId: string;
    journeyEventId: string;
    reviewId: string;
    verdict: PilotObservationVerdict;
  }> {
    if (
      !(BOOTSTRAP_REVIEW_VERDICTS as readonly PilotObservationVerdict[]).includes(
        input.verdict,
      )
    ) {
      throw new BadRequestException(
        'bootstrap corrections accept CORRECT, WRONG_SKU, WRONG_ACTION, ' +
          'FALSE_TOUCH, or UNCERTAIN',
      );
    }
    await this.requireProduct(tenantId, productId);
    const asset = await this.prisma.videoAsset.findFirst({
      where: { tenantId, id: videoAssetId, deletedAt: null },
      select: { id: true, locationId: true, unitId: true, sessionId: true },
    });
    if (!asset) {
      throw new NotFoundException('video asset not found');
    }
    if (asset.sessionId !== null) {
      throw new ConflictException(
        'this clip is bound to a checkout session and is excluded from ' +
          'bootstrap corrections — record-only evidence must never reach ' +
          'a basket',
      );
    }
    if (!asset.locationId) {
      throw new BadRequestException(
        'the clip has no store context — re-upload it with a store so its ' +
          'shadow journey can be opened in the same store',
      );
    }
    const run = await this.prisma.pickupFusionRun.findFirst({
      where: {
        tenantId,
        videoAssetId,
        runScope: FusionRunScope.WHOLE_CLIP,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
    });
    if (!run) {
      throw new ConflictException(
        'run fusion on this clip first — the correction labels its fusion evidence',
      );
    }
    const evaluation = await this.ensureEvaluationRun(
      tenantId,
      productId,
      actorId,
    );

    const findImportedEvent = () =>
      this.prisma.customerJourneyEvent.findFirst({
        where: {
          tenantId,
          videoAssetId,
          fusionRunId: run.id,
          sourceType: 'FUSION_SHADOW',
          eventType: {
            in: [
              CustomerJourneyEventType.PRODUCT_PICKUP,
              CustomerJourneyEventType.PRODUCT_RETURN,
            ],
          },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true },
      });

    let event = await findImportedEvent();
    if (!event) {
      const journey = await this.journeys.create(
        tenantId,
        { locationId: asset.locationId, unitId: asset.unitId },
        actorId,
      );
      await this.journeys.appendFromFusionRun(
        tenantId,
        journey.id,
        videoAssetId,
        actorId,
        // Bootstrap imports label the pipeline's TOP candidate even when
        // the policy demoted the run to review — correcting exactly those
        // low-confidence clips is the point of the bootstrap.
        { fusionRunId: run.id, proposeBelowThreshold: true },
      );
      event = await findImportedEvent();
      if (!event) {
        throw new ConflictException(
          'fusion produced no candidate for this clip — there is nothing ' +
            'to label; improve references or recapture the clip',
        );
      }
    }

    const review = await this.evaluations.reviewObservation(
      tenantId,
      evaluation.evaluationRunId,
      {
        verdict: input.verdict,
        expectedAction: input.expectedAction,
        journeyEventId: event.id,
        expectedProductId: input.expectedProductId ?? null,
        notes: input.notes ?? null,
      },
      actorId,
    );
    return {
      evaluationRunId: evaluation.evaluationRunId,
      journeyEventId: event.id,
      reviewId: review.reviewId,
      verdict: review.verdict,
    };
  }

  async report(
    tenantId: string,
    productId: string,
  ): Promise<OneSkuBootstrapReport> {
    const product = await this.requireProduct(tenantId, productId);

    const [referenceCount, embeddingCount, levels, linkedRun] =
      await Promise.all([
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
        this.prisma.pilotEvaluationRun.findFirst({
          where: { tenantId, name: bootstrapRunName(product.sku) },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: {
            id: true,
            name: true,
            status: true,
            _count: { select: { reviews: true } },
          },
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
            sessionId: true,
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

    const [runs, jobs, operatorCrops] = await Promise.all([
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
      // Manual crops (Codex P1): an operator-created crop — createdById
      // is set ONLY on the HTTP path; every pipeline crop call site omits
      // the actor — supersedes the auto crop as this clip's evidence.
      assetIds.length === 0
        ? Promise.resolve([])
        : this.prisma.videoArtifact.findMany({
            where: {
              tenantId,
              videoAssetId: { in: assetIds },
              artifactType: 'CROP',
              createdById: { not: null },
            },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            select: {
              id: true,
              videoAssetId: true,
              timestampMs: true,
              cropX: true,
              cropY: true,
              cropWidth: true,
              cropHeight: true,
              createdAt: true,
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
    const latestOperatorCropByAsset = new Map<
      string,
      (typeof operatorCrops)[number]
    >();
    for (const crop of operatorCrops) {
      if (!latestOperatorCropByAsset.has(crop.videoAssetId)) {
        latestOperatorCropByAsset.set(crop.videoAssetId, crop);
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

    // Bootstrap pilot reviews (the record-only correction path): a pilot
    // review on a clip's imported FUSION_SHADOW journey event marks the
    // clip reviewed WITHOUT ever touching the vision-event/basket path.
    const journeyEvents =
      assetIds.length === 0
        ? []
        : await this.prisma.customerJourneyEvent.findMany({
            where: {
              tenantId,
              videoAssetId: { in: assetIds },
              sourceType: 'FUSION_SHADOW',
            },
            select: { id: true, videoAssetId: true },
          });
    const journeyEventIds = journeyEvents.map((event) => event.id);
    const pilotReviews =
      journeyEventIds.length === 0
        ? []
        : await this.prisma.pilotObservationReview.findMany({
            where: { tenantId, journeyEventId: { in: journeyEventIds } },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: { journeyEventId: true, verdict: true, createdAt: true },
          });
    const latestPilotReviewByEvent = new Map<
      string,
      (typeof pilotReviews)[number]
    >();
    for (const review of pilotReviews) {
      if (review.journeyEventId !== null) {
        // ascending order → the newest review wins.
        latestPilotReviewByEvent.set(review.journeyEventId, review);
      }
    }
    const latestPilotReviewByAsset = new Map<
      string,
      (typeof pilotReviews)[number]
    >();
    for (const event of journeyEvents) {
      if (event.videoAssetId === null) {
        continue;
      }
      const review = latestPilotReviewByEvent.get(event.id);
      if (!review) {
        continue;
      }
      const current = latestPilotReviewByAsset.get(event.videoAssetId);
      if (!current || review.createdAt > current.createdAt) {
        latestPilotReviewByAsset.set(event.videoAssetId, review);
      }
    }

    const videos: BootstrapVideoRow[] = liveTruths.map((truth) => {
      const run = latestRunByAsset.get(truth.videoAssetId);
      const job = latestJobBySource.get(pickupSourceId(truth.videoAssetId));
      const event = job?.visionEventId
        ? eventById.get(job.visionEventId)
        : undefined;
      const expectedSku = truth.product?.sku ?? null;
      const native =
        truth.videoAsset.width && truth.videoAsset.height
          ? {
              width: truth.videoAsset.width,
              height: truth.videoAsset.height,
            }
          : null;
      let fusion = run
        ? safeFusionSummary(run, expectedSku, fusionFrameDimsFor(native))
        : null;
      // A NEWER manual crop supersedes the automatic crop as evidence
      // (preview, warnings, CLEAN_CROP). Manual boxes are native-pixel.
      const operatorCrop = latestOperatorCropByAsset.get(truth.videoAssetId);
      if (
        fusion &&
        run &&
        operatorCrop &&
        operatorCrop.createdAt > run.createdAt &&
        operatorCrop.cropX !== null &&
        operatorCrop.cropY !== null &&
        operatorCrop.cropWidth !== null &&
        operatorCrop.cropHeight !== null
      ) {
        fusion = applyOperatorCrop(
          fusion,
          {
            artifactId: operatorCrop.id,
            timestampMs: operatorCrop.timestampMs,
            box: {
              x: operatorCrop.cropX,
              y: operatorCrop.cropY,
              width: operatorCrop.cropWidth,
              height: operatorCrop.cropHeight,
            },
            createdAt: operatorCrop.createdAt,
          },
          native,
        );
      }

      const isNone = truth.eventKind === GroundTruthEventKind.NONE;
      const pilotReview = latestPilotReviewByAsset.get(truth.videoAssetId);

      // Reviewed rules (Codex P1 — missed positives must not count):
      // - PICKUP/RETURN: a human record must exist — either a reviewed
      //   vision event (other pages) or a bootstrap PILOT review on the
      //   clip's imported journey event. A succeeded analysis that
      //   produced NO event and carries no correction is a MISSED
      //   POSITIVE — never auto-reviewed.
      // - NONE (false touch): analysis ran and either produced no event
      //   (the operator's NONE label IS the record), the produced event
      //   was human-reviewed, or a bootstrap review labeled it.
      const hasAnalysis =
        run !== undefined || job?.status === InferenceJobStatus.SUCCEEDED;
      const visionReviewed = event !== undefined && event.review !== null;
      const missedPositiveEvent =
        !isNone &&
        job?.status === InferenceJobStatus.SUCCEEDED &&
        event === undefined &&
        pilotReview === undefined;
      const reviewed = isNone
        ? hasAnalysis &&
          (event === undefined ||
            event.review !== null ||
            pilotReview !== undefined)
        : visionReviewed || pilotReview !== undefined;

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
        sessionBound: truth.videoAsset.sessionId !== null,
        missedPositiveEvent,
        reviewed,
        reviewDecision: event?.review?.decision ?? null,
        bootstrapReviewVerdict: pilotReview?.verdict ?? null,
        visionEventStatus: event?.status ?? null,
        needsReview:
          event?.status === 'PENDING_REVIEW' ||
          fusion?.vlmRequiresHumanReview === true ||
          missedPositiveEvent,
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

    // Latest fusion evidence by RUN timestamp (Codex P1): the videos
    // array is ordered by ground-truth updatedAt, which says nothing
    // about run recency — an edited old clip must not surface stale
    // evidence for the headline prediction or the CLEAN_CROP gate.
    let latestFusion: SafeFusionSummary | null = null;
    for (const row of videos) {
      if (
        row.fusion !== null &&
        (latestFusion === null || row.fusion.createdAt > latestFusion.createdAt)
      ) {
        latestFusion = row.fusion;
      }
    }

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
      linkedEvaluationRun: linkedRun
        ? {
            evaluationRunId: linkedRun.id,
            name: linkedRun.name,
            status: linkedRun.status,
            reviewCount: linkedRun._count.reviews,
          }
        : null,
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
        linkedEvaluationReviewCount: linkedRun
          ? linkedRun._count.reviews
          : null,
      }),
      scoreNote: SCORE_NOTE,
    };
  }
}
