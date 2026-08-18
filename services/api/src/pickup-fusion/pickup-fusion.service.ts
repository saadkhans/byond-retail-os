import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  EvidenceSourceType,
  FusionPolicyResult,
  FusionRunScope,
  ProductStatus,
  VideoAssetStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { containsSensitiveFreeText } from '../video-ingest/media-safety';
import { VideoAssetsRepository } from '../video-ingest/video-assets.repository';
import { VideoAssetsService } from '../video-ingest/video-assets.service';
import { analysisGeometryFor } from '../pickup-detection/analysis/analysis-frames';
import { AnalysisFrame, BoundingBox } from '../pickup-detection/analysis/pickup-analyzer';
import { RgbImage, cropRgb } from '../pickup-detection/analysis/product-matcher';
import {
  PickupDetectionRecord,
  pickupSourceId,
  scaleBoxToSource,
} from '../pickup-detection/pickup-detection.service';
import { PickupDetectionConfig } from '../pickup-detection/pickup-detection.config';
import {
  BarcodeReader,
  CandidateFusion,
  CandidateSignal,
  ClassicalMatcher,
  ContextSignalProvider,
  FusedCandidate,
  InventoryValidator,
  ObjectDetector,
  OcrExecutionStatus,
  OcrReader,
  PickupDetectionOutput,
  PickupEventDetector,
  PickupMediaDecoder,
  QualifiedCrop,
  VisualRetriever,
  VlmStructuredResult,
  VlmVerdict,
} from './ports';
import {
  PICKUP_BARCODE_READER,
  PICKUP_CANDIDATE_FUSION,
  PICKUP_CLASSICAL_MATCHER,
  PICKUP_CONTEXT_PROVIDER,
  PICKUP_EVENT_DETECTOR,
  PICKUP_INVENTORY_VALIDATOR,
  PICKUP_MEDIA_DECODER,
  PICKUP_OBJECT_DETECTOR,
  PICKUP_OCR_READER,
  PICKUP_TX_RETRIEVER_FACTORY,
  PICKUP_VISUAL_RETRIEVER,
  TxScopedRetrieverFactory,
} from './pickup-fusion.tokens';
import { PICKUP_VLM_VERIFIER, SelectedVlmVerifier } from './vlm-provider';
import {
  meanBrightness,
  occlusionFraction,
  selectBestCrop,
  sharpness,
  textFieldOverlap,
} from './primitives';

export const FUSION_PIPELINE_VERSION = 'pickup-fusion-v2';

/** Marker pushed into evidence.detector.warnings when the selected-crop
 *  artifact could not be persisted — the run stays valid but the gap is
 *  VISIBLE in the evidence, never a silent missing-crop success. */
export const CROP_ARTIFACT_FAILED = 'CROP_ARTIFACT_FAILED';

/**
 * Collision-safe crop idempotency key (Codex P2). The key is derived
 * from CONTENT, never from a run ordinal: two overlapping runs of the
 * same asset used to read the same `count()` before either persisted,
 * collide on `fusion:<asset>:r<ordinal>`, and lose one crop artifact to
 * a swallowed fingerprint conflict. Here the key commits to everything
 * the extraction fingerprint checks — run scope, the replay window
 * identity (or whole-clip), and the crop's timestamp/box — so identical
 * content REPLAYS the same artifact (exact-retry idempotency, both runs
 * sharing one crop is correct) while ANY difference yields a different
 * key and conflicts become structurally impossible. The digest is split
 * with a letter guard so the key can never contain a 13+ digit run the
 * secret-free key screen could mistake for a card number.
 */
export function fusionCropIdempotencyKey(
  videoAssetId: string,
  runScope: 'WHOLE_CLIP' | 'REPLAY_WINDOW',
  window: { startMs: number; endMs: number; peakMs: number } | null,
  crop: { timestampMs: number; x: number; y: number; width: number; height: number },
): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        scope: runScope,
        window: window
          ? { s: window.startMs, p: window.peakMs, e: window.endMs }
          : null,
        crop,
      }),
    )
    .digest('hex');
  return (
    `fusion:${videoAssetId}:${runScope === 'REPLAY_WINDOW' ? 'rw' : 'wc'}` +
    `:h${digest.slice(0, 8)}x${digest.slice(8, 16)}`
  );
}

/** Quiet lead-in prepended to a replay window's detector slice: the
 *  classical detector models background from its earliest frames, so a
 *  slice starting mid-motion would see the burst as baseline and detect
 *  nothing. One second of warm-up before startMs (or one analysis-frame
 *  interval, whichever is larger); the tail stays tight so a later
 *  interaction cannot bleed into this window's detection. */
export const WINDOW_BASELINE_LEAD_IN_MS = 1000;

/** Bounds on the frame buffer a live window may hand to fusion — enough
 *  for ten minutes at the slowest legal sampling, small enough that a
 *  runaway session cannot flood one run. */
export const LIVE_WINDOW_MIN_FRAMES = 2;
export const LIVE_WINDOW_MAX_FRAMES = 600;
/** Live frames arrive pre-scaled by the sampler; anything beyond the
 *  asset path's own full-resolution cap (640) is refused. */
export const LIVE_FRAME_MAX_DIMENSION = 640;

/**
 * Classified markers persisted IN PLACE of frame-derived text that trips
 * the shared sensitive-text screen (media-safety). Fusion recognizes text
 * the pre-store screen never saw — OCR runs on a ZOOMED event-region
 * crop, and ZXing decodes QR payloads pixel screening cannot read — so
 * the same reject-on-write predicate gates this persistence boundary
 * too: the recognized text itself is never stored, only the marker.
 */
export const OCR_TEXT_SUPPRESSED = 'SENSITIVE_TEXT_SUPPRESSED';

/** Controlled reason recorded when a LIVE run's VLM invocation is
 *  blocked by the frame screen (Codex P1): FILE_REPLAY assets were
 *  pixel-screened at upload, but live RTSP frames are vetted only by
 *  this pipeline's own OCR sensitive-text pass — if that pass tripped
 *  or did not complete, the crop pixels are unvetted and must not be
 *  sent to any VLM (local included; MVP fails closed). */
/** Controlled reasons a LIVE run's VLM invocation is blocked by the
 *  per-crop screen (Codex P1, split so the review path can distinguish
 *  a screen that COULD NOT RUN from one that FOUND sensitive content):
 *  every VLM-bound crop (bestPre + each peak/post frame) must screen
 *  clean before the verifier may be invoked — local and cloud alike. */
export const LIVE_FRAME_SCREENING_UNAVAILABLE =
  'LIVE_FRAME_SCREENING_UNAVAILABLE';
export const LIVE_FRAME_SENSITIVE_CONTENT = 'LIVE_FRAME_SENSITIVE_CONTENT';
export const BARCODE_VALUE_SUPPRESSED = 'UNMATCHED_SCREENED';

/**
 * Shadow verdict rule, extracted for tests and shared by the run-time bake
 * AND the read-time recompute: each pipeline's BEST ANSWER is compared
 * against ground truth — v1's claimed SKU, v2's top fused candidate (or
 * the VLM's chosen SKU when it gave one). The POLICY communicates whether
 * v2 would have auto-proposed; the verdict measures ranking accuracy.
 */
export function shadowVerdict(
  predictedSku: string | null,
  truth: { eventKind: string; sku: string | null } | null,
): string | null {
  if (!truth) {
    return null;
  }
  if (truth.eventKind === 'NONE') {
    return predictedSku === null ? 'true_negative' : 'false_pickup';
  }
  if (predictedSku === null) {
    return 'missed';
  }
  return predictedSku === truth.sku ? 'correct' : 'incorrect';
}

/** v2's best answer: the VLM's MATCHED SKU when present, else fused #1.
 *  Accepts BOTH evidence generations because shadow verdicts are
 *  recomputed at read time over historical rows: the strict schema
 *  (verdict/selectedSku) and the retired pre-strict shape (choice). */
export function fusionPredictedSku(evidence: {
  vlm: {
    status: string | null;
    verdict?: string | null;
    selectedSku?: string | null;
    /** Legacy rows only — never written by the strict pipeline. */
    choice?: string | null;
  };
  fused: { sku: string }[];
}): string | null {
  if (evidence.vlm.status === 'VERDICT') {
    if (evidence.vlm.verdict === 'MATCH' && evidence.vlm.selectedSku) {
      return evidence.vlm.selectedSku;
    }
    if (
      evidence.vlm.verdict === undefined &&
      evidence.vlm.choice &&
      evidence.vlm.choice !== 'UNKNOWN' &&
      evidence.vlm.choice !== 'AMBIGUOUS'
    ) {
      return evidence.vlm.choice;
    }
  }
  return evidence.fused[0]?.sku ?? null;
}

/**
 * The POLICY decision derived from a validated verifier result — the VLM
 * never sets policy itself; this pure rule (extracted for tests) consumes
 * the structured result and decides. Shadow-phase safety over throughput:
 * every uncertainty signal (AMBIGUOUS, UNKNOWN against confident fusion,
 * INVALID_INPUT, requiresHumanReview, contradictions, disagreement with
 * fusion's top candidate) demotes to human review.
 */
