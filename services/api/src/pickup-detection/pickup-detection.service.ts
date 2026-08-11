import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  EvidenceQuality,
  EvidenceSourceType,
  InferenceJobStatus,
  VideoAssetStatus,
  VisionEventType,
} from '@prisma/client';
import { InferenceJobsService } from '../inference/inference-jobs.service';
import { PrismaService } from '../prisma/prisma.service';
import { LocalVideoStorageAdapter } from '../video-ingest/storage/local-video-storage.adapter';
import { VideoAssetsRepository } from '../video-ingest/video-assets.repository';
import { VideoAssetsService } from '../video-ingest/video-assets.service';
import { PickupAnalysisFrameDecoder, analysisGeometryFor } from './analysis/analysis-frames';
import {
  AnalysisGeometry,
  BoundingBox,
  analyzePickup,
  backgroundWindows,
  medianBackground,
} from './analysis/pickup-analyzer';
import {
  MATCHER_MODEL_KEY,
  MATCHER_MODEL_VERSION,
  MatchCandidate,
  cropRgb,
  matchProduct,
} from './analysis/product-matcher';
import { PickupDetectionConfig } from './pickup-detection.config';
import { PickupReferenceLibrary } from './reference-library';

export const PICKUP_ADAPTER_KEY = 'pickup-classical-v1';

/** sourceId shared by every attempt for one asset — the state lookup key. */
export function pickupSourceId(videoAssetId: string): string {
  return `pickup:${videoAssetId}`;
}

/**
 * The pickup record persisted on the VisionEvent's `metadata` column.
 * SERVER-COMPUTED SAFE DESCRIPTORS ONLY — numbers, enum strings, and
 * opaque artifact ids; never storage keys, paths, or media bytes. This is
 * a deliberate, narrow exception to "ingest never writes metadata": the
 * public ingest contract still rejects caller-supplied metadata; this
 * record is written AFTER conversion by the pickup service itself.
 */
export interface PickupDetectionRecord {
  version: 1;
  kind: 'PRODUCT_PICKUP_DETECTION';
  result: 'PRODUCT_MATCHED' | 'UNKNOWN_PRODUCT';
  confidence: number;
  eventStartMs: number;
  eventPeakMs: number;
  eventEndMs: number;
  /** SOURCE-pixel coordinates. */
  boundingBox: { x: number; y: number; width: number; height: number };
  sourceFrameArtifactId: string | null;
  cropArtifactId: string | null;
  productId: string | null;
  sku: string | null;
  analysisFps: number;
  modelKey: string;
  modelVersion: string;
  /** Wall-clock analysis + matching time for this attempt. */
  processingMs: number;
}

export interface PickupDetectionState {
  enabled: boolean;
  job: {
    id: string;
    status: InferenceJobStatus;
    attempts: number;
    adapterKey: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    createdAt: Date;
    completedAt: Date | null;
  } | null;
  detection:
    | (PickupDetectionRecord & {
        visionEventId: string;
        visionEventStatus: string;
        productName: string | null;
        candidates: {
          productId: string;
          sku: string;
          productName: string;
          score: number | null;
          rank: number;
        }[];
        review: {
          decision: string;
          appliedProductId: string | null;
          reason: string | null;
          createdAt: Date;
        } | null;
      })
    | null;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** Scale an analysis-space box to source pixels, clamped and floored to a
 *  sane minimum so the crop endpoint's own validation always passes. */
export function scaleBoxToSource(
  box: BoundingBox,
  geometry: AnalysisGeometry,
  source: { width: number; height: number },
): BoundingBox {
  const sx = source.width / geometry.width;
  const sy = source.height / geometry.height;
  let x = Math.max(0, Math.floor(box.x * sx));
  let y = Math.max(0, Math.floor(box.y * sy));
  let width = Math.max(8, Math.ceil(box.width * sx));
  let height = Math.max(8, Math.ceil(box.height * sy));
  if (x + width > source.width) {
    width = source.width - x;
  }
  if (y + height > source.height) {
    height = source.height - y;
  }
  if (width < 1 || height < 1) {
    x = 0;
    y = 0;
    width = source.width;
    height = source.height;
  }
  return { x, y, width, height };
}

@Injectable()
export class PickupDetectionService {
  private readonly logger = new Logger(PickupDetectionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: PickupDetectionConfig,
    private readonly decoder: PickupAnalysisFrameDecoder,
    private readonly referenceLibrary: PickupReferenceLibrary,
    private readonly inferenceJobs: InferenceJobsService,
    private readonly videoAssets: VideoAssetsService,
    private readonly videoAssetsRepository: VideoAssetsRepository,
    private readonly storage: LocalVideoStorageAdapter,
  ) {}

