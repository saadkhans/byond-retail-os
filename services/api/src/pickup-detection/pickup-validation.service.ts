import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CvTestScenario,
  EvidenceSourceType,
  FusionPolicyResult,
  FusionRunScope,
  GroundTruthEventKind,
  InferenceJobStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MAX_TIMESTAMP_MS } from '../video-ingest/dto/create-video-crop.dto';
import { containsSensitiveFreeText } from '../video-ingest/media-safety';
import {
  PickupDetectionRecord,
  pickupSourceId,
} from './pickup-detection.service';

/** Confusion matrix unlocks at this many REVIEWED videos (ground truth +
 *  finished detection attempt) — below it, per-cell counts are noise. */
export const CONFUSION_MATRIX_MIN_REVIEWED = 50;

/** Hard cap on ground-truth rows one summary() call scores — newest
 *  reviews win. Keeps the endpoint bounded as the test library grows,
 *  and stays comfortably above CONFUSION_MATRIX_MIN_REVIEWED. */
export const SUMMARY_MAX_ROWS = 500;

export interface GroundTruthView {
  videoAssetId: string;
  eventKind: GroundTruthEventKind;
  testType: CvTestScenario | null;
  productId: string | null;
  sku: string | null;
  productName: string | null;
  actualTimestampMs: number | null;
  quantity: number;
  note: string | null;
  updatedAt: Date;
}

export interface UpsertGroundTruthInput {
  eventKind: GroundTruthEventKind;
  testType?: CvTestScenario | null;
  productId?: string | null;
  actualTimestampMs?: number | null;
  quantity?: number;
  note?: string | null;
}

/**
 * Which ground-truth event kinds each CONTROLLED test scenario is allowed
 * to pair with. An incompatible pair (e.g. FALSE_TOUCH labeled on a PICKUP
 * clip) would silently corrupt the per-test-type pass rates on the
 * evaluation dashboard, so it is rejected at write time. The two VLM fault
 * drills require a product event — the VLM stage is only ever exercised
 * when a pickup/return exists, so NONE can never be a valid pairing.
 */
export const TEST_SCENARIO_ALLOWED_KINDS: Record<
  CvTestScenario,
  readonly GroundTruthEventKind[]
> = {
  [CvTestScenario.PICKUP_SINGLE]: [GroundTruthEventKind.PICKUP],
  [CvTestScenario.RETURN_SINGLE]: [GroundTruthEventKind.RETURN],
  [CvTestScenario.FALSE_TOUCH]: [GroundTruthEventKind.NONE],
  [CvTestScenario.TWO_SIMILAR_PICK_ONE]: [GroundTruthEventKind.PICKUP],
  [CvTestScenario.TWO_VISIBLE_PICK_ONE]: [GroundTruthEventKind.PICKUP],
  [CvTestScenario.VLM_UNAVAILABLE]: [
    GroundTruthEventKind.PICKUP,
    GroundTruthEventKind.RETURN,
  ],
  [CvTestScenario.VLM_INVALID_SKU]: [
    GroundTruthEventKind.PICKUP,
    GroundTruthEventKind.RETURN,
  ],
};

/** Pure compatibility check — null message means the pair is valid. The
 *  message is built ONLY from enum names, never caller free text. */
export function scenarioKindMismatch(
  testType: CvTestScenario | null | undefined,
  eventKind: GroundTruthEventKind,
): string | null {
  if (testType === null || testType === undefined) {
    return null;
  }
  const allowed = TEST_SCENARIO_ALLOWED_KINDS[testType];
  if (allowed.includes(eventKind)) {
    return null;
  }
  return (
    `testType ${testType} requires eventKind ` +
    `${allowed.join(' or ')} (got ${eventKind})`
  );
}

/**
 * One reviewed video's validation row. `outcome` vocabulary:
 * - correct:        truth PICKUP, predicted === actual AND the claimed
 *                   quantity matches the ground-truth quantity
 * - incorrect:      truth PICKUP, predicted !== actual (a claimed wrong SKU)
 * - quantity_mismatch: truth PICKUP, the right SKU was claimed but the
 *                   claimed quantity differs from ground truth (v1 always
 *                   claims quantityDelta 1, so every multi-unit truth lands
 *                   here) — counted as incorrect in the summary totals
 * - missed:         truth PICKUP, detection said UNKNOWN_PRODUCT
 * - false_pickup:   truth NONE, but a pickup event was produced
 * - true_negative:  truth NONE and no pickup was produced
 * - not_detected:   truth PICKUP but the attempt failed (no event at all)
 * - unscored:       truth RETURN (out of MVP scope — reported, never
 *                   scored) — or a fusion-only row where v1 has no
 *                   completed attempt (jobStatus null; fusion columns
 *                   still score).
 */