export function policyFromVlmResult(
  result: VlmStructuredResult,
  fusionDecision: 'AUTO_PROPOSE' | 'NEEDS_VLM',
  topSku: string | null,
): { result: FusionPolicyResult; reason: string } {
  if (result.verdict === 'AMBIGUOUS') {
    return {
      result: FusionPolicyResult.NEEDS_HUMAN_REVIEW,
      reason: 'VLM judged the candidates AMBIGUOUS',
    };
  }
  if (result.verdict === 'INVALID_INPUT') {
    return {
      result: FusionPolicyResult.NEEDS_HUMAN_REVIEW,
      reason: 'VLM judged the evidence unusable (INVALID_INPUT)',
    };
  }
  if (result.verdict === 'UNKNOWN') {
    return fusionDecision === 'AUTO_PROPOSE'
      ? {
          result: FusionPolicyResult.NEEDS_HUMAN_REVIEW,
          reason: 'fusion was confident but the VLM saw no match — review',
        }
      : {
          result: FusionPolicyResult.UNKNOWN_PRODUCT,
          reason: 'VLM answered UNKNOWN',
        };
  }
  // MATCH — but a match alone does not auto-propose.
  if (result.requiresHumanReview) {
    return {
      result: FusionPolicyResult.NEEDS_HUMAN_REVIEW,
      reason: `VLM matched ${result.selectedSku} but flagged human review${
        result.reasonCodes.length > 0 ? ` (${result.reasonCodes.join(', ')})` : ''
      }`,
    };
  }
  if (result.contradictions.length > 0) {
    return {
      result: FusionPolicyResult.NEEDS_HUMAN_REVIEW,
      reason: `VLM matched ${result.selectedSku} but reported contradictions (${result.contradictions.join(', ')})`,
    };
  }
  if (topSku !== null && result.selectedSku === topSku) {
    return {
      result: FusionPolicyResult.AUTO_PROPOSE,
      reason: `VLM confirmed ${result.selectedSku} (visual ${result.visualSupport}, ocr ${result.ocrSupport}, barcode ${result.barcodeSupport})`,
    };
  }
  // The VLM chose a DIFFERENT supplied SKU than fusion's top — shadow
  // phase treats disagreement as review, never as an automatic override.
  return {
    result: FusionPolicyResult.NEEDS_HUMAN_REVIEW,
    reason: `VLM chose ${result.selectedSku} but fusion ranked ${topSku} first — review`,
  };
}

/**
 * Records a verifier verdict onto the evidence and derives the policy —
 * extracted for tests because it is the PERSISTENCE BOUNDARY for model
 * output. PAYMENT-SAFETY: verdict.errorDetail and verdict.rawPreview are
 * response-derived text (HTTP body previews, parser messages, raw
 * completion previews) that can echo OCR/frame content — potentially a
 * PAN/CVV — so they NEVER reach the evidence or the policy reason. Only
 * classified codes (the VlmVerdictStatus enum and the whitelist-validated
 * structured result) are persisted.
 */
export function applyVlmVerdictToEvidence(
  evidence: FusionEvidence,
  verdict: VlmVerdict,
  fusionDecision: 'AUTO_PROPOSE' | 'NEEDS_VLM',
  topSku: string | null,
  fallbackReason: string,
): void {
  evidence.vlm.status = verdict.status;
  evidence.vlm.modelKey = verdict.modelKey;
  evidence.vlm.latencyMs = verdict.latencyMs;
  if (verdict.status !== 'VERDICT' || verdict.result === null) {
    // Every classified failure (TIMEOUT / PROVIDER_* / INVALID_* /
    // MALFORMED_RESPONSE / MODEL_NOT_FOUND) routes to review — never a
    // failed store operation, never a silent pass-through. The reason is
    // built from the classified status alone; the free-text errorDetail
    // stays on the in-memory verdict (adapter logs safe fields only).
    evidence.policy = {
      result: FusionPolicyResult.NEEDS_HUMAN_REVIEW,
      reason: `VLM ${verdict.status} — ${fallbackReason}`,
    };
    return;
  }
  const result = verdict.result;
  evidence.vlm.verdict = result.verdict;
  evidence.vlm.selectedSku = result.selectedSku;
  evidence.vlm.visualSupport = result.visualSupport;
  evidence.vlm.ocrSupport = result.ocrSupport;
  evidence.vlm.barcodeSupport = result.barcodeSupport;
  evidence.vlm.reasonCodes = result.reasonCodes;
  evidence.vlm.contradictions = result.contradictions;
  evidence.vlm.requiresHumanReview = result.requiresHumanReview;
  // The VLM never sets policy — the pure policy rule decides from the
  // VALIDATED result.
  evidence.policy = policyFromVlmResult(result, fusionDecision, topSku);
}

export interface PolicyThresholds {
  autoThreshold: number;
  vlmLowBand: number;
  marginThreshold: number;
}

/**
 * The pure policy rule (requirement 12), extracted for direct testing:
 * confident+separated → AUTO_PROPOSE; hopeless → UNKNOWN_PRODUCT; the
 * uncertain band (including thin margins between similar candidates) →
 * NEEDS_VLM, which degrades to NEEDS_HUMAN_REVIEW when the verifier
 * cannot answer.
 */
export function decidePolicy(
  top: { fusedScore: number; scoreMargin: number } | undefined,
  thresholds: PolicyThresholds,
):
  | { result: 'AUTO_PROPOSE' | 'UNKNOWN_PRODUCT' | 'NEEDS_VLM'; reason: string } {
  if (!top) {
    return {
      result: 'UNKNOWN_PRODUCT',
      reason: 'no candidate produced any signal (empty reference library?)',
    };
  }
  if (
    top.fusedScore >= thresholds.autoThreshold &&
    top.scoreMargin >= thresholds.marginThreshold
  ) {
    return {
      result: 'AUTO_PROPOSE',
      reason: `fused ${top.fusedScore} >= ${thresholds.autoThreshold} with margin ${top.scoreMargin}`,
    };
  }
  if (top.fusedScore < thresholds.vlmLowBand) {
    return {
      result: 'UNKNOWN_PRODUCT',
      reason: `fused ${top.fusedScore} below the uncertain band`,
    };
  }
  return {
    result: 'NEEDS_VLM',
    reason: `fused ${top.fusedScore} in uncertain band or thin margin ${top.scoreMargin}`,
  };
}

interface StageTiming {
  stage: string;
  adapterKey: string;
  version: string;
  ms: number;
  note?: string;
}

/** The per-stage timing wrapper both pipeline entry points share. */
type TimedFn = <T>(
  stage: string,
  adapter: { adapterKey: string; version: string },
  work: () => Promise<T>,
  note?: string,
) => Promise<T>;

/** Safe-descriptor evidence (JSON column) — NEVER pixels or paths. */
export interface FusionEvidence {
  pipelineVersion: string;
  stages: StageTiming[];
  detector: {
    adapterKey: string;
    warnings: string[];
    events: {
      kind: string;
      startMs: number;
      peakMs: number;
      endMs: number;
      trackId: string;
      shelfZoneId: string;
      box: BoundingBox;
    }[];
    tracks: { trackId: string; label: string; points: { timestampMs: number; box: BoundingBox }[] }[];
    yoloReady: boolean;
  };
  crops: {
    phase: string;
    timestampMs: number;
    box: BoundingBox;
    quality: { sharpness: number; occlusion: number; brightness: number };
    selected: boolean;
  }[];
  cropArtifactId: string | null;
  /** Unmatched decode values that trip the sensitive-text screen are
   *  replaced by BARCODE_VALUE_SUPPRESSED before persistence. */
  barcode: { results: { value: string; format: string }[]; matchedSku: string | null };
  ocr: {
    rawText: string;
    normalizedText: string;
    languages: string[];
    perProduct: { sku: string; score: number }[];
    /** Classified execution marker (adapters/text-signals): anything but
     *  'OK' means the OCR stage did not complete, so empty text is NOT a
     *  verified no-text pass — AUTO_PROPOSE demotes to review. 'NOT_RUN'
     *  is the pre-stage placeholder (early exits before OCR). */
    status: OcrExecutionStatus | 'NOT_RUN';
    /** Set (with both texts emptied) when the recognized frame text
     *  tripped the sensitive-text screen — the text is never stored. */
    screened?: typeof OCR_TEXT_SUPPRESSED;
  };
  retrieval: { modelKey: string; modelVersion: string; indexed: number; candidates: { sku: string; score: number }[] };
  classical: { candidates: { sku: string; score: number }[] };
  context: { candidates: { sku: string; score: number; detail?: string }[] };
  fused: FusedCandidate[];
  inventoryValidation: { sku: string; verdict: string; onHandQuantity: number | null }[];
  vlm: {
    invoked: boolean;
    reason: string;
    provider: string;
    mode: string;
    status: string | null;
    /** The validated STRICT schema fields (null until a VERDICT arrives). */
    verdict: string | null;
    selectedSku: string | null;
    visualSupport: string | null;
    ocrSupport: string | null;
    barcodeSupport: string | null;
    reasonCodes: string[];
    contradictions: string[];
    requiresHumanReview: boolean | null;
    /** Which reference image each candidate was shown (deterministic). */
    references?: { sku: string; referenceImageId: string | null }[];
    modelKey: string | null;
    latencyMs: number | null;
    // PAYMENT-SAFETY: no response-derived text (rawPreview, errorDetail,
    // parser messages, HTTP body previews) is ever persisted here — a
    // malformed completion or provider error body can echo OCR/frame
    // content, which may contain a PAN/CVV. Only classified codes
    // (VlmVerdictStatus and the whitelist-validated result fields above)
    // travel to the PickupFusionRun row.
  };
  policy: { result: FusionPolicyResult; reason: string };
  shadow: {
    classicalV1: { predictedSku: string | null; matchScore: number | null; peakMs: number | null } | null;
    groundTruth: { sku: string | null; eventKind: string; actualTimestampMs: number | null } | null;
    v1Verdict: string | null;
    v2Verdict: string | null;
  };
  /** Phase 12: set when the camera replay runtime scoped this run to ONE
   *  extracted event window — recorded so the run is auditable as "this
   *  window's interaction", never the whole clip. Timestamps only. */
  replayWindow?: { startMs: number; endMs: number; peakMs: number };
  /** Phase 13 — set on LIVE_WINDOW runs: the live session whose sampled
   *  frames this run analyzed (no video asset exists for live runs). */
  liveSessionId?: string;
}

