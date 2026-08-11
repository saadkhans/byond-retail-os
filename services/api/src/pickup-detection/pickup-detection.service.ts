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
import { PlatformModulesService } from '../platform-modules/platform-modules.service';
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

/** errorCode stamped on attempts refused by the cv dependency gate. An
 *  ENVIRONMENTAL refusal, not a verdict on the asset — the auto worker
 *  treats these FAILED jobs as never-attempted so the asset is retried
 *  once the gate clears. */
export const CV_MODULE_DISABLED_ERROR_CODE = 'CV_MODULE_DISABLED';

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
    private readonly platformModules: PlatformModulesService,
    private readonly videoAssets: VideoAssetsService,
    private readonly videoAssetsRepository: VideoAssetsRepository,
    private readonly storage: LocalVideoStorageAdapter,
  ) {}

  /** Latest pickup job for the asset, newest attempt first. The result
   *  relation rides along so the retry path can tell a REPAIRABLE success
   *  (result survived) from one with nothing replayable behind it. */
  private latestJob(tenantId: string, videoAssetId: string) {
    return this.prisma.inferenceJob.findFirst({
      where: {
        tenantId,
        sourceType: EvidenceSourceType.VISION,
        sourceId: pickupSourceId(videoAssetId),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: { result: true },
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
        // An attempt is already queued/running — but it may be STRANDED:
        // pickup jobs only ever execute in-process right after creation,
        // so a crashed process leaves RUNNING (until the lease expires)
        // and an operator reclaim leaves QUEUED, and nothing else would
        // ever drive either again. Sweep and resume before reporting; a
        // genuinely live attempt is reported, never forked.
        return this.resumeStrandedAttempt(tenantId, videoAssetId);
      }
      if (existing.status === InferenceJobStatus.SUCCEEDED && !options.force) {
        const state = await this.getState(tenantId, videoAssetId);
        if (state.detection !== null) {
          return state;
        }
        // SUCCEEDED must imply a usable detection. A crash or transient
        // failure between the terminal transition and the event
        // conversion/metadata write leaves a success with NOTHING behind
        // it. While the attempt's InferenceResult survives it is repaired
        // IN PLACE — conversion replays idempotently under the job-derived
        // reserved key, so a second PENDING_REVIEW event can never be
        // minted for the same physical pickup. Only a success with no
        // result at all (nothing replayable, so no event can exist) is
        // treated like a failed attempt and re-run fresh below.
        if (existing.result) {
          await this.repairAttempt(tenantId, existing.id, videoAssetId, internal);
          return this.getState(tenantId, videoAssetId);
        }
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

    // ---- 0a. Dependency gate, BEFORE any decode (fail fast) ------------
    // Vision-event conversion re-checks the cv module and fails closed, so
    // verify it while the job is still RUNNING: completing first and only
    // then discovering cv is disabled would strand a terminal SUCCEEDED
    // job with no recorded detection (terminal jobs never transition).
    const cvEnabled = await this.platformModules.isEnabledForTenant(
      tenantId,
      'cv',
    );
    if (!cvEnabled) {
      await failJob(
        CV_MODULE_DISABLED_ERROR_CODE,
        'The cv module is disabled for this tenant, so a detection cannot ' +
          'become a vision event — enable cv and retry',
      );
      return;
    }

    const computed = await this.computeDetection(
      tenantId,
      jobId,
      videoAssetId,
      internal,
    );
    if (!computed.ok) {
      await failJob(computed.errorCode, computed.errorMessage);
      return;
    }

    // ---- 5. Complete the job + convert to a VisionEvent -----------------
    // Completion is the TERMINAL transition, so it gets its own guard:
    // while the job is still RUNNING a failure here can (and must) be
    // recorded on the job itself.
    try {
      await this.inferenceJobs.complete(tenantId, jobId, {
        attempt,
        eventType: VisionEventType.PRODUCT_PICKUP,
        quantityDelta: 1,
        occurredAt: computed.occurredAt,
        detections: computed.detections,
        evidenceQuality: computed.evidenceQuality,
        modelKey: MATCHER_MODEL_KEY,
        modelVersion: MATCHER_MODEL_VERSION,
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
      return;
    }
    try {
      const converted = await this.inferenceJobs.toVisionEvent(
        tenantId,
        jobId,
      );
      // Narrow internal metadata write — see PickupDetectionRecord docs.
      await this.prisma.visionEvent.update({
        where: { id: converted.visionEvent.id },
        data: { metadata: computed.record as object },
      });
    } catch (error) {
      // The job is already terminal (SUCCEEDED), so failJob would be a
      // guaranteed conflict — the missing detection ITSELF marks the
      // attempt incomplete: detectForAsset REPAIRS a SUCCEEDED job whose
      // result survived (idempotent conversion replay + metadata rewrite
      // on the SAME job), so no second event is ever minted for this
      // pickup.
      this.logger.error(
        `Converting pickup result for asset ${videoAssetId} failed (a ` +
          `retry will repair this attempt in place): ${
            error instanceof Error ? error.message : 'unknown'
          }`,
      );
    }
  }

  /**
   * Recover a non-terminal attempt nothing would ever drive again. Pickup
   * jobs execute in-process right after creation — no worker claims them
   * later — so a crashed process leaves RUNNING-with-expired-lease and an
   * operator reclaim leaves QUEUED, both of them permanent without this.
   * The sweep is the same one start() runs before every claim; a job it
   * flips to QUEUED (or one already stranded there) is resumed here, and
   * start()'s QUEUED→RUNNING compare-and-set keeps a concurrent resume
   * race-safe. A RUNNING job whose lease is still live is genuinely in
   * flight and only reported.
   */
  private async resumeStrandedAttempt(
    tenantId: string,
    videoAssetId: string,
  ): Promise<PickupDetectionState> {
    await this.inferenceJobs.reclaimExpired(tenantId);
    const current = await this.latestJob(tenantId, videoAssetId);
    if (current && current.status === InferenceJobStatus.QUEUED) {
      await this.runJob(tenantId, current.id, videoAssetId).catch((error) => {
        // A concurrent request may have won the resume — start()'s CAS
        // surfaces that as a conflict; report the state either way.
        this.logger.error(
          `Resuming stranded pickup attempt for asset ${videoAssetId} ` +
            `faulted: ${error instanceof Error ? error.message : 'unknown'}`,
        );
      });
    }
    return this.getState(tenantId, videoAssetId);
  }

  /**
   * Repair a SUCCEEDED attempt stranded between its terminal transition
   * and the conversion/metadata write. toVisionEvent is idempotent (the
   * reserved `inference:{jobId}` key plus the already-linked replay), so
   * repairing can only re-surface the ORIGINAL event; the analysis is
   * then recomputed under the SAME job id to restore the metadata record
   * (artifacts replay under their original keys). Best-effort: any
   * failure just leaves the state for the next retry — a FRESH attempt is
   * never the fallback while a replayable result exists, because it would
   * convert under a new reserved key and mint a second pending event for
   * the same physical pickup.
   */
  private async repairAttempt(
    tenantId: string,
    jobId: string,
    videoAssetId: string,
    internal: NonNullable<
      Awaited<ReturnType<VideoAssetsRepository['findByIdInternal']>>
    >,
  ): Promise<void> {
    try {
      const converted = await this.inferenceJobs.toVisionEvent(
        tenantId,
        jobId,
      );
      if (
        internal.durationMs === null ||
        internal.width === null ||
        internal.height === null
      ) {
        // The event is converted; without probed metadata the record
        // cannot be rebuilt — never a reason to fork a fresh attempt.
        return;
      }
      const computed = await this.computeDetection(
        tenantId,
        jobId,
        videoAssetId,
        internal,
      );
      if (!computed.ok) {
        this.logger.warn(
          `Pickup metadata for asset ${videoAssetId} could not be ` +
            `recomputed (${computed.errorCode}); the converted event stands`,
        );
        return;
      }
      // Narrow internal metadata write — see PickupDetectionRecord docs.
      await this.prisma.visionEvent.update({
        where: { id: converted.visionEvent.id },
        data: { metadata: computed.record as object },
      });
    } catch (error) {
      this.logger.error(
        `Repairing pickup attempt ${jobId} for asset ${videoAssetId} ` +
          `failed (it stays repairable): ${
            error instanceof Error ? error.message : 'unknown'
          }`,
      );
    }
  }

  /**
   * The pure compute half of one attempt — library gates, decode, motion
   * analysis, reference matching, and artifact extraction — with NO job
   * lifecycle transitions. Shared by runJob and repairAttempt: artifact
   * idempotency keys derive from `jobId`, so a repair replays the first
   * attempt's artifacts instead of duplicating them. Callers guarantee
   * the asset's probed metadata (durationMs/width/height) and location
   * context are present.
   */
  private async computeDetection(
    tenantId: string,
    jobId: string,
    videoAssetId: string,
    internal: NonNullable<
      Awaited<ReturnType<VideoAssetsRepository['findByIdInternal']>>
    >,
  ): Promise<
    | { ok: false; errorCode: string; errorMessage: string }
    | {
        ok: true;
        record: PickupDetectionRecord;
        detections: { sku: string; confidence: number }[];
        evidenceQuality: EvidenceQuality;
        occurredAt: string;
      }
  > {
    // ---- 0b. Library gates, BEFORE any decode (fail fast) --------------
    const library = await this.referenceLibrary.load(tenantId);
    if (library.productsWithImages === 0) {
      return {
        ok: false,
        errorCode: 'REFERENCE_LIBRARY_EMPTY',
        errorMessage:
          'No catalog product has any reference images — upload them on ' +
          'the Reference library page',
      };
    }
    if (library.readyProducts === 0) {
      return {
        ok: false,
        errorCode: 'NO_INFERENCE_READY_SKUS',
        errorMessage:
          'No product meets the inference-ready floor of 5 reference images',
      };
    }
    const readyForStore = await this.referenceLibrary.readyProductIds(
      tenantId,
      internal.locationId!,
    );
    if (readyForStore.length === 0) {
      return {
        ok: false,
        errorCode: 'NO_INFERENCE_READY_SKUS',
        errorMessage: 'The selected store stocks no inference-ready SKUs',
      };
    }
    const readyIdSet = new Set(readyForStore);
    const references = library.references.filter((reference) =>
      readyIdSet.has(reference.productId),
    );

    const processingStartedAt = Date.now();

    // ---- 1. Decode analysis frames -------------------------------------
    const geometry = analysisGeometryFor(
      {
        durationMs: internal.durationMs!,
        width: internal.width!,
        height: internal.height!,
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
      return {
        ok: false,
        errorCode: 'ANALYSIS_DECODE_FAILED',
        errorMessage: 'The stored video could not be decoded for analysis',
      };
    }

    // ---- 2. Motion + removal analysis ----------------------------------
    const analysis = analyzePickup(frames, geometry);
    if (!analysis.pickupDetected || !analysis.window || !analysis.removalBox) {
      return {
        ok: false,
        errorCode: analysis.rejectReason ?? 'NO_PICKUP_DETECTED',
        errorMessage:
          analysis.rejectReason === 'NO_MOTION_EVENT'
            ? 'No motion event stands out from the clip — no pickup detected'
            : analysis.rejectReason === 'TOO_FEW_FRAMES'
              ? 'The clip is too short for the configured analysis rate'
              : 'Motion was found but nothing was removed from the scene',
      };
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
      width: internal.width!,
      height: internal.height!,
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

    const occurredAt = new Date(
      internal.createdAt.getTime() + peakTs,
    ).toISOString();
    // ALL top candidate scores travel to the result/event (validation
    // requirement) — capped at 10 of the contract's 20-candidate ceiling.
    const detections = candidates.slice(0, 10).map((candidate) => ({
      sku: candidate.sku,
      confidence: round4(candidate.score),
    }));
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
    return {
      ok: true,
      record,
      detections,
      evidenceQuality: matched
        ? top.score >= 0.8
          ? EvidenceQuality.HIGH
          : EvidenceQuality.MEDIUM
        : EvidenceQuality.LOW,
      occurredAt,
    };
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