export interface ValidationRow {
  videoAssetId: string;
  originalFilename: string;
  reviewedAt: Date;
  actualSku: string | null;
  actualEventKind: GroundTruthEventKind;
  actualTimestampMs: number | null;
  predictedSku: string | null;
  /** Reviewer-entered actual quantity (>= 1 on every ground-truth row). */
  groundTruthQuantity: number;
  /** Quantity the v1 attempt claimed (abs of the result's quantityDelta —
   *  the sign belongs to the event type); null when no SKU was claimed. */
  predictedQuantity: number | null;
  matchScore: number | null;
  timestampErrorMs: number | null;
  outcome:
    | 'correct'
    | 'incorrect'
    | 'quantity_mismatch'
    | 'missed'
    | 'false_pickup'
    | 'true_negative'
    | 'not_detected'
    | 'unscored';
  topCandidates: { sku: string; score: number | null }[];
  processingMs: number | null;
  jobStatus: InferenceJobStatus | null;
  jobErrorCode: string | null;
  /** Latest non-FAILED fusion-v2 shadow run, scored against the same
   *  ground truth with the same vocabulary as the v1 `outcome` (NONE
   *  clips score false_pickup/true_negative; RETURN stays unscored).
   *  FAILED runs never score — they count as no run. */
  fusionTopSku: string | null;
  fusionTopScore: number | null;
  fusionPolicy: string | null;
  fusionVerdict:
    | 'correct'
    | 'incorrect'
    | 'missed'
    | 'false_pickup'
    | 'true_negative'
    | 'unscored'
    | null;
}

export interface ValidationSummary {
  rows: ValidationRow[];
  totals: {
    reviewed: number;
    correct: number;
    incorrect: number;
    missed: number;
    falsePositives: number;
    falseNegatives: number;
    trueNegatives: number;
    notDetected: number;
    unscored: number;
  };
  confusionMatrix: {
    minReviewed: number;
    reviewedCount: number;
    unlocked: boolean;
    /** Row = actual SKU, column = predicted; last column is UNKNOWN. */
    skus: string[];
    matrix: number[][] | null;
  };
}

@Injectable()
export class PickupValidationService {
  constructor(private readonly prisma: PrismaService) {}