  /** Latest pickup job for the asset, newest attempt first. */
  private latestJob(tenantId: string, videoAssetId: string) {
    return this.prisma.inferenceJob.findFirst({
      where: {
        tenantId,
        sourceType: EvidenceSourceType.VISION,
        sourceId: pickupSourceId(videoAssetId),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }

  /**
   * Run (or resume) detection for one VALIDATED/READY asset. Idempotent
   * per attempt: the job's idempotencyKey pins each attempt, and a
   * SUCCEEDED job is never re-run unless `force`.
   */
  async detectForAsset(
    tenantId: string,
    videoAssetId: string,
    options: { force?: boolean } = {},
  ): Promise<PickupDetectionState> {
    if (!this.config.enabled) {
      throw new ConflictException(
        'Pickup detection is disabled on this deployment ' +
          '(PICKUP_DETECTION_ENABLED)',
      );
    }
    const internal =
      await this.videoAssetsRepository.findByIdInternal(tenantId, videoAssetId);
    if (!internal) {
      throw new NotFoundException('Video asset not found');
    }
    if (
      internal.status !== VideoAssetStatus.VALIDATED &&
      internal.status !== VideoAssetStatus.READY
    ) {
      throw new ConflictException(
        'Pickup detection needs a VALIDATED asset (validate the upload first)',
      );
    }

    const existing = await this.latestJob(tenantId, videoAssetId);
    if (existing) {
      const terminal =
        existing.status === InferenceJobStatus.SUCCEEDED ||
        existing.status === InferenceJobStatus.FAILED ||
        existing.status === InferenceJobStatus.CANCELLED;
      if (!terminal) {
        // An attempt is already queued/running — report it, never fork.
        return this.getState(tenantId, videoAssetId);
      }
      if (existing.status === InferenceJobStatus.SUCCEEDED && !options.force) {
        return this.getState(tenantId, videoAssetId);
      }
    }

    // Attempt-scoped idempotency key; sourceId stays stable so the state
    // lookup always finds the newest attempt.
    const attemptOrdinal = existing
      ? await this.prisma.inferenceJob.count({
          where: {
            tenantId,
            sourceType: EvidenceSourceType.VISION,
            sourceId: pickupSourceId(videoAssetId),
          },
        })
      : 0;
    const job = await this.inferenceJobs.create(tenantId, {
      jobType: 'PRODUCT_RECOGNITION',
      sourceType: EvidenceSourceType.VISION,
      sourceId: pickupSourceId(videoAssetId),
      idempotencyKey: `${pickupSourceId(videoAssetId)}:a${attemptOrdinal + 1}`,
      locationId: internal.locationId ?? undefined,
      unitId: internal.unitId ?? undefined,
      deviceId: internal.deviceId ?? undefined,
      sessionId: internal.sessionId ?? undefined,
      inputDescriptor: {
        artifactType: 'VIDEO_ASSET',
        videoAssetId,
        analysisFps: this.config.analysisFps,
      },
    });

    await this.runJob(tenantId, job.id, videoAssetId).catch((error) => {
      // runJob records its own failure on the job; this catch only guards
      // the worker loop from an unexpected double-fault.
      this.logger.error(
        `Pickup detection attempt for asset ${videoAssetId} faulted: ${
          error instanceof Error ? error.message : 'unknown'
        }`,
      );
    });
    return this.getState(tenantId, videoAssetId);
  }

  /** Execute one QUEUED pickup job end to end. */
  private async runJob(
    tenantId: string,
    jobId: string,
    videoAssetId: string,
  ): Promise<void> {
    const started = await this.inferenceJobs.start(tenantId, jobId, {
      adapterKey: PICKUP_ADAPTER_KEY,
    });
    const attempt = started.attempts;
    const failJob = (errorCode: string, errorMessage: string) =>
      this.inferenceJobs
        .fail(tenantId, jobId, { attempt, errorCode, errorMessage })
        .then(() => undefined);

    const internal =
      await this.videoAssetsRepository.findByIdInternal(tenantId, videoAssetId);
    if (
      !internal ||
      internal.durationMs === null ||
      internal.width === null ||
      internal.height === null
    ) {
      await failJob(
        'ASSET_NOT_PROCESSABLE',
        'The video asset disappeared or has no probed metadata',
      );
      return;
    }
    if (!internal.locationId || !internal.unitId) {
      await failJob(
        'MISSING_LOCATION_CONTEXT',
        'Assign a store and unit to this video (upload fields) — a ' +
          'pickup event needs both to be recorded',
      );
      return;
    }

    // ---- 0. Library gates, BEFORE any decode (fail fast) ---------------
    const library = await this.referenceLibrary.load(tenantId);
    if (library.productsWithImages === 0) {
      await failJob(
        'REFERENCE_LIBRARY_EMPTY',
        'No catalog product has any reference images — upload them on the ' +
          'Reference library page',
      );
      return;
    }
    if (library.readyProducts === 0) {
      await failJob(
        'NO_INFERENCE_READY_SKUS',
        'No product meets the inference-ready floor of ' +
          '5 reference images',
      );
      return;
    }
    const readyForStore = await this.referenceLibrary.readyProductIds(
      tenantId,
      internal.locationId,
    );
    if (readyForStore.length === 0) {
      await failJob(
        'NO_INFERENCE_READY_SKUS',
        'The selected store stocks no inference-ready SKUs',
      );
      return;
    }
    const readyIdSet = new Set(readyForStore);
    const references = library.references.filter((reference) =>
      readyIdSet.has(reference.productId),
    );

    const processingStartedAt = Date.now();

    // ---- 1. Decode analysis frames -------------------------------------
    const geometry = analysisGeometryFor(
      {
        durationMs: internal.durationMs,
        width: internal.width,
        height: internal.height,
        fps: internal.fps ?? 30,
      },
      this.config.analysisWidth,
    );
    let frames;
    try {
      frames = await this.decoder.decodeAnalysisFrames(
        this.storage.internalPathFor(internal.storageKey),
        this.config.analysisFps,
        geometry,
      );
    } catch {
      await failJob(
        'ANALYSIS_DECODE_FAILED',
        'The stored video could not be decoded for analysis',
      );
      return;
    }

    // ---- 2. Motion + removal analysis ----------------------------------
    const analysis = analyzePickup(frames, geometry);
    if (!analysis.pickupDetected || !analysis.window || !analysis.removalBox) {
      await failJob(
        analysis.rejectReason ?? 'NO_PICKUP_DETECTED',
        analysis.rejectReason === 'NO_MOTION_EVENT'
          ? 'No motion event stands out from the clip — no pickup detected'
          : analysis.rejectReason === 'TOO_FEW_FRAMES'
            ? 'The clip is too short for the configured analysis rate'
            : 'Motion was found but nothing was removed from the scene',
      );
      return;
    }
    const { window, removalBox } = analysis;

    // ---- 3. Reference matching (pixels only) ---------------------------
    // The product's appearance BEFORE the pickup: median of the clip's
    // opening quiet frames (same endpoint rule as the analyzer), cropped
    // to the removal region.
    const { before: beforeFrames } = backgroundWindows(frames, window, 3);
    const background = medianBackground(beforeFrames);
    const productCrop = cropRgb(
      { width: geometry.width, height: geometry.height, rgb: background },
      removalBox,
    );
    const candidates = matchProduct(productCrop, references);
    const top: MatchCandidate | undefined = candidates[0];
    const matched =
      top !== undefined && top.score >= this.config.confidenceThreshold;
    const processingMs = Date.now() - processingStartedAt;

    // ---- 4. Full-resolution artifacts (idempotent, audited) ------------
    const sourceBox = scaleBoxToSource(removalBox, geometry, {
      width: internal.width,
      height: internal.height,
    });
    const clampTs = (value: number) =>
      Math.max(0, Math.min(Math.round(value), internal.durationMs! - 1));
    const peakTs = clampTs(window.eventPeakMs);
    const preEventTs = clampTs(window.eventStartMs - 1000);
    let sourceFrameArtifactId: string | null = null;
    let cropArtifactId: string | null = null;
    try {
      const frameResult = await this.videoAssets.extractFrames(
        tenantId,
        videoAssetId,
        { timestampMs: peakTs, idempotencyKey: `pickup:${jobId}:frame` },
      );
      sourceFrameArtifactId = frameResult.artifacts[0]?.id ?? null;
      const cropResult = await this.videoAssets.createCrop(
        tenantId,
        videoAssetId,
        {
          timestampMs: preEventTs,
          x: sourceBox.x,
          y: sourceBox.y,
          width: sourceBox.width,
          height: sourceBox.height,
          reason: 'PRODUCT_PICKUP',
          idempotencyKey: `pickup:${jobId}:crop`,
        },
      );
      cropArtifactId = cropResult.artifact.id;
    } catch (error) {
      // Artifacts are evidence, not the verdict — log and continue with
      // whatever persisted; ids stay null when they did not.
      this.logger.warn(
        `Pickup artifacts for asset ${videoAssetId} partially failed: ${
          error instanceof Error ? error.message : 'unknown'
        }`,
      );
    }

    // ---- 5. Complete the job + convert to a VisionEvent -----------------
    const occurredAt = new Date(
      internal.createdAt.getTime() + peakTs,
    ).toISOString();
    // ALL top candidate scores travel to the result/event (validation
    // requirement) — capped at 10 of the contract's 20-candidate ceiling.
    const detections = candidates.slice(0, 10).map((candidate) => ({
      sku: candidate.sku,
      confidence: round4(candidate.score),
    }));
    try {
      await this.inferenceJobs.complete(tenantId, jobId, {
        attempt,
        eventType: VisionEventType.PRODUCT_PICKUP,
        quantityDelta: 1,
        occurredAt,
        detections,
        evidenceQuality: matched
          ? top.score >= 0.8
            ? EvidenceQuality.HIGH
            : EvidenceQuality.MEDIUM
          : EvidenceQuality.LOW,
        modelKey: MATCHER_MODEL_KEY,
        modelVersion: MATCHER_MODEL_VERSION,
      });
      const converted = await this.inferenceJobs.toVisionEvent(
        tenantId,
        jobId,
      );
      const record: PickupDetectionRecord = {
        version: 1,
        kind: 'PRODUCT_PICKUP_DETECTION',
        result: matched ? 'PRODUCT_MATCHED' : 'UNKNOWN_PRODUCT',
        confidence: round4(top?.score ?? 0),
        eventStartMs: Math.round(window.eventStartMs),
        eventPeakMs: peakTs,
        eventEndMs: Math.round(window.eventEndMs),
        boundingBox: sourceBox,
        sourceFrameArtifactId,
        cropArtifactId,
        productId: matched ? top.productId : null,
        sku: matched ? top.sku : null,
        analysisFps: this.config.analysisFps,
        modelKey: MATCHER_MODEL_KEY,
        modelVersion: MATCHER_MODEL_VERSION,
        processingMs,
      };
      // Narrow internal metadata write — see PickupDetectionRecord docs.
      await this.prisma.visionEvent.update({
        where: { id: converted.visionEvent.id },
        data: { metadata: record as object },
      });
    } catch (error) {
      await failJob(
        'RESULT_RECORDING_FAILED',
        'The detection finished but its result could not be recorded',
      ).catch(() => undefined);
      this.logger.error(
        `Recording pickup result for asset ${videoAssetId} failed: ${
          error instanceof Error ? error.message : 'unknown'
        }`,
      );
    }
  }

  /** Assemble the UI-facing state for one asset. */
  async getState(
    tenantId: string,
    videoAssetId: string,
  ): Promise<PickupDetectionState> {
    const job = await this.latestJob(tenantId, videoAssetId);
    if (!job) {
      return { enabled: this.config.enabled, job: null, detection: null };
    }
    let detection: PickupDetectionState['detection'] = null;
    if (job.visionEventId) {
      const event = await this.prisma.visionEvent.findFirst({
        where: { tenantId, id: job.visionEventId },
        include: {
          candidates: { orderBy: { rank: 'asc' } },
          review: true,
        },
      });
      const record = event?.metadata as PickupDetectionRecord | null;
      if (event && record && record.kind === 'PRODUCT_PICKUP_DETECTION') {
        const matchedCandidate = record.productId
          ? event.candidates.find((c) => c.productId === record.productId)
          : undefined;
        detection = {
          ...record,
          visionEventId: event.id,
          visionEventStatus: event.status,
          productName: matchedCandidate?.productName ?? null,
          candidates: event.candidates.map((candidate) => ({
            productId: candidate.productId,
            sku: candidate.sku,
            productName: candidate.productName,
            score: candidate.score,
            rank: candidate.rank,
          })),
          review: event.review
            ? {
                decision: event.review.decision,
                appliedProductId: event.review.appliedProductId,
                reason: event.review.reason,
                createdAt: event.review.createdAt,
              }
            : null,
        };
      }
    }
    return {
      enabled: this.config.enabled,
      job: {
        id: job.id,
        status: job.status,
        attempts: job.attempts,
        adapterKey: job.adapterKey,
        errorCode: job.errorCode,
        errorMessage: job.errorMessage,
        createdAt: job.createdAt,
        completedAt: job.completedAt,
      },
      detection,
    };
  }
}
