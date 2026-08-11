import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  EvidenceSourceType,
  GroundTruthEventKind,
  InferenceJobStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  PickupDetectionRecord,
  pickupSourceId,
} from './pickup-detection.service';

/** Confusion matrix unlocks at this many REVIEWED videos (ground truth +
 *  finished detection attempt) — below it, per-cell counts are noise. */
export const CONFUSION_MATRIX_MIN_REVIEWED = 50;

export interface GroundTruthView {
  videoAssetId: string;
  eventKind: GroundTruthEventKind;
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
  productId?: string | null;
  actualTimestampMs?: number | null;
  quantity?: number;
  note?: string | null;
}

/**
 * One reviewed video's validation row. `outcome` vocabulary:
 * - correct:        truth PICKUP, predicted === actual
 * - incorrect:      truth PICKUP, predicted !== actual (a claimed wrong SKU)
 * - missed:         truth PICKUP, detection said UNKNOWN_PRODUCT
 * - false_pickup:   truth NONE, but a pickup event was produced
 * - true_negative:  truth NONE and no pickup was produced
 * - not_detected:   truth PICKUP but the attempt failed (no event at all)
 * - unscored:       truth RETURN (out of MVP scope — reported, never scored)
 */
export interface ValidationRow {
  videoAssetId: string;
  originalFilename: string;
  reviewedAt: Date;
  actualSku: string | null;
  actualEventKind: GroundTruthEventKind;
  actualTimestampMs: number | null;
  predictedSku: string | null;
  matchScore: number | null;
  timestampErrorMs: number | null;
  outcome:
    | 'correct'
    | 'incorrect'
    | 'missed'
    | 'false_pickup'
    | 'true_negative'
    | 'not_detected'
    | 'unscored';
  topCandidates: { sku: string; score: number | null }[];
  processingMs: number | null;
  jobStatus: InferenceJobStatus | null;
  jobErrorCode: string | null;
  /** Latest fusion-v2 shadow run, scored against the same ground truth. */
  fusionTopSku: string | null;
  fusionTopScore: number | null;
  fusionPolicy: string | null;
  fusionVerdict: 'correct' | 'incorrect' | 'missed' | null;
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
    const data = {
      eventKind: input.eventKind,
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
    await this.prisma.videoGroundTruth.upsert({
      where: { videoAssetId },
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
      where: { tenantId },
      include: {
        product: { select: { sku: true } },
        videoAsset: { select: { originalFilename: true, deletedAt: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });
    const rows: ValidationRow[] = [];
    for (const truth of truths) {
      if (truth.videoAsset.deletedAt !== null) {
        continue;
      }
      const job = await this.prisma.inferenceJob.findFirst({
        where: {
          tenantId,
          sourceType: EvidenceSourceType.VISION,
          sourceId: pickupSourceId(truth.videoAssetId),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: { result: { include: { candidates: true } } },
      });
      if (!job || job.status === InferenceJobStatus.QUEUED || job.status === InferenceJobStatus.RUNNING) {
        // Not reviewed yet: no finished attempt to score.
        continue;
      }
      const event = job.visionEventId
        ? await this.prisma.visionEvent.findFirst({
            where: { tenantId, id: job.visionEventId },
            select: { metadata: true },
          })
        : null;
      const rawMetadata = event?.metadata as unknown;
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
      let outcome: ValidationRow['outcome'];
      if (truth.eventKind === GroundTruthEventKind.RETURN) {
        outcome = 'unscored';
      } else if (truth.eventKind === GroundTruthEventKind.NONE) {
        outcome = detected ? 'false_pickup' : 'true_negative';
      } else if (!detected) {
        outcome = 'not_detected';
      } else if (predictedSku === null) {
        outcome = 'missed';
      } else if (predictedSku === actualSku) {
        outcome = 'correct';
      } else {
        outcome = 'incorrect';
      }
      const fusionRun = await this.prisma.pickupFusionRun.findFirst({
        where: { tenantId, videoAssetId: truth.videoAssetId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { fusedTopSku: true, fusedTopScore: true, policy: true },
      });
      const fusionVerdict =
        fusionRun && truth.eventKind === GroundTruthEventKind.PICKUP
          ? fusionRun.fusedTopSku === null
            ? ('missed' as const)
            : fusionRun.fusedTopSku === actualSku
              ? ('correct' as const)
              : ('incorrect' as const)
          : null;
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
        matchScore: record?.confidence ?? null,
        timestampErrorMs:
          record && truth.actualTimestampMs !== null
            ? Math.abs(record.eventPeakMs - truth.actualTimestampMs)
            : null,
        outcome,
        topCandidates: (job.result?.candidates ?? [])
          .slice(0, 3)
          .map((candidate) => ({
            sku: candidate.sku,
            score: candidate.score,
          })),
        processingMs: record?.processingMs ?? null,
        jobStatus: job.status,
        jobErrorCode: job.errorCode,
      });
    }

    const totals = {
      reviewed: rows.length,
      correct: rows.filter((r) => r.outcome === 'correct').length,
      incorrect: rows.filter((r) => r.outcome === 'incorrect').length,
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

    const scorable = rows.filter(
      (r) => r.actualEventKind === GroundTruthEventKind.PICKUP,
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