  async upsertGroundTruth(
    tenantId: string,
    videoAssetId: string,
    input: UpsertGroundTruthInput,
    actorId?: string,
  ): Promise<GroundTruthView> {
    const asset = await this.prisma.videoAsset.findFirst({
      where: { tenantId, id: videoAssetId, deletedAt: null },
      select: { id: true, durationMs: true },
    });
    if (!asset) {
      throw new NotFoundException('Video asset not found');
    }
    // Scenario labels and event kinds must agree BEFORE anything persists —
    // an incompatible pair corrupts per-test-type pass rates (Codex P1).
    const scenarioMismatch = scenarioKindMismatch(
      input.testType,
      input.eventKind,
    );
    if (scenarioMismatch) {
      throw new BadRequestException(scenarioMismatch);
    }
    if (input.eventKind !== GroundTruthEventKind.NONE) {
      if (!input.productId) {
        throw new BadRequestException(
          'A PICKUP/RETURN ground truth needs the actual product',
        );
      }
      const product = await this.prisma.product.findFirst({
        where: { tenantId, id: input.productId },
        select: { id: true },
      });
      if (!product) {
        throw new BadRequestException(
          'The actual product does not exist in this tenant',
        );
      }
      const ts = input.actualTimestampMs;
      if (
        ts === null ||
        ts === undefined ||
        !Number.isInteger(ts) ||
        ts < 0 ||
        // Absolute ceiling mirrors the DTO's @Max: an unprobed asset has a
        // null durationMs, and without this bound an oversized value would
        // reach Prisma's int4 column and 500 instead of 400.
        ts > MAX_TIMESTAMP_MS ||
        (asset.durationMs !== null && ts >= asset.durationMs)
      ) {
        throw new BadRequestException(
          'actualTimestampMs must be an integer inside the video duration',
        );
      }
    }
    const quantity = input.quantity ?? 1;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
      throw new BadRequestException('quantity must be a whole number 1..100');
    }
    // The note is durably stored and echoed on every groundTruth() read —
    // screen it with the same fused free-text predicate as the screening
    // note (video-assets) and reference-image text, so credential/payment
    // content is rejected BEFORE anything is written.
    if (input.note && containsSensitiveFreeText(input.note)) {
      throw new BadRequestException(
        'note must not contain credential- or payment-bearing content',
      );
    }
    const data = {
      eventKind: input.eventKind,
      testType: input.testType ?? null,
      productId:
        input.eventKind === GroundTruthEventKind.NONE
          ? null
          : (input.productId as string),
      actualTimestampMs:
        input.eventKind === GroundTruthEventKind.NONE
          ? null
          : (input.actualTimestampMs as number),
      quantity,
      note: input.note?.slice(0, 500) ?? null,
      createdById: actorId ?? null,
    };
    // The composite selector makes the write itself enforce the tenant
    // boundary rather than relying on the asset lookup above.
    await this.prisma.videoGroundTruth.upsert({
      where: { tenantId_videoAssetId: { tenantId, videoAssetId } },
      create: { tenantId, videoAssetId, ...data },
      update: data,
    });
    return (await this.groundTruth(tenantId, videoAssetId)) as GroundTruthView;
  }

  async groundTruth(
    tenantId: string,
    videoAssetId: string,
  ): Promise<GroundTruthView | null> {
    const row = await this.prisma.videoGroundTruth.findFirst({
      where: { tenantId, videoAssetId },
      include: { product: { select: { sku: true, name: true } } },
    });
    if (!row) {
      return null;
    }
    return {
      videoAssetId: row.videoAssetId,
      eventKind: row.eventKind,
      testType: row.testType,
      productId: row.productId,
      sku: row.product?.sku ?? null,
      productName: row.product?.name ?? null,
      actualTimestampMs: row.actualTimestampMs,
      quantity: row.quantity,
      note: row.note,
      updatedAt: row.updatedAt,
    };
  }

  async summary(tenantId: string): Promise<ValidationSummary> {
    const truths = await this.prisma.videoGroundTruth.findMany({
      // Deleted assets are excluded in the query (not post-fetch) so the
      // row cap is spent only on rows that can actually appear.
      where: { tenantId, videoAsset: { deletedAt: null } },
      include: {
        product: { select: { sku: true } },
        videoAsset: { select: { originalFilename: true, deletedAt: true } },
      },
      // `id` tiebreak keeps the capped window stable when updatedAt ties.
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: SUMMARY_MAX_ROWS,
    });
    const liveTruths = truths.filter(
      (truth) => truth.videoAsset.deletedAt === null,
    );
    const assetIds = liveTruths.map((truth) => truth.videoAssetId);
    // One batched query per dependency instead of one per ground-truth
    // row. Both fetch every attempt/run for the capped asset window
    // ordered newest-first, so first-seen per key IS the latest — the
    // same row each per-asset findFirst used to return.
    const [jobRows, fusionRows] = assetIds.length
      ? await Promise.all([
          this.prisma.inferenceJob.findMany({
            where: {
              tenantId,
              sourceType: EvidenceSourceType.VISION,
              sourceId: { in: assetIds.map(pickupSourceId) },
            },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            include: { result: { include: { candidates: true } } },
          }),
          // Only a non-FAILED run is a fusion RESULT — a crashed pipeline
          // persists a FAILED row for debugging, but scoring it would
          // present a failed experiment as missed/correct/incorrect.
          // FAILED runs are excluded in the query itself, exactly as if
          // they were never recorded.
          this.prisma.pickupFusionRun.findMany({
            where: {
              tenantId,
              videoAssetId: { in: assetIds },
              policy: { not: FusionPolicyResult.FAILED },
              // WHOLE_CLIP only: window-scoped replay runs analyze one
              // extracted interaction, not the clip the ground truth
              // describes — they must not displace the whole-clip result
              // this dashboard scores (Codex P1).
              runScope: FusionRunScope.WHOLE_CLIP,
            },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            select: {
              videoAssetId: true,
              fusedTopSku: true,
              fusedTopScore: true,
              policy: true,
            },
          }),
        ])
      : [[], []];
    const latestJobBySourceId = new Map<string, (typeof jobRows)[number]>();
    for (const jobRow of jobRows) {
      // sourceId is nullable on the model, though the IN filter above
      // only ever matches non-null pickup source ids.
      if (
        jobRow.sourceId !== null &&
        !latestJobBySourceId.has(jobRow.sourceId)
      ) {
        latestJobBySourceId.set(jobRow.sourceId, jobRow);
      }
    }
    const latestFusionByAssetId = new Map<
      string,
      (typeof fusionRows)[number]
    >();
    for (const fusionRow of fusionRows) {
      // videoAssetId is nullable since Phase 13 (LIVE_WINDOW runs carry a
      // live session instead) — the WHOLE_CLIP filter above already
      // excludes those, so this guard is type narrowing, not policy.
      if (
        fusionRow.videoAssetId !== null &&
        !latestFusionByAssetId.has(fusionRow.videoAssetId)
      ) {
        latestFusionByAssetId.set(fusionRow.videoAssetId, fusionRow);
      }
    }
    const scored = liveTruths
      .map((truth) => {
        const latestJob =
          latestJobBySourceId.get(pickupSourceId(truth.videoAssetId)) ?? null;
        // The v1 pipeline only counts when its attempt finished.
        const job =
          latestJob &&
          latestJob.status !== InferenceJobStatus.QUEUED &&
          latestJob.status !== InferenceJobStatus.RUNNING
            ? latestJob
            : null;
        const fusionRun =
          latestFusionByAssetId.get(truth.videoAssetId) ?? null;
        return { truth, job, fusionRun };
      })
      // A ground-truth row is reviewable when EITHER pipeline has a
      // completed result — running fusion directly (without a v1 attempt)
      // is a supported flow, and its accuracy must not vanish from the
      // dashboard just because v1 never ran. The unavailable pipeline's
      // fields stay null/unscored.
      .filter((entry) => entry.job !== null || entry.fusionRun !== null);
    const visionEventIds = [
      ...new Set(
        scored
          .map((entry) => entry.job?.visionEventId)
          .filter((id): id is string => typeof id === 'string'),
      ),
    ];
    const events = visionEventIds.length
      ? await this.prisma.visionEvent.findMany({
          where: { tenantId, id: { in: visionEventIds } },
          select: { id: true, metadata: true },
        })
      : [];
    const metadataByEventId = new Map(
      events.map((event) => [event.id, event.metadata]),
    );
    const rows: ValidationRow[] = [];
    for (const { truth, job, fusionRun } of scored) {
      const rawMetadata = (
        job?.visionEventId
          ? metadataByEventId.get(job.visionEventId)
          : undefined
      ) as unknown;
      const record =
        rawMetadata !== null &&
        typeof rawMetadata === 'object' &&
        (rawMetadata as PickupDetectionRecord).kind ===
          'PRODUCT_PICKUP_DETECTION'
          ? (rawMetadata as PickupDetectionRecord)
          : null;
      const actualSku = truth.product?.sku ?? null;
      const predictedSku = record?.sku ?? null;
      const detected = record !== null;
      // The claimed quantity lives on the result row, not the metadata
      // record — abs() because the sign is carried by the event type. v1
      // hard-codes quantityDelta 1 today; reading the persisted value keeps
      // the scoring honest if that ever changes.
      const predictedQuantity =
        predictedSku !== null && job?.result
          ? Math.abs(job.result.quantityDelta)
          : null;
      let outcome: ValidationRow['outcome'];
      if (!job) {
        // Fusion-only row: v1 has no completed attempt to score.
        outcome = 'unscored';
      } else if (truth.eventKind === GroundTruthEventKind.RETURN) {
        outcome = 'unscored';
      } else if (truth.eventKind === GroundTruthEventKind.NONE) {
        outcome = detected ? 'false_pickup' : 'true_negative';
      } else if (!detected) {
        outcome = 'not_detected';
      } else if (predictedSku === null) {
        outcome = 'missed';
      } else if (predictedSku === actualSku) {
        // The SKU alone is not the whole claim: a 3-unit pickup answered
        // with quantity 1 must not score as correct.
        outcome =
          predictedQuantity === truth.quantity
            ? 'correct'
            : 'quantity_mismatch';
      } else {
        outcome = 'incorrect';
      }
      // Fusion scores every supported ground-truth kind with the same
      // semantics as the v1 outcome above: NONE clips grade the run as a
      // false pickup or true negative, RETURN stays unscored (out of MVP
      // scope), PICKUP grades the claimed SKU. Fusion runs carry no
      // quantity claim, so its verdict stays SKU-only (no
      // quantity_mismatch).
      let fusionVerdict: ValidationRow['fusionVerdict'] = null;
      if (fusionRun) {
        if (truth.eventKind === GroundTruthEventKind.RETURN) {
          fusionVerdict = 'unscored';
        } else if (truth.eventKind === GroundTruthEventKind.NONE) {
          fusionVerdict =
            fusionRun.fusedTopSku === null ? 'true_negative' : 'false_pickup';
        } else if (fusionRun.fusedTopSku === null) {
          fusionVerdict = 'missed';
        } else {
          fusionVerdict =
            fusionRun.fusedTopSku === actualSku ? 'correct' : 'incorrect';
        }
      }
      rows.push({
        fusionTopSku: fusionRun?.fusedTopSku ?? null,
        fusionTopScore: fusionRun?.fusedTopScore ?? null,
        fusionPolicy: fusionRun?.policy ?? null,
        fusionVerdict,
        videoAssetId: truth.videoAssetId,
        originalFilename: truth.videoAsset.originalFilename,
        reviewedAt: truth.updatedAt,
        actualSku,
        actualEventKind: truth.eventKind,
        actualTimestampMs: truth.actualTimestampMs,
        predictedSku,
        groundTruthQuantity: truth.quantity,
        predictedQuantity,
        matchScore: record?.confidence ?? null,
        timestampErrorMs:
          record && truth.actualTimestampMs !== null
            ? Math.abs(record.eventPeakMs - truth.actualTimestampMs)
            : null,
        outcome,
        topCandidates: [...(job?.result?.candidates ?? [])]
          // Prisma gives no relation-order guarantee without an orderBy —
          // sort by rank (1 = strongest) before taking the top three.
          .sort((a, b) => a.rank - b.rank)
          .slice(0, 3)
          .map((candidate) => ({
            sku: candidate.sku,
            score: candidate.score,
          })),
        processingMs: record?.processingMs ?? null,
        jobStatus: job?.status ?? null,
        jobErrorCode: job?.errorCode ?? null,
      });
    }

    const totals = {
      reviewed: rows.length,
      correct: rows.filter((r) => r.outcome === 'correct').length,
      // quantity_mismatch is an incorrect claim (right SKU, wrong count),
      // so it counts here — but NOT in falsePositives/falseNegatives below:
      // the right product WAS claimed, only its count was off.
      incorrect: rows.filter(
        (r) =>
          r.outcome === 'incorrect' || r.outcome === 'quantity_mismatch',
      ).length,
      missed: rows.filter((r) => r.outcome === 'missed').length,
      // FALSE POSITIVE: a product was CLAIMED that should not have been —
      // a wrong SKU on a real pickup, or any pickup on a NONE clip.
      falsePositives:
        rows.filter((r) => r.outcome === 'incorrect').length +
        rows.filter((r) => r.outcome === 'false_pickup').length,
      // FALSE NEGATIVE: a real pickup produced no claimed product —
      // UNKNOWN_PRODUCT, a failed attempt, or a wrong SKU (the actual
      // product went unclaimed there too).
      falseNegatives:
        rows.filter(
          (r) =>
            r.outcome === 'missed' ||
            r.outcome === 'not_detected' ||
            r.outcome === 'incorrect',
        ).length,
      trueNegatives: rows.filter((r) => r.outcome === 'true_negative').length,
      notDetected: rows.filter((r) => r.outcome === 'not_detected').length,
      unscored: rows.filter((r) => r.outcome === 'unscored').length,
    };

    // The confusion matrix scores the v1 pipeline only — fusion-only rows
    // (no completed v1 attempt) must not pollute its UNKNOWN column.
    const scorable = rows.filter(
      (r) =>
        r.actualEventKind === GroundTruthEventKind.PICKUP &&
        r.jobStatus !== null,
    );
    const unlocked = scorable.length >= CONFUSION_MATRIX_MIN_REVIEWED;
    let skus: string[] = [];
    let matrix: number[][] | null = null;
    if (unlocked) {
      const skuSet = new Set<string>();
      for (const row of scorable) {
        if (row.actualSku) skuSet.add(row.actualSku);
        if (row.predictedSku) skuSet.add(row.predictedSku);
      }
      skus = [...skuSet].sort();
      const unknownColumn = skus.length;
      matrix = skus.map(() => new Array<number>(skus.length + 1).fill(0));
      for (const row of scorable) {
        if (!row.actualSku) continue;
        const actualIndex = skus.indexOf(row.actualSku);
        const predictedIndex = row.predictedSku
          ? skus.indexOf(row.predictedSku)
          : unknownColumn;
        matrix[actualIndex][predictedIndex] += 1;
      }
    }
    return {
      rows,
      totals,
      confusionMatrix: {
        minReviewed: CONFUSION_MATRIX_MIN_REVIEWED,
        reviewedCount: scorable.length,
        unlocked,
        skus,
        matrix,
      },
    };
  }
}