@Injectable()
export class PickupFusionService {
  private readonly logger = new Logger(PickupFusionService.name);
  private readonly autoThreshold: number;
  private readonly vlmLowBand: number;
  private readonly marginThreshold: number;
  private readonly vlmTimeoutMs: number;

  private readonly vlmEnabled: boolean;
  private readonly vlmProvider: 'local' | 'anthropic';
  private readonly vlmMode: 'UNCERTAIN_ONLY' | 'VALIDATION_ALWAYS';

  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: VideoAssetsRepository,
    private readonly videoAssets: VideoAssetsService,
    private readonly detectionConfig: PickupDetectionConfig,
    // Every fusion stage is a PORT injected by token (bound to concrete
    // adapters in the module) — the service never sees a vendor class.
    // Media decoding included: the service passes STORAGE KEYS; only the
    // adapter knows how a key becomes local pixels.
    @Inject(PICKUP_MEDIA_DECODER)
    private readonly media: PickupMediaDecoder,
    @Inject(PICKUP_EVENT_DETECTOR)
    private readonly detector: PickupEventDetector,
    @Inject(PICKUP_OBJECT_DETECTOR)
    private readonly yolo: ObjectDetector,
    @Inject(PICKUP_BARCODE_READER)
    private readonly barcodeReader: BarcodeReader,
    @Inject(PICKUP_OCR_READER)
    private readonly ocrReader: OcrReader,
    @Inject(PICKUP_VISUAL_RETRIEVER)
    private readonly retriever: VisualRetriever,
    @Inject(PICKUP_CLASSICAL_MATCHER)
    private readonly classical: ClassicalMatcher,
    @Inject(PICKUP_CONTEXT_PROVIDER)
    private readonly contextProvider: ContextSignalProvider,
    @Inject(PICKUP_CANDIDATE_FUSION)
    private readonly fusion: CandidateFusion,
    // The SELECTED verifier port (vlm-provider registry, keyed by
    // PICKUP_VLM_PROVIDER) — the service never sees a concrete vendor.
    @Inject(PICKUP_VLM_VERIFIER)
    private readonly selectedVlm: SelectedVlmVerifier,
    @Inject(PICKUP_INVENTORY_VALIDATOR)
    private readonly inventoryValidator: InventoryValidator,
    // Module-provided factory for the tx-scoped retriever the atomic
    // rebuild needs (tx clients cannot travel through DI).
    @Inject(PICKUP_TX_RETRIEVER_FACTORY)
    private readonly txRetrieverFactory: TxScopedRetrieverFactory,
    config: ConfigService,
  ) {
    const num = (key: string, fallback: number) => {
      const value = Number(config.get<string>(key));
      return Number.isFinite(value) ? value : fallback;
    };
    // Policy thresholds are BOUNDED at startup: a typo like
    // AUTO_THRESHOLD=-1 or a negative margin would let negligible
    // candidates auto-propose, silently bypassing the uncertainty band.
    // Fail boot loudly instead of running with an unsafe policy.
    const bounded = (key: string, fallback: number, min: number, max: number) => {
      const value = num(key, fallback);
      if (value < min || value > max) {
        throw new Error(
          `${key}=${value} is outside its safe range [${min}, ${max}]`,
        );
      }
      return value;
    };
    this.autoThreshold = bounded('PICKUP_FUSION_AUTO_THRESHOLD', 0.42, 0.05, 1);
    this.vlmLowBand = bounded('PICKUP_FUSION_VLM_LOW', 0.22, 0, 1);
    this.marginThreshold = bounded('PICKUP_FUSION_MARGIN', 0.08, 0, 1);
    if (this.vlmLowBand > this.autoThreshold) {
      throw new Error(
        'PICKUP_FUSION_VLM_LOW must not exceed PICKUP_FUSION_AUTO_THRESHOLD',
      );
    }
    this.vlmEnabled =
      (config.get<string>('PICKUP_VLM_ENABLED') ?? '').trim().toLowerCase() ===
      'true';
    // Provider identity comes from the registry that selected the port —
    // one source of truth for the PICKUP_VLM_PROVIDER decision.
    this.vlmProvider = this.selectedVlm.provider;
    // Local default is 60 s: a 7B vision model cold-loading into VRAM can
    // legitimately need > 30 s on its first generation. Bounded like the
    // policy thresholds (1 s .. 10 min): zero/negative would abort every
    // verification before it starts, and an extra digit would let a
    // stalled provider pin a fusion run for hours.
    this.vlmTimeoutMs = bounded(
      'PICKUP_VLM_TIMEOUT_MS',
      this.vlmProvider === 'local' ? 60_000 : 30_000,
      1_000,
      600_000,
    );
    this.vlmMode =
      config.get<string>('PICKUP_VLM_MODE') === 'VALIDATION_ALWAYS'
        ? 'VALIDATION_ALWAYS'
        : 'UNCERTAIN_ONLY';
  }

  /** The configured verifier PORT — LOCAL (Ollama) by default; no paid
   *  API in local mode and no API key requirement. Selection lives in
   *  the vlm-provider registry, never here. */
  private get vlm() {
    return this.selectedVlm.verifier;
  }

  /** Readiness surface for the UI panel — provider-neutral shape mapped
   *  by the registry. */
  async vlmReadiness() {
    const readiness = await this.selectedVlm.readiness();
    return {
      enabled: this.vlmEnabled,
      provider: this.vlmProvider,
      mode: this.vlmMode,
      timeoutMs: this.vlmTimeoutMs,
      model: readiness.model,
      baseUrl: readiness.baseUrl,
      serverReachable: readiness.serverReachable,
      modelAvailable: readiness.modelAvailable,
      availableModels: readiness.availableModels,
      // MODEL INSTALLED ≠ inference-ready: READY here means the model is
      // present; the first generation may still be slow (cold VRAM load).
      // lastInference is the honest warm-up signal.
      classification: readiness.classification,
      lastInference: readiness.lastInference,
      ready:
        this.vlmEnabled && readiness.serverReachable && readiness.modelAvailable,
    };
  }

  /**
   * Ensure (or fully rebuild) the reference-embedding index for the
   * current embedding model.
   *
   * A rebuild is delete + reconstruct in ONE interactive transaction, so
   * the swap is atomic: a concurrent fusion run keeps reading the OLD
   * generation until commit, and any failure rolls back with the old
   * index intact — never a partial/empty live index. The adapter must
   * observe the transaction's deletes, so a tx-scoped instance of the
   * SAME retriever adapter does the reconstruction (Prisma tx clients
   * cannot travel through DI). Volume note: reference libraries are
   * catalog-scale (the same assumption exact in-process NN retrieval
   * already makes), so the decode work fits the bounded tx budget.
   */
  async reindexReferenceIndex(tenantId: string, rebuild: boolean) {
    const result = rebuild
      ? await this.prisma.$transaction(
          async (tx) => {
            const scoped = this.txRetrieverFactory(
              tx as unknown as PrismaService,
            );
            await tx.productReferenceEmbedding.deleteMany({
              where: { tenantId, modelKey: scoped.embeddingModelKey },
            });
            const rebuilt = await scoped.ensureIndex(tenantId);
            // STRICT rebuild: every active reference was just deleted, so
            // the reconstruction must re-embed all of them. ensureIndex's
            // lenient per-image skip (fine for incremental backfill) would
            // otherwise COMMIT an index that silently dropped the vector
            // of a temporarily unreadable reference — throw instead, so
            // the rollback keeps the old index intact.
            if (rebuilt.indexed < rebuilt.total) {
              throw new ConflictException(
                `rebuild aborted: ${rebuilt.total - rebuilt.indexed} of ` +
                  `${rebuilt.total} active reference images could not be ` +
                  'reconstructed — the previous index was kept',
              );
            }
            return rebuilt;
          },
          { timeout: PickupFusionService.REINDEX_REBUILD_TX_TIMEOUT_MS },
        )
      : await this.retriever.ensureIndex(tenantId);
    return {
      modelKey: this.retriever.embeddingModelKey,
      modelVersion: this.retriever.embeddingModelVersion,
      rebuilt: rebuild,
      ...result,
    };
  }

  /** Rebuild decodes every reference image inside the swap transaction —
   *  generous but bounded, so a wedged decode cannot pin a tx forever. */
  private static readonly REINDEX_REBUILD_TX_TIMEOUT_MS = 120_000;


  /** Window-scoped detection shared by BOTH entry points (Phase 12/13
   *  semantics, byte-identical): slice detector input with a quiet
   *  lead-in, detect, overlap-filter to the window, and fall back to
   *  the full frame set (still overlap-bound) when the tight slice
   *  rates as no-event. Populates evidence.detector; returns the
   *  scoped events plus the FINAL detection's own warnings (the
   *  no-event policy branch reads those, not the accumulated list). */
  private async detectScopedToWindow(ctx: {
    evidence: FusionEvidence;
    timed: TimedFn;
    frames: AnalysisFrame[];
    geometry: { width: number; height: number };
    source: { width: number; height: number };
    window: { startMs: number; endMs: number; peakMs: number } | null;
    frameMarginMs: number;
  }): Promise<{
    scopedEvents: PickupDetectionOutput['events'];
    finalWarnings: string[];
  }> {
      const leadIn = Math.max(WINDOW_BASELINE_LEAD_IN_MS, ctx.frameMarginMs);
      const framesForDet = ctx.window
        ? ctx.frames.filter(
            (frame) =>
              frame.timestampMs >= ctx.window!.startMs - leadIn &&
              frame.timestampMs <= ctx.window!.endMs + ctx.frameMarginMs,
          )
        : ctx.frames;
      let detection = await ctx.timed('event-detection', this.detector, () =>
        this.detector.detect(framesForDet, ctx.geometry, ctx.source),
      );
      ctx.evidence.detector.warnings = detection.warnings;
      // Part 2, belt-and-braces: keep only detector events that overlap
      // the window, best overlap first (ties: earliest). A non-overlapping
      // window leaves an empty list and follows the existing no-event path
      // below unchanged.
      const overlapWith = (event: { startMs: number; endMs: number }): number =>
        Math.min(event.endMs, ctx.window!.endMs) -
        Math.max(event.startMs, ctx.window!.startMs);
      const scopeToWindow = (
        events: PickupDetectionOutput['events'],
      ): PickupDetectionOutput['events'] =>
        events
          .filter((event) => overlapWith(event) >= 0)
          .sort(
            (a, b) => overlapWith(b) - overlapWith(a) || a.startMs - b.startMs,
          );
      let scopedEvents = ctx.window ? scopeToWindow(detection.events) : detection.events;
      if (
        ctx.window &&
        scopedEvents.length === 0 &&
        framesForDet.length < ctx.frames.length
      ) {
        // The classical detector rates a burst against the QUIET context
        // around it (background windows, peak-to-baseline ratio) — a tight
        // slice that is mostly burst can rate as no-event even though the
        // interaction is real. Fall back to full-clip detection while the
        // overlap filter above KEEPS the window binding: only an event
        // overlapping THIS window can be chosen, so a second window can
        // never inherit another window's peak. The fallback is recorded in
        // the evidence for auditability.
        const fallback = await ctx.timed(
          'event-detection-fallback',
          this.detector,
          () => this.detector.detect(ctx.frames, ctx.geometry, ctx.source),
        );
        ctx.evidence.detector.warnings = [
          ...detection.warnings,
          'WINDOW_LOCAL_DETECTION_EMPTY',
          ...fallback.warnings,
        ];
        detection = fallback;
        scopedEvents = scopeToWindow(fallback.events);
      }
      ctx.evidence.detector.events = scopedEvents.map((event) => ({
        ...event,
        box: scaleBoxToSource(event.box, ctx.geometry, ctx.source),
      }));
      ctx.evidence.detector.tracks = detection.tracks.slice(0, 6).map((track) => ({
        trackId: track.trackId,
        label: track.label,
        points: track.boxes.map((box) => ({
          timestampMs: box.timestampMs,
          box: scaleBoxToSource(box.box, ctx.geometry, ctx.source),
        })),
      }));
      return { scopedEvents, finalWarnings: detection.warnings };
  }

  /** Per-stage timing wrapper shared by both pipeline entry points. */
  private makeTimed(stages: StageTiming[]): TimedFn {
    return async <T>(
      stage: string,
      adapter: { adapterKey: string; version: string },
      work: () => Promise<T>,
      note?: string,
    ): Promise<T> => {
      const stageStart = Date.now();
      try {
        return await work();
      } finally {
        stages.push({
          stage,
          adapterKey: adapter.adapterKey,
          version: adapter.version,
          ms: Date.now() - stageStart,
          ...(note ? { note } : {}),
        });
      }
    };
  }

  /** The empty evidence document both entry points start from. */
  private async newEvidenceSkeleton(
    stages: StageTiming[],
  ): Promise<FusionEvidence> {
    return {
      pipelineVersion: FUSION_PIPELINE_VERSION,
      stages,
      detector: {
        adapterKey: this.detector.adapterKey,
        warnings: [],
        events: [],
        tracks: [],
        yoloReady: await this.yolo.checkReady(),
      },
      crops: [],
      cropArtifactId: null,
      barcode: { results: [], matchedSku: null },
      ocr: {
        rawText: '',
        normalizedText: '',
        languages: [],
        perProduct: [],
        status: 'NOT_RUN',
      },
      retrieval: {
        modelKey: this.retriever.embeddingModelKey,
        modelVersion: this.retriever.embeddingModelVersion,
        indexed: 0,
        candidates: [],
      },
      classical: { candidates: [] },
      context: { candidates: [] },
      fused: [],
      inventoryValidation: [],
      vlm: {
        invoked: false,
        reason: 'not-needed',
        provider: this.vlmProvider,
        mode: this.vlmMode,
        status: null,
        verdict: null,
        selectedSku: null,
        visualSupport: null,
        ocrSupport: null,
        barcodeSupport: null,
        reasonCodes: [],
        contradictions: [],
        requiresHumanReview: null,
        modelKey: null,
        latencyMs: null,
      },
      policy: { result: FusionPolicyResult.FAILED, reason: 'not-run' },
      shadow: { classicalV1: null, groundTruth: null, v1Verdict: null, v2Verdict: null },
    };
  }

  /**
   * One SHADOW run of pickup-fusion-v2 over a validated test video.
   * Records a PickupFusionRun row and NOTHING else — no vision events, no
   * inventory writes, no session/billing coupling (requirements 13/15).
   */
  async run(
    tenantId: string,
    videoAssetId: string,
    options?: {
      /** Phase 12 camera replay: scope this run to ONE extracted event
       *  window. Detection still runs normally; its events are then
       *  filtered to the window (best overlap first) so the pipeline —
       *  crops, signals, VLM, policy — describes that window's
       *  interaction. No window ⇒ behavior is byte-for-byte unchanged. */
      window?: { startMs: number; endMs: number; peakMs: number };
    },
  ): Promise<{ runId: string }> {
    const startedAt = Date.now();
    const stages: StageTiming[] = [];
    const timed = this.makeTimed(stages);

    const internal = await this.repository.findByIdInternal(tenantId, videoAssetId);
    if (!internal || internal.deletedAt !== null) {
      throw new NotFoundException('Video asset not found');
    }
    if (
      internal.status !== VideoAssetStatus.VALIDATED &&
      internal.status !== VideoAssetStatus.READY
    ) {
      throw new ConflictException('Fusion needs a VALIDATED asset');
    }
    if (
      internal.durationMs === null ||
      internal.width === null ||
      internal.height === null
    ) {
      throw new ConflictException('Asset metadata is incomplete');
    }
    const source = { width: internal.width, height: internal.height };
    // Narrowed ONCE after the metadata guard: property narrowing does not
    // survive into the decode closures below.
    const durationMs = internal.durationMs;

    const evidence = await this.newEvidenceSkeleton(stages);

    try {
      // ---- decode (edge-local) ----------------------------------------
      const geometrySmall = analysisGeometryFor(
        { durationMs: internal.durationMs, width: source.width, height: source.height, fps: internal.fps ?? 30 },
        this.detectionConfig.analysisWidth,
      );
      const framesSmall = await timed(
        'decode-analysis',
        this.media,
        () =>
          this.media.decodeAnalysisFrames(
            internal.storageKey,
            this.detectionConfig.analysisFps,
            geometrySmall,
            durationMs,
          ),
      );
      // Full-resolution decoding happens PER TIMESTAMP (below, after the
      // detector has chosen the instants that matter): a whole-clip decode
      // at full resolution overflows the decoder's bounded output budget
      // for ordinary 20-30 s clips, failing supported inputs.
      const geometryFull = analysisGeometryFor(
        { durationMs: internal.durationMs, width: source.width, height: source.height, fps: internal.fps ?? 30 },
        Math.min(source.width, 640),
      );

      // ---- detection + tracking ---------------------------------------
      // Phase 12 replay-window scoping, part 1 (Codex P1): the DETECTOR
      // INPUT is constrained to the window BEFORE detection runs, so each
      // window finds its own LOCAL motion peak. Without this, a clip with
      // two interactions would hand every window the same global peak.
      // The slice is ASYMMETRIC: the classical detector models background
      // from its earliest frames, so a slice that begins mid-motion sees
      // the burst AS the baseline and reports nothing — the window gets a
      // quiet LEAD-IN for warm-up, while the tail keeps only one frame
      // interval so a later interaction never bleeds in. The overlap
      // filter below still binds the chosen event to the window itself.
      const window = options?.window ?? null;
      if (window) {
        evidence.replayWindow = { ...window };
      }
      const { scopedEvents, finalWarnings } = await this.detectScopedToWindow({
        evidence,
        timed,
        frames: framesSmall,
        geometry: geometrySmall,
        source,
        window,
        frameMarginMs: 1000 / this.detectionConfig.analysisFps,
      });

      if (scopedEvents.length === 0) {
        const cameraMotion = finalWarnings.includes('CAMERA_MOTION_SUSPECTED');
        evidence.policy = cameraMotion
          ? {
              result: FusionPolicyResult.NEEDS_HUMAN_REVIEW,
              reason: 'camera motion suspected — footage needs human eyes',
            }
          : {
              result: FusionPolicyResult.UNKNOWN_PRODUCT,
              reason: `no pickup event proposed (${finalWarnings.join(',') || 'quiet clip'})`,
            };
        return this.persist(tenantId, { videoAssetId }, evidence, startedAt);
      }

      const primary = scopedEvents[0];

      // ---- multi-frame crop selection (req 4) --------------------------
      // Only the instants the pipeline actually consumes are decoded at
      // full resolution — the quiet baseline plus the pre/peak/post
      // candidates. Each is one ffmpeg seek producing one frame, so the
      // full-res decode stays a handful of frames for any supported clip
      // length or aspect (never the whole clip at analysis fps).
      const fullFrameCache = new Map<number, AnalysisFrame>();
      const fullFrameAt = async (ms: number): Promise<AnalysisFrame> => {
        const clamped = Math.max(0, Math.min(ms, durationMs - 1));
        const cached = fullFrameCache.get(clamped);
        if (cached) {
          return cached;
        }
        // The returned frame's timestampMs is the instant that ACTUALLY
        // decoded — a tail-of-clip fallback reports the earlier seek, and
        // the evidence below carries that true timestamp.
        const frame = await this.media.decodeFrameAt(
          internal.storageKey,
          clamped,
          geometryFull,
        );
        fullFrameCache.set(clamped, frame);
        return frame;
      };
      const fullBox = scaleBoxToSource(primary.box, geometrySmall, {
        width: geometryFull.width,
        height: geometryFull.height,
      });
      const candidateInstants: { phase: 'pre' | 'peak' | 'post'; ms: number }[] = [
        { phase: 'pre', ms: Math.max(0, primary.startMs - 1200) },
        { phase: 'pre', ms: Math.max(0, primary.startMs - 600) },
        { phase: 'pre', ms: Math.max(0, primary.startMs - 200) },
        { phase: 'peak', ms: primary.peakMs },
        { phase: 'post', ms: Math.min(internal.durationMs - 1, primary.endMs + 600) },
      ];
      const quietFull = (
        await timed(
          'decode-full',
          this.media,
          async () => {
            // Prefetch every consumed instant while the stage is timed.
            for (const { ms } of candidateInstants) {
              await fullFrameAt(ms);
            }
            return fullFrameAt(0);
          },
          'per-timestamp seeks',
        )
      ).rgb;
      const cropFrames = await Promise.all(
        candidateInstants.map(({ ms }) => fullFrameAt(ms)),
      );
      const crops: QualifiedCrop[] = candidateInstants.map(({ phase }, instant) => {
        const frame = cropFrames[instant];
        const image = cropRgb(
          { width: geometryFull.width, height: geometryFull.height, rgb: frame.rgb },
          fullBox,
        );
        return {
          phase,
          timestampMs: frame.timestampMs,
          box: fullBox,
          image,
          quality: {
            sharpness: Math.round(sharpness(image) * 100) / 100,
            occlusion:
              Math.round(
                occlusionFraction(frame.rgb, quietFull, geometryFull, fullBox) * 100,
              ) / 100,
            brightness: Math.round(meanBrightness(image)),
          },
        };
      });
      // Best PRE crop: sharpest with least occlusion (selectBestCrop).
      const preCrops = crops.filter((crop) => crop.phase === 'pre');
      const bestPre = selectBestCrop(preCrops);
      evidence.crops = crops.map((crop) => ({
        phase: crop.phase,
        timestampMs: crop.timestampMs,
        box: crop.box,
        quality: crop.quality,
        selected: crop === bestPre,
      }));

      // Persist the selected crop as a real artifact (audited, idempotent).
      // The key is CONTENT-derived (fusionCropIdempotencyKey) — never a
      // run ordinal that overlapping runs could race: identical content
      // replays one shared artifact; different windows/detections get
      // their own keys and cannot conflict or steal each other's crop.
      try {
        const sourceBox = scaleBoxToSource(primary.box, geometrySmall, source);
        const cropRequest = {
          timestampMs: Math.max(
            0,
            Math.min(bestPre.timestampMs, internal.durationMs - 1),
          ),
          x: sourceBox.x,
          y: sourceBox.y,
          width: sourceBox.width,
          height: sourceBox.height,
        };
        const artifact = await this.videoAssets.createCrop(tenantId, videoAssetId, {
          ...cropRequest,
          reason: 'PRODUCT_PICKUP',
          idempotencyKey: fusionCropIdempotencyKey(
            videoAssetId,
            window ? 'REPLAY_WINDOW' : 'WHOLE_CLIP',
            window,
            cropRequest,
          ),
        });
        evidence.cropArtifactId = artifact.artifact.id;
      } catch (error) {
        // A failure here can no longer be a same-key fingerprint conflict
        // (the key commits to the fingerprint) — whatever it is, surface
        // it IN THE EVIDENCE instead of a silent missing-crop success.
        evidence.detector.warnings = [
          ...evidence.detector.warnings,
          CROP_ARTIFACT_FAILED,
        ];
        this.logger.warn(
          `fusion crop artifact failed: ${error instanceof Error ? error.message : 'unknown'}`,
        );
      }

      const peakFullFrame = await fullFrameAt(primary.peakMs);
      await this.runSignalStages(tenantId, {
        evidence,
        timed,
        crops,
        bestPre,
        peakFrame: {
          image: {
            width: geometryFull.width,
            height: geometryFull.height,
            rgb: peakFullFrame.rgb,
          },
          timestampMs: peakFullFrame.timestampMs,
        },
        shelfZoneId: primary.shelfZoneId ?? null,
        store: {
          locationId: internal.locationId,
          unitId: internal.unitId,
          deviceId: internal.deviceId,
        },
      });
      return this.persist(tenantId, { videoAssetId }, evidence, startedAt);
    } catch (error) {
      this.logger.error(
        `fusion run failed: ${error instanceof Error ? error.message : 'unknown'}`,
      );
      evidence.policy = {
        result: FusionPolicyResult.FAILED,
        reason: 'pipeline stage failed — see server logs; retry is safe',
      };
      return this.persist(tenantId, { videoAssetId }, evidence, startedAt);
    }
  }


  /**
   * The SHARED signal pipeline both entry points run after crop
   * selection: catalog snapshot, barcode, OCR, retrieval, classical,
   * context, fusion, READ-ONLY inventory validation, policy and the
   * optional VLM check, and the fail-closed demotions. Extracted
   * verbatim from run() for Phase 13 so live-window runs execute the
   * IDENTICAL stages on sampled frames; mutates ctx.evidence in place
   * and throws to the caller's catch on stage failure.
   */
  private async runSignalStages(
    tenantId: string,
    ctx: {
      evidence: FusionEvidence;
      timed: TimedFn;
      crops: QualifiedCrop[];
      bestPre: QualifiedCrop;
      peakFrame: { image: RgbImage; timestampMs: number };
      shelfZoneId: string | null;
      store: {
        locationId: string | null;
        unitId: string | null;
        deviceId: string | null;
      };
    },
  ): Promise<void> {
      // ---- catalog snapshot -------------------------------------------
      // ACTIVE products only — the same rule the reference library
      // enforces. A DRAFT/DISCONTINUED/ARCHIVED product must never become
      // a fusion candidate (via its barcode or OCR-matched name) and be
      // imported into a journey; the weak context prior alone is not a
      // gate.
      const products = await this.prisma.product.findMany({
        where: { tenantId, status: ProductStatus.ACTIVE },
        select: {
          id: true,
          sku: true,
          name: true,
          nameArabic: true,
          aliases: true,
          description: true,
          barcodes: { select: { value: true } },
        },
      });
      const productMeta = new Map(
        products.map((product) => [product.id, { sku: product.sku, name: product.name }]),
      );

      // ---- barcode (req 5) --------------------------------------------
      const barcodeResults = await ctx.timed('barcode', this.barcodeReader, () =>
        this.barcodeReader.read([
          { image: ctx.bestPre.image, timestampMs: ctx.bestPre.timestampMs },
          {
            image: ctx.peakFrame.image,
            timestampMs: ctx.peakFrame.timestampMs,
          },
        ]),
      );
      const barcodeSignals: CandidateSignal[] = [];
      const matchedBarcodeValues = new Set<string>();
      for (const result of barcodeResults) {
        const owner = products.find((product) =>
          product.barcodes.some((barcode) => barcode.value === result.value),
        );
        if (owner) {
          matchedBarcodeValues.add(result.value);
          barcodeSignals.push({
            productId: owner.id,
            sku: owner.sku,
            score: 1,
            detail: `barcode:${result.value}`,
          });
          ctx.evidence.barcode.matchedSku = owner.sku;
        }
      }
      // PAYMENT-SAFETY: ZXing also decodes QR codes, whose payloads are
      // arbitrary world-supplied free text (payment QRs, token-bearing
      // URLs) that the pre-store pixel screen cannot read. Catalog-matched
      // values are product identifiers and persist verbatim; an unmatched
      // value must pass the shared sensitive-text screen or only its
      // format plus a classified marker reaches the durable evidence row.
      ctx.evidence.barcode.results = barcodeResults.map((result) => ({
        value:
          matchedBarcodeValues.has(result.value) ||
          !containsSensitiveFreeText(result.value)
            ? result.value
            : BARCODE_VALUE_SUPPRESSED,
        format: result.format,
      }));

      // ---- OCR (req 6) -------------------------------------------------
      const ocr = await ctx.timed('ocr', this.ocrReader, () =>
        this.ocrReader.recognize(ctx.bestPre.image),
      );
      // The classified execution marker persists as-is (code only, never
      // raw error text): a timeout/crash must stay distinguishable from a
      // successful no-text pass in the durable ctx.evidence.
      ctx.evidence.ocr.status = ocr.status;
      // PAYMENT-SAFETY: fusion OCRs a ZOOMED event-region crop at its own
      // timestamps, so it can recover text the pre-store full-frame screen
      // never resolved (a card visible in the shelf crop). The recognized
      // text is gated by the SAME predicate the pre-store screen uses
      // before it may touch the durable evidence row — on a trip both
      // strings stay empty and only a classified marker persists, so the
      // (empty) evidence text is also all that ever travels to the VLM.
      // The derived numeric perProduct scores below remain safe to keep.
      if (
        containsSensitiveFreeText(ocr.rawText) ||
        containsSensitiveFreeText(ocr.normalizedText)
      ) {
        ctx.evidence.ocr.screened = OCR_TEXT_SUPPRESSED;
      } else {
        ctx.evidence.ocr.rawText = ocr.rawText.slice(0, 500);
        ctx.evidence.ocr.normalizedText = ocr.normalizedText.slice(0, 500);
      }
      ctx.evidence.ocr.languages = ocr.languages;
      const ocrSignals: CandidateSignal[] = [];
      if (ocr.normalizedText.length >= 3) {
        for (const product of products) {
          const fields = [
            product.name,
            product.sku.replace(/-/g, ' '),
            product.nameArabic ?? '',
            product.description ?? '',
            ...product.aliases,
            ...product.barcodes.map((barcode) => barcode.value),
          ].filter((field) => field.length > 0);
          const score = Math.max(
            0,
            ...fields.map((field) => textFieldOverlap(ocr.normalizedText, field)),
          );
          if (score > 0.3) {
            ocrSignals.push({ productId: product.id, sku: product.sku, score });
          }
        }
      }
      ctx.evidence.ocr.perProduct = ocrSignals
        .sort((a, b) => b.score - a.score)
        .slice(0, 5)
        .map((signal) => ({ sku: signal.sku, score: Math.round(signal.score * 100) / 100 }));

      // ---- retrieval (req 7) ------------------------------------------
      const index = await ctx.timed('embedding-index', this.retriever, () =>
        this.retriever.ensureIndex(tenantId),
      );
      ctx.evidence.retrieval.indexed = index.total;
      const retrievalSignals = await ctx.timed('retrieval', this.retriever, () =>
        this.retriever.retrieve(tenantId, ctx.bestPre.image, 10),
      );
      ctx.evidence.retrieval.candidates = retrievalSignals.map((signal) => ({
        sku: signal.sku,
        score: Math.round(signal.score * 10_000) / 10_000,
      }));

      // ---- classical (req 8) ------------------------------------------
      const classicalSignals = await ctx.timed('classical', this.classical, () =>
        this.classical.match(tenantId, ctx.bestPre.image),
      );
      ctx.evidence.classical.candidates = classicalSignals.slice(0, 10).map((signal) => ({
        sku: signal.sku,
        score: signal.score,
      }));

      // ---- context (req 9) --------------------------------------------
      const candidateIds = [
        ...new Set(
          [...barcodeSignals, ...retrievalSignals, ...classicalSignals, ...ocrSignals].map(
            (signal) => signal.productId,
          ),
        ),
      ];
      const contextSignals = await ctx.timed('context', this.contextProvider, () =>
        this.contextProvider.contextFor(
          tenantId,
          {
            locationId: ctx.store.locationId,
            unitId: ctx.store.unitId,
            deviceId: ctx.store.deviceId,
            shelfZoneId: ctx.shelfZoneId,
          },
          candidateIds,
        ),
      );
      ctx.evidence.context.candidates = contextSignals.map((signal) => ({
        sku: signal.sku,
        score: signal.score,
        detail: signal.detail,
      }));

      // ---- fusion (req 10) --------------------------------------------
      const fused = this.fusion.fuse(
        {
          classical: classicalSignals,
          retrieval: retrievalSignals,
          barcode: barcodeSignals,
          ocr: ocrSignals,
          context: contextSignals,
        },
        productMeta,
      );
      ctx.evidence.fused = fused;

      // ---- inventory validation (req 1/13) ----------------------------
      const inventoryValidations = await ctx.timed(
        'inventory-validate',
        this.inventoryValidator,
        () =>
          this.inventoryValidator.validate(
            tenantId,
            ctx.store.locationId,
            fused.slice(0, 3).map((candidate) => candidate.productId),
          ),
      );
      ctx.evidence.inventoryValidation = inventoryValidations.map((validation) => ({
        sku: validation.sku,
        verdict: validation.verdict,
        onHandQuantity: validation.onHandQuantity,
      }));

      // ---- policy + optional VLM (req 11/12) --------------------------
      const top = fused[0];
      const decision = decidePolicy(top, {
        autoThreshold: this.autoThreshold,
        vlmLowBand: this.vlmLowBand,
        marginThreshold: this.marginThreshold,
      });
      ctx.evidence.vlm.provider = this.vlmProvider;
      ctx.evidence.vlm.mode = this.vlmMode;

      const invokeVlm = async (reason: string) => {
        // LIVE-FRAME SCREEN GATE (Codex P1): a live-origin run's crop
        // pixels were never screened at upload the way FILE_REPLAY
        // assets were — the only vetting is this pipeline's own OCR
        // sensitive-text screening. The VLM request carries the bestPre
        // crop AND every peak/post crop as base64 pixels, so EVERY one
        // of those images must screen clean: bestPre via the evidence
        // OCR that already ran (status OK, nothing suppressed), and each
        // additional VLM-bound crop via its own OCR pass with the same
        // predicate (liveVlmExtraCropsScreenClean). Any crop whose OCR
        // did not complete or whose text trips the screen blocks the
        // invocation entirely — regardless of provider, local included
        // (MVP fails closed) — and routes the run to human review with
        // a controlled reason. Asset-origin behavior is unchanged, and
        // the extra passes never store or forward recognized text.
        if (ctx.evidence.liveSessionId !== undefined) {
          let blockReason: string | null = null;
          if (ctx.evidence.ocr.status !== 'OK') {
            // The bestPre screen never completed — indistinguishable
            // from unscreened pixels, so the gate fails closed.
            blockReason = LIVE_FRAME_SCREENING_UNAVAILABLE;
          } else if (ctx.evidence.ocr.screened === OCR_TEXT_SUPPRESSED) {
            blockReason = LIVE_FRAME_SENSITIVE_CONTENT;
          } else {
            const verdict = await ctx.timed(
              'live-crop-screen',
              this.ocrReader,
              () => this.liveVlmExtraCropsScreenVerdict(ctx.crops),
            );
            if (verdict === 'unavailable') {
              blockReason = LIVE_FRAME_SCREENING_UNAVAILABLE;
            } else if (verdict === 'sensitive') {
              blockReason = LIVE_FRAME_SENSITIVE_CONTENT;
            }
          }
          if (blockReason !== null) {
            ctx.evidence.vlm.invoked = false;
            ctx.evidence.vlm.reason = blockReason;
            ctx.evidence.vlm.status = 'UNAVAILABLE';
            ctx.evidence.policy = {
              result: FusionPolicyResult.NEEDS_HUMAN_REVIEW,
              reason:
                'live frame screening blocked VLM invocation — routed to review',
            };
            return;
          }
        }
        ctx.evidence.vlm.invoked = true;
        ctx.evidence.vlm.reason = reason;
        if (!this.vlmEnabled) {
          ctx.evidence.vlm.status = 'UNAVAILABLE';
          ctx.evidence.policy = {
            result: FusionPolicyResult.NEEDS_HUMAN_REVIEW,
            reason: 'VLM disabled (PICKUP_VLM_ENABLED) — routed to review',
          };
          return;
        }
        const verdict = await ctx.timed('vlm', this.vlm, () =>
          this.buildAndVerify(tenantId, ctx.evidence, ctx.crops, ctx.bestPre, fused.slice(0, 3)),
        );
        applyVlmVerdictToEvidence(
          ctx.evidence,
          verdict,
          decision.result === 'AUTO_PROPOSE' ? 'AUTO_PROPOSE' : 'NEEDS_VLM',
          top?.sku ?? null,
          'routed to review',
        );
      };

      if (decision.result === 'UNKNOWN_PRODUCT') {
        ctx.evidence.policy = {
          result: FusionPolicyResult.UNKNOWN_PRODUCT,
          reason: decision.reason,
        };
      } else if (decision.result === 'AUTO_PROPOSE') {
        ctx.evidence.policy = {
          result: FusionPolicyResult.AUTO_PROPOSE,
          reason: decision.reason,
        };
        if (this.vlmMode === 'VALIDATION_ALWAYS' && top) {
          // VALIDATION_ALWAYS: every proposal is independently checked by
          // the local verifier; disagreement or unavailability demotes to
          // review (shadow-phase safety over throughput).
          await invokeVlm(`VALIDATION_ALWAYS check of ${top.sku}`);
        }
      } else {
        await invokeVlm(decision.reason);
      }
      // Inventory VALIDATES what CV proposes — as a policy gate, not
      // display-only ctx.evidence. Whatever path produced AUTO_PROPOSE (score
      // band or VLM confirmation), a top candidate the store does not
      // stock — or has at zero on hand — demotes to human review.
      const finalSku = ctx.evidence.policy.result === FusionPolicyResult.AUTO_PROPOSE
        ? (ctx.evidence.vlm.verdict === 'MATCH' && ctx.evidence.vlm.selectedSku
            ? ctx.evidence.vlm.selectedSku
            : top?.sku ?? null)
        : null;
      if (finalSku) {
        const validation = inventoryValidations.find(
          (row) => row.sku === finalSku,
        );
        // FAIL CLOSED: only an explicit PLAUSIBLE verdict lets AUTO_PROPOSE
        // stand. A missing validation row, or a location-less asset
        // (NO_STORE_CONTEXT), means the proposal has ZERO inventory
        // backing — that is a reason for human eyes, never a free pass.
        if (!validation) {
          ctx.evidence.policy = {
            result: FusionPolicyResult.NEEDS_HUMAN_REVIEW,
            reason: `no inventory validation recorded for ${finalSku} — review`,
          };
        } else if (validation.verdict !== 'PLAUSIBLE') {
          ctx.evidence.policy = {
            result: FusionPolicyResult.NEEDS_HUMAN_REVIEW,
            reason: `inventory validation rejected ${finalSku} (${validation.verdict}) — review`,
          };
        }
      }
      // OCR is an ADVERTISED verification stage: when it did not complete
      // (UNAVAILABLE / TIMEOUT / EXECUTION_FAILED), its empty text is not
      // a verified "no text" observation, so an AUTO_PROPOSE that skipped
      // the stage demotes to human review — same posture as a failed VLM.
      if (
        ctx.evidence.policy.result === FusionPolicyResult.AUTO_PROPOSE &&
        ctx.evidence.ocr.status !== 'OK'
      ) {
        ctx.evidence.policy = {
          result: FusionPolicyResult.NEEDS_HUMAN_REVIEW,
          reason: `OCR stage ${ctx.evidence.ocr.status} — verification stage did not run, routed to review`,
        };
      }
  }

  /**
   * Phase 13 — the LIVE entry point: one SHADOW fusion run over frames
   * sampled straight from an RTSP session, persisted as a LIVE_WINDOW
   * run (videoAssetId null, liveSessionId set). Runs the IDENTICAL
   * shared stages as the asset path — window-scoped detection, crop
   * selection, signals, READ-ONLY inventory validation, VLM via the
   * existing verifier path, fail-closed policy — differing only where a
   * video asset is structurally absent: frames are given rather than
   * decoded, the sampled resolution is both analysis and source geometry
   * (boxes 1:1), no crop artifact row is written (there is no asset to
   * attach it to), and no v1/ground-truth shadow comparison is baked.
   */
  async runLiveWindow(
    tenantId: string,
    input: {
      liveSessionId: string;
      locationId: string;
      unitId: string | null;
      /** Session-relative timestamps, strictly ascending, one shared
       *  geometry. */
      frames: { timestampMs: number; image: RgbImage }[];
      window: { startMs: number; endMs: number; peakMs: number };
    },
  ): Promise<{ runId: string }> {
    const { frames } = input;
    if (
      frames.length < LIVE_WINDOW_MIN_FRAMES ||
      frames.length > LIVE_WINDOW_MAX_FRAMES
    ) {
      throw new BadRequestException(
        `a live window needs ${LIVE_WINDOW_MIN_FRAMES}..${LIVE_WINDOW_MAX_FRAMES} sampled frames`,
      );
    }
    const dims = frames[0].image;
    if (
      dims.width < 16 ||
      dims.height < 16 ||
      dims.width > LIVE_FRAME_MAX_DIMENSION ||
      dims.height > LIVE_FRAME_MAX_DIMENSION
    ) {
      throw new BadRequestException(
        `live frame dimensions must be 16..${LIVE_FRAME_MAX_DIMENSION} pixels per side`,
      );
    }
    for (let i = 0; i < frames.length; i += 1) {
      const frame = frames[i];
      if (
        frame.image.width !== dims.width ||
        frame.image.height !== dims.height
      ) {
        throw new BadRequestException('live frames must share one geometry');
      }
      if (i > 0 && frame.timestampMs <= frames[i - 1].timestampMs) {
        throw new BadRequestException(
          'live frame timestamps must be strictly ascending',
        );
      }
    }
    const session = await this.prisma.liveCameraSession.findFirst({
      where: { tenantId, id: input.liveSessionId },
      select: { id: true },
    });
    if (!session) {
      throw new NotFoundException('Live session not found in this tenant');
    }

    const startedAt = Date.now();
    const stages: StageTiming[] = [];
    const timed = this.makeTimed(stages);
    const evidence = await this.newEvidenceSkeleton(stages);
    evidence.liveSessionId = input.liveSessionId;
    evidence.replayWindow = { ...input.window };

    // Live frames are BOTH the analysis and the source resolution — a
    // live stream has no stored higher-resolution copy to re-seek, so
    // boxes and crops operate 1:1 (scaleBoxToSource over identical
    // geometries is the identity; kept for symmetry with the asset path).
    const geometry = { width: dims.width, height: dims.height };
    const source = geometry;
    const analysisFrames: AnalysisFrame[] = frames.map((frame, index) => ({
      index,
      timestampMs: frame.timestampMs,
      rgb: frame.image.rgb,
    }));
    const measuredSpacingMs =
      frames.length > 1
        ? (frames[frames.length - 1].timestampMs - frames[0].timestampMs) /
          (frames.length - 1)
        : 1000;

    try {
      const { scopedEvents, finalWarnings } = await this.detectScopedToWindow({
        evidence,
        timed,
        frames: analysisFrames,
        geometry,
        source,
        window: input.window,
        frameMarginMs: Math.max(1, measuredSpacingMs),
      });

      if (scopedEvents.length === 0) {
        const cameraMotion = finalWarnings.includes('CAMERA_MOTION_SUSPECTED');
        evidence.policy = cameraMotion
          ? {
              result: FusionPolicyResult.NEEDS_HUMAN_REVIEW,
              reason: 'camera motion suspected — footage needs human eyes',
            }
          : {
              result: FusionPolicyResult.UNKNOWN_PRODUCT,
              reason: `no pickup event proposed (${finalWarnings.join(',') || 'quiet window'})`,
            };
        return this.persist(
          tenantId,
          { liveSessionId: input.liveSessionId },
          evidence,
          startedAt,
        );
      }
      const primary = scopedEvents[0];

      // Crop selection mirrors the asset path's candidate instants; the
      // NEAREST sampled frame stands in for a full-resolution seek.
      const firstTs = frames[0].timestampMs;
      const lastTs = frames[frames.length - 1].timestampMs;
      const clamp = (ms: number): number =>
        Math.max(firstTs, Math.min(ms, lastTs));
      const frameAt = (ms: number): AnalysisFrame => {
        let best = analysisFrames[0];
        for (const frame of analysisFrames) {
          if (
            Math.abs(frame.timestampMs - ms) <
            Math.abs(best.timestampMs - ms)
          ) {
            best = frame;
          }
        }
        return best;
      };
      const candidateInstants: { phase: 'pre' | 'peak' | 'post'; ms: number }[] = [
        { phase: 'pre', ms: clamp(primary.startMs - 1200) },
        { phase: 'pre', ms: clamp(primary.startMs - 600) },
        { phase: 'pre', ms: clamp(primary.startMs - 200) },
        { phase: 'peak', ms: clamp(primary.peakMs) },
        { phase: 'post', ms: clamp(primary.endMs + 600) },
      ];
      const quiet = analysisFrames[0];
      const fullBox = scaleBoxToSource(primary.box, geometry, source);
      const crops: QualifiedCrop[] = candidateInstants.map(({ phase, ms }) => {
        const frame = frameAt(ms);
        const image = cropRgb(
          { width: geometry.width, height: geometry.height, rgb: frame.rgb },
          fullBox,
        );
        return {
          phase,
          timestampMs: frame.timestampMs,
          box: fullBox,
          image,
          quality: {
            sharpness: Math.round(sharpness(image) * 100) / 100,
            occlusion:
              Math.round(
                occlusionFraction(frame.rgb, quiet.rgb, geometry, fullBox) * 100,
              ) / 100,
            brightness: Math.round(meanBrightness(image)),
          },
        };
      });
      const preCrops = crops.filter((crop) => crop.phase === 'pre');
      const bestPre = selectBestCrop(preCrops);
      evidence.crops = crops.map((crop) => ({
        phase: crop.phase,
        timestampMs: crop.timestampMs,
        box: crop.box,
        quality: crop.quality,
        selected: crop === bestPre,
      }));
      // No crop ARTIFACT for live runs: artifacts are rows of a video
      // asset, and none exists — evidence.cropArtifactId stays null; the
      // crop descriptors above are the audited evidence.

      const peakFrame = frameAt(clamp(primary.peakMs));
      await this.runSignalStages(tenantId, {
        evidence,
        timed,
        crops,
        bestPre,
        peakFrame: {
          image: {
            width: geometry.width,
            height: geometry.height,
            rgb: peakFrame.rgb,
          },
          timestampMs: peakFrame.timestampMs,
        },
        shelfZoneId: primary.shelfZoneId ?? null,
        store: {
          locationId: input.locationId,
          unitId: input.unitId,
          deviceId: null,
        },
      });
      return this.persist(
        tenantId,
        { liveSessionId: input.liveSessionId },
        evidence,
        startedAt,
      );
    } catch (error) {
      this.logger.error(
        `live fusion run failed: ${error instanceof Error ? error.message : 'unknown'}`,
      );
      evidence.policy = {
        result: FusionPolicyResult.FAILED,
        reason: 'pipeline stage failed — see server logs; retry is safe',
      };
      return this.persist(
        tenantId,
        { liveSessionId: input.liveSessionId },
        evidence,
        startedAt,
      );
    }
  }

  /**
   * PER-CROP live screen (Codex P1): buildAndVerify sends the bestPre
   * crop plus EVERY peak/post crop to the VLM, so screening only the
   * single evidence OCR (which ran on bestPre) is insufficient —
   * sensitive content visible only at peak or post would still ship.
   * Each additional VLM-bound crop gets its own OCR pass judged by the
   * SAME sensitive predicate. The verdict distinguishes the two block
   * reasons: 'sensitive' when a crop's text trips the screen,
   * 'unavailable' when a crop's screen could not complete (non-OK
   * status, thrown) — the FIRST failing crop decides, scanning in frame
   * order. Recognized text from these passes exists ONLY for this
   * verdict — never stored, never forwarded, never logged. Reference
   * images are catalog-owned assets, not live pixels — exempt by design.
   */
  private async liveVlmExtraCropsScreenVerdict(
    crops: QualifiedCrop[],
  ): Promise<'clean' | 'unavailable' | 'sensitive'> {
    // Exactly the extra frames buildAndVerify would send: every non-pre
    // crop (bestPre itself is covered by the evidence OCR screen).
    for (const crop of crops.filter((candidate) => candidate.phase !== 'pre')) {
      try {
        const ocr = await this.ocrReader.recognize(crop.image);
        if (ocr.status !== 'OK') {
          return 'unavailable';
        }
        if (
          containsSensitiveFreeText(ocr.rawText) ||
          containsSensitiveFreeText(ocr.normalizedText)
        ) {
          return 'sensitive';
        }
      } catch {
        return 'unavailable';
      }
    }
    return 'clean';
  }

  private async buildAndVerify(
    tenantId: string,
    evidence: FusionEvidence,
    crops: QualifiedCrop[],
    bestPre: QualifiedCrop,
    top3: FusedCandidate[],
  ): Promise<VlmVerdict> {
    // One reference image per candidate, decoded from managed storage.
    // DETERMINISTIC selection: oldest row (createdAt, then id) per
    // product, and the chosen image id is recorded on the evidence —
    // re-running against unchanged data must show the model the same
    // reference photo.
    const references = await this.prisma.productReferenceImage.findMany({
      where: { tenantId, productId: { in: top3.map((candidate) => candidate.productId) } },
      select: { id: true, productId: true, storageKey: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const referenceImages = new Map<string, RgbImage[]>();
    evidence.vlm.references = [];
    for (const candidate of top3) {
      const row = references.find((reference) => reference.productId === candidate.productId);
      evidence.vlm.references.push({
        sku: candidate.sku,
        referenceImageId: row?.id ?? null,
      });
      if (!row) {
        referenceImages.set(candidate.productId, []);
        continue;
      }
      try {
        referenceImages.set(candidate.productId, [
          await this.media.decodeReferenceImage(row.storageKey),
        ]);
      } catch {
        referenceImages.set(candidate.productId, []);
      }
    }
    return this.vlm.verify(
      {
        // The SELECTED best pre-event crop (sharpest, least occluded) —
        // the same evidence OCR and retrieval ran on — plus peak/post.
        frames: [bestPre, ...crops.filter((crop) => crop.phase !== 'pre')].map(
          (crop) => ({ phase: crop.phase, image: crop.image }),
        ),
        crops,
        candidates: top3.map((candidate) => ({
          sku: candidate.sku,
          name: candidate.productName,
          fusedScore: candidate.fusedScore,
          referenceImages: referenceImages.get(candidate.productId) ?? [],
        })),
        // Screened evidence text feeds the model too: a suppressed OCR
        // string is empty (→ null) and a suppressed decode marker is a
        // classification, not a barcode — neither travels as text.
        ocrText: evidence.ocr.normalizedText || null,
        barcode:
          evidence.barcode.results[0]?.value &&
          evidence.barcode.results[0].value !== BARCODE_VALUE_SUPPRESSED
            ? evidence.barcode.results[0].value
            : null,
        shelfContext: evidence.detector.events[0]?.shelfZoneId ?? null,
      },
      this.vlmTimeoutMs,
    );
  }

  private async persist(
    tenantId: string,
    origin: { videoAssetId: string } | { liveSessionId: string },
    evidence: FusionEvidence,
    startedAt: number,
  ): Promise<{ runId: string }> {
    if ('liveSessionId' in origin) {
      // LIVE_WINDOW runs (Phase 13): no video asset exists, so there is
      // no v1 shadow comparison and no clip ground truth to bake in —
      // live evaluation is a review-queue concern, not a whole-clip
      // metric. The row records the session origin instead.
      const processingMsLive = Date.now() - startedAt;
      const topLive = evidence.fused[0];
      const liveRow = await this.prisma.pickupFusionRun.create({
        data: {
          tenantId,
          videoAssetId: null,
          liveSessionId: origin.liveSessionId,
          pipelineVersion: FUSION_PIPELINE_VERSION,
          runScope: FusionRunScope.LIVE_WINDOW,
          policy: evidence.policy.result,
          fusedTopSku: topLive?.sku ?? null,
          fusedTopScore: topLive?.fusedScore ?? null,
          scoreMargin: topLive?.scoreMargin ?? null,
          evidence: evidence as unknown as object,
          processingMs: processingMsLive,
        },
        select: { id: true },
      });
      return { runId: liveRow.id };
    }
    const { videoAssetId } = origin;
    // ---- shadow comparison vs v1 + ground truth (req 15) --------------
    const v1Job = await this.prisma.inferenceJob.findFirst({
      where: {
        tenantId,
        sourceType: EvidenceSourceType.VISION,
        sourceId: pickupSourceId(videoAssetId),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    if (v1Job?.visionEventId) {
      const event = await this.prisma.visionEvent.findFirst({
        where: { tenantId, id: v1Job.visionEventId },
        select: { metadata: true },
      });
      const record = event?.metadata as PickupDetectionRecord | null;
      if (record && (record as { kind?: string }).kind === 'PRODUCT_PICKUP_DETECTION') {
        evidence.shadow.classicalV1 = {
          predictedSku: record.sku,
          matchScore: record.confidence,
          peakMs: record.eventPeakMs,
        };
      }
    }
    const truth = await this.prisma.videoGroundTruth.findFirst({
      where: { tenantId, videoAssetId },
      include: { product: { select: { sku: true } } },
    });
    if (truth) {
      const truthView = {
        sku: truth.product?.sku ?? null,
        eventKind: truth.eventKind,
        actualTimestampMs: truth.actualTimestampMs,
      };
      evidence.shadow.groundTruth = truthView;
      evidence.shadow.v1Verdict = shadowVerdict(
        evidence.shadow.classicalV1?.predictedSku ?? null,
        truthView,
      );
      evidence.shadow.v2Verdict = shadowVerdict(
        fusionPredictedSku(evidence),
        truthView,
      );
    }

    const processingMs = Date.now() - startedAt;
    const top = evidence.fused[0];
    const row = await this.prisma.pickupFusionRun.create({
      data: {
        tenantId,
        videoAssetId,
        pipelineVersion: FUSION_PIPELINE_VERSION,
        // Scope from the audit marker itself: a window-scoped replay run
        // must never masquerade as (or displace) the whole-clip analysis
        // that evaluation metrics are built on.
        runScope: evidence.replayWindow
          ? FusionRunScope.REPLAY_WINDOW
          : FusionRunScope.WHOLE_CLIP,
        policy: evidence.policy.result,
        fusedTopSku: top?.sku ?? null,
        fusedTopScore: top?.fusedScore ?? null,
        scoreMargin: top?.scoreMargin ?? null,
        evidence: evidence as unknown as object,
        processingMs,
      },
      select: { id: true },
    });
    return { runId: row.id };
  }

  async latestEvidence(tenantId: string, videoAssetId: string) {
    // WHOLE_CLIP only (Codex P1): this read backs the video asset's
    // fusion panel and the whole-ground-truth shadow verdicts below. A
    // camera replay appends REPLAY_WINDOW runs for the SAME video — the
    // newest of those must never displace the asset's whole-clip result
    // here. Window evidence stays reachable solely through the pilot-run
    // detail, which reads its exact run id.
    const run = await this.prisma.pickupFusionRun.findFirst({
      where: { tenantId, videoAssetId, runScope: FusionRunScope.WHOLE_CLIP },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    if (!run) {
      return null;
    }
    const evidence = run.evidence as unknown as FusionEvidence;
    // The shadow verdicts are RECOMPUTED against the CURRENT ground truth
    // on every read: truth entered (or corrected) AFTER a run must change
    // the comparison immediately — without re-running the pipeline and
    // without a page reload. The signal evidence itself stays as-run.
    const truth = await this.prisma.videoGroundTruth.findFirst({
      where: { tenantId, videoAssetId },
      include: { product: { select: { sku: true } } },
    });
    const truthView = truth
      ? {
          sku: truth.product?.sku ?? null,
          eventKind: truth.eventKind,
          actualTimestampMs: truth.actualTimestampMs,
        }
      : null;
    evidence.shadow.groundTruth = truthView;
    evidence.shadow.v1Verdict = shadowVerdict(
      evidence.shadow.classicalV1?.predictedSku ?? null,
      truthView,
    );
    evidence.shadow.v2Verdict = shadowVerdict(
      fusionPredictedSku(evidence),
      truthView,
    );
    return {
      runId: run.id,
      pipelineVersion: run.pipelineVersion,
      policy: run.policy,
      fusedTopSku: run.fusedTopSku,
      fusedTopScore: run.fusedTopScore,
      scoreMargin: run.scoreMargin,
      processingMs: run.processingMs,
      createdAt: run.createdAt,
      evidence,
    };
  }
}
