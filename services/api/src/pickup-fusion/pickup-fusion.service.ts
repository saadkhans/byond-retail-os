import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  EvidenceSourceType,
  FusionPolicyResult,
  VideoAssetStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LocalVideoStorageAdapter } from '../video-ingest/storage/local-video-storage.adapter';
import { VideoAssetsRepository } from '../video-ingest/video-assets.repository';
import { VideoAssetsService } from '../video-ingest/video-assets.service';
import {
  PickupAnalysisFrameDecoder,
  analysisGeometryFor,
} from '../pickup-detection/analysis/analysis-frames';
import { AnalysisFrame, BoundingBox } from '../pickup-detection/analysis/pickup-analyzer';
import { RgbImage, cropRgb } from '../pickup-detection/analysis/product-matcher';
import {
  PickupDetectionRecord,
  pickupSourceId,
  scaleBoxToSource,
} from '../pickup-detection/pickup-detection.service';
import { PickupDetectionConfig } from '../pickup-detection/pickup-detection.config';
import {
  CandidateSignal,
  FusedCandidate,
  QualifiedCrop,
  VlmStructuredResult,
  VlmVerdict,
} from './ports';
import {
  ClassicalMotionEventDetector,
  YoloOnnxObjectDetector,
} from './adapters/event-detection';
import { TesseractOcrReader, ZxingBarcodeReader } from './adapters/text-signals';
import {
  ClassicalHsvNccMatcher,
  HogLabVisualRetriever,
} from './adapters/visual-signals';
import {
  PrismaContextSignalProvider,
  PrismaInventoryValidator,
  WeightedCandidateFusion,
} from './adapters/context-fusion-inventory';
import { AnthropicVlmVerifier } from './adapters/vlm-verifier';
import { OllamaVlmVerifier } from './adapters/ollama-vlm';
import {
  meanBrightness,
  occlusionFraction,
  selectBestCrop,
  sharpness,
  textFieldOverlap,
} from './primitives';

export const FUSION_PIPELINE_VERSION = 'pickup-fusion-v2';

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
  barcode: { results: { value: string; format: string }[]; matchedSku: string | null };
  ocr: { rawText: string; normalizedText: string; languages: string[]; perProduct: { sku: string; score: number }[] };
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
    modelKey: string | null;
    latencyMs: number | null;
    /** Safe short failure detail (HTTP status, parse error class). */
    errorDetail: string | null;
    /** Safe short preview of the model's raw text (base64 elided). */
    rawPreview: string | null;
  };
  policy: { result: FusionPolicyResult; reason: string };
  shadow: {
    classicalV1: { predictedSku: string | null; matchScore: number | null; peakMs: number | null } | null;
    groundTruth: { sku: string | null; eventKind: string; actualTimestampMs: number | null } | null;
    v1Verdict: string | null;
    v2Verdict: string | null;
  };
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
    private readonly storage: LocalVideoStorageAdapter,
    private readonly decoder: PickupAnalysisFrameDecoder,
    private readonly detectionConfig: PickupDetectionConfig,
    private readonly detector: ClassicalMotionEventDetector,
    private readonly yolo: YoloOnnxObjectDetector,
    private readonly barcodeReader: ZxingBarcodeReader,
    private readonly ocrReader: TesseractOcrReader,
    private readonly retriever: HogLabVisualRetriever,
    private readonly classical: ClassicalHsvNccMatcher,
    private readonly contextProvider: PrismaContextSignalProvider,
    private readonly fusion: WeightedCandidateFusion,
    private readonly anthropicVlm: AnthropicVlmVerifier,
    private readonly ollamaVlm: OllamaVlmVerifier,
    private readonly inventoryValidator: PrismaInventoryValidator,
    config: ConfigService,
  ) {
    const num = (key: string, fallback: number) => {
      const value = Number(config.get<string>(key));
      return Number.isFinite(value) ? value : fallback;
    };
    this.autoThreshold = num('PICKUP_FUSION_AUTO_THRESHOLD', 0.42);
    this.vlmLowBand = num('PICKUP_FUSION_VLM_LOW', 0.22);
    this.marginThreshold = num('PICKUP_FUSION_MARGIN', 0.08);
    this.vlmEnabled =
      (config.get<string>('PICKUP_VLM_ENABLED') ?? '').trim().toLowerCase() ===
      'true';
    this.vlmProvider =
      (config.get<string>('PICKUP_VLM_PROVIDER') ?? 'local') === 'anthropic'
        ? 'anthropic'
        : 'local';
    // Local default is 60 s: a 7B vision model cold-loading into VRAM can
    // legitimately need > 30 s on its first generation.
    this.vlmTimeoutMs = num(
      'PICKUP_VLM_TIMEOUT_MS',
      this.vlmProvider === 'local' ? 60_000 : 30_000,
    );
    this.vlmMode =
      config.get<string>('PICKUP_VLM_MODE') === 'VALIDATION_ALWAYS'
        ? 'VALIDATION_ALWAYS'
        : 'UNCERTAIN_ONLY';
  }

  /** The configured verifier — LOCAL (Ollama) by default; no paid API in
   *  local mode and no API key requirement. */
  private get vlm() {
    return this.vlmProvider === 'anthropic' ? this.anthropicVlm : this.ollamaVlm;
  }

  /** Readiness surface for the UI panel. */
  async vlmReadiness() {
    const base = {
      enabled: this.vlmEnabled,
      provider: this.vlmProvider,
      mode: this.vlmMode,
      timeoutMs: this.vlmTimeoutMs,
    };
    if (this.vlmProvider === 'local') {
      const readiness = await this.ollamaVlm.readiness();
      return {
        ...base,
        model: this.ollamaVlm['model'] as string,
        baseUrl: this.ollamaVlm['baseUrl'] as string,
        serverReachable: readiness.serverReachable,
        modelAvailable: readiness.modelAvailable,
        availableModels: readiness.availableModels,
        // MODEL INSTALLED ≠ inference-ready: READY here means the model is
        // present; the first generation may still be slow (cold VRAM load).
        // lastInference is the honest warm-up signal.
        classification: readiness.classification,
        lastInference: readiness.lastInference,
        ready: this.vlmEnabled && readiness.serverReachable && readiness.modelAvailable,
      };
    }
    const ready = await this.anthropicVlm.checkReady();
    return {
      ...base,
      model: null,
      baseUrl: null,
      serverReachable: ready,
      modelAvailable: ready,
      availableModels: [],
      classification: ready ? ('READY' as const) : ('PROVIDER_UNREACHABLE' as const),
      lastInference: null,
      ready: this.vlmEnabled && ready,
    };
  }

  /**
   * One SHADOW run of pickup-fusion-v2 over a validated test video.
   * Records a PickupFusionRun row and NOTHING else — no vision events, no
   * inventory writes, no session/billing coupling (requirements 13/15).
   */
  async run(tenantId: string, videoAssetId: string): Promise<{ runId: string }> {
    const startedAt = Date.now();
    const stages: StageTiming[] = [];
    const timed = async <T>(
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
    const internalPath = this.storage.internalPathFor(internal.storageKey);

    const evidence: FusionEvidence = {
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
      ocr: { rawText: '', normalizedText: '', languages: [], perProduct: [] },
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
        errorDetail: null,
        rawPreview: null,
      },
      policy: { result: FusionPolicyResult.FAILED, reason: 'not-run' },
      shadow: { classicalV1: null, groundTruth: null, v1Verdict: null, v2Verdict: null },
    };

    try {
      // ---- decode (edge-local) ----------------------------------------
      const geometrySmall = analysisGeometryFor(
        { durationMs: internal.durationMs, width: source.width, height: source.height, fps: internal.fps ?? 30 },
        this.detectionConfig.analysisWidth,
      );
      const framesSmall = await timed(
        'decode-analysis',
        { adapterKey: 'ffmpeg-rawvideo', version: '1.0.0' },
        () =>
          this.decoder.decodeAnalysisFrames(
            internalPath,
            this.detectionConfig.analysisFps,
            geometrySmall,
          ),
      );
      const geometryFull = analysisGeometryFor(
        { durationMs: internal.durationMs, width: source.width, height: source.height, fps: internal.fps ?? 30 },
        Math.min(source.width, 640),
      );
      const framesFull = await timed(
        'decode-full',
        { adapterKey: 'ffmpeg-rawvideo', version: '1.0.0' },
        () =>
          this.decoder.decodeAnalysisFrames(
            internalPath,
            this.detectionConfig.analysisFps,
            geometryFull,
          ),
      );

      // ---- detection + tracking ---------------------------------------
      const detection = await timed('event-detection', this.detector, () =>
        this.detector.detect(framesSmall, geometrySmall, source),
      );
      evidence.detector.warnings = detection.warnings;
      evidence.detector.events = detection.events.map((event) => ({
        ...event,
        box: scaleBoxToSource(event.box, geometrySmall, source),
      }));
      evidence.detector.tracks = detection.tracks.slice(0, 6).map((track) => ({
        trackId: track.trackId,
        label: track.label,
        points: track.boxes.map((box) => ({
          timestampMs: box.timestampMs,
          box: scaleBoxToSource(box.box, geometrySmall, source),
        })),
      }));

      if (detection.events.length === 0) {
        const cameraMotion = detection.warnings.includes('CAMERA_MOTION_SUSPECTED');
        evidence.policy = cameraMotion
          ? {
              result: FusionPolicyResult.NEEDS_HUMAN_REVIEW,
              reason: 'camera motion suspected — footage needs human eyes',
            }
          : {
              result: FusionPolicyResult.UNKNOWN_PRODUCT,
              reason: `no pickup event proposed (${detection.warnings.join(',') || 'quiet clip'})`,
            };
        return this.persist(tenantId, videoAssetId, evidence, startedAt);
      }

      const primary = detection.events[0];

      // ---- multi-frame crop selection (req 4) --------------------------
      const fullByTime = (ms: number): AnalysisFrame =>
        framesFull.reduce((best, frame) =>
          Math.abs(frame.timestampMs - ms) < Math.abs(best.timestampMs - ms)
            ? frame
            : best,
        );
      const quietFull = framesFull[0].rgb;
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
      const crops: QualifiedCrop[] = candidateInstants.map(({ phase, ms }) => {
        const frame = fullByTime(ms);
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
      const runOrdinal = await this.prisma.pickupFusionRun.count({
        where: { tenantId, videoAssetId },
      });
      try {
        const sourceBox = scaleBoxToSource(primary.box, geometrySmall, source);
        const artifact = await this.videoAssets.createCrop(tenantId, videoAssetId, {
          timestampMs: Math.max(0, Math.min(bestPre.timestampMs, internal.durationMs - 1)),
          x: sourceBox.x,
          y: sourceBox.y,
          width: sourceBox.width,
          height: sourceBox.height,
          reason: 'PRODUCT_PICKUP',
          idempotencyKey: `fusion:${videoAssetId}:r${runOrdinal}`,
        });
        evidence.cropArtifactId = artifact.artifact.id;
      } catch (error) {
        this.logger.warn(
          `fusion crop artifact failed: ${error instanceof Error ? error.message : 'unknown'}`,
        );
      }

      // ---- catalog snapshot -------------------------------------------
      const products = await this.prisma.product.findMany({
        where: { tenantId },
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
      const peakFullFrame = fullByTime(primary.peakMs);
      const barcodeResults = await timed('barcode', this.barcodeReader, () =>
        this.barcodeReader.read([
          { image: bestPre.image, timestampMs: bestPre.timestampMs },
          {
            image: {
              width: geometryFull.width,
              height: geometryFull.height,
              rgb: peakFullFrame.rgb,
            },
            timestampMs: peakFullFrame.timestampMs,
          },
        ]),
      );
      const barcodeSignals: CandidateSignal[] = [];
      for (const result of barcodeResults) {
        const owner = products.find((product) =>
          product.barcodes.some((barcode) => barcode.value === result.value),
        );
        if (owner) {
          barcodeSignals.push({
            productId: owner.id,
            sku: owner.sku,
            score: 1,
            detail: `barcode:${result.value}`,
          });
          evidence.barcode.matchedSku = owner.sku;
        }
      }
      evidence.barcode.results = barcodeResults.map((result) => ({
        value: result.value,
        format: result.format,
      }));

      // ---- OCR (req 6) -------------------------------------------------
      const ocr = await timed('ocr', this.ocrReader, () =>
        this.ocrReader.recognize(bestPre.image),
      );
      evidence.ocr.rawText = ocr.rawText.slice(0, 500);
      evidence.ocr.normalizedText = ocr.normalizedText.slice(0, 500);
      evidence.ocr.languages = ocr.languages;
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
      evidence.ocr.perProduct = ocrSignals
        .sort((a, b) => b.score - a.score)
        .slice(0, 5)
        .map((signal) => ({ sku: signal.sku, score: Math.round(signal.score * 100) / 100 }));

      // ---- retrieval (req 7) ------------------------------------------
      const index = await timed('embedding-index', this.retriever, () =>
        this.retriever.ensureIndex(tenantId),
      );
      evidence.retrieval.indexed = index.total;
      const retrievalSignals = await timed('retrieval', this.retriever, () =>
        this.retriever.retrieve(tenantId, bestPre.image, 10),
      );
      evidence.retrieval.candidates = retrievalSignals.map((signal) => ({
        sku: signal.sku,
        score: Math.round(signal.score * 10_000) / 10_000,
      }));

      // ---- classical (req 8) ------------------------------------------
      const classicalSignals = await timed('classical', this.classical, () =>
        this.classical.match(tenantId, bestPre.image),
      );
      evidence.classical.candidates = classicalSignals.slice(0, 10).map((signal) => ({
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
      const contextSignals = await timed('context', this.contextProvider, () =>
        this.contextProvider.contextFor(
          tenantId,
          {
            locationId: internal.locationId,
            unitId: internal.unitId,
            deviceId: internal.deviceId,
            shelfZoneId: primary.shelfZoneId,
          },
          candidateIds,
        ),
      );
      evidence.context.candidates = contextSignals.map((signal) => ({
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
      evidence.fused = fused;

      // ---- inventory validation (req 1/13) ----------------------------
      const inventoryValidations = await timed(
        'inventory-validate',
        this.inventoryValidator,
        () =>
          this.inventoryValidator.validate(
            tenantId,
            internal.locationId,
            fused.slice(0, 3).map((candidate) => candidate.productId),
          ),
      );
      evidence.inventoryValidation = inventoryValidations.map((validation) => ({
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
      evidence.vlm.provider = this.vlmProvider;
      evidence.vlm.mode = this.vlmMode;

      const applyVerdictToPolicy = (
        verdict: VlmVerdict,
        fallbackReason: string,
      ) => {
        evidence.vlm.status = verdict.status;
        evidence.vlm.modelKey = verdict.modelKey;
        evidence.vlm.latencyMs = verdict.latencyMs;
        evidence.vlm.errorDetail = verdict.errorDetail ?? null;
        evidence.vlm.rawPreview = verdict.rawPreview ?? null;
        if (verdict.status !== 'VERDICT' || verdict.result === null) {
          // Every classified failure (TIMEOUT / PROVIDER_* / INVALID_* /
          // MALFORMED_RESPONSE / MODEL_NOT_FOUND) routes to review —
          // never a failed store operation, never a silent pass-through.
          evidence.policy = {
            result: FusionPolicyResult.NEEDS_HUMAN_REVIEW,
            reason: `VLM ${verdict.status}${
              verdict.errorDetail ? ` (${verdict.errorDetail})` : ''
            } — ${fallbackReason}`,
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
        // The VLM never sets policy — the pure policy rule decides from
        // the VALIDATED result.
        evidence.policy = policyFromVlmResult(
          result,
          decision.result === 'AUTO_PROPOSE' ? 'AUTO_PROPOSE' : 'NEEDS_VLM',
          top?.sku ?? null,
        );
      };

      const invokeVlm = async (reason: string) => {
        evidence.vlm.invoked = true;
        evidence.vlm.reason = reason;
        if (!this.vlmEnabled) {
          evidence.vlm.status = 'UNAVAILABLE';
          evidence.vlm.errorDetail = 'PICKUP_VLM_ENABLED is not "true"';
          evidence.policy = {
            result: FusionPolicyResult.NEEDS_HUMAN_REVIEW,
            reason: 'VLM disabled (PICKUP_VLM_ENABLED) — routed to review',
          };
          return;
        }
        const verdict = await timed('vlm', this.vlm, () =>
          this.buildAndVerify(tenantId, evidence, crops, fused.slice(0, 3)),
        );
        applyVerdictToPolicy(verdict, 'routed to review');
      };

      if (decision.result === 'UNKNOWN_PRODUCT') {
        evidence.policy = {
          result: FusionPolicyResult.UNKNOWN_PRODUCT,
          reason: decision.reason,
        };
      } else if (decision.result === 'AUTO_PROPOSE') {
        evidence.policy = {
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
      return this.persist(tenantId, videoAssetId, evidence, startedAt);
    } catch (error) {
      this.logger.error(
        `fusion run failed: ${error instanceof Error ? error.message : 'unknown'}`,
      );
      evidence.policy = {
        result: FusionPolicyResult.FAILED,
        reason: 'pipeline stage failed — see server logs; retry is safe',
      };
      return this.persist(tenantId, videoAssetId, evidence, startedAt);
    }
  }

  private async buildAndVerify(
    tenantId: string,
    evidence: FusionEvidence,
    crops: QualifiedCrop[],
    top3: FusedCandidate[],
  ): Promise<VlmVerdict> {
    // One reference image per candidate, decoded from managed storage.
    const references = await this.prisma.productReferenceImage.findMany({
      where: { tenantId, productId: { in: top3.map((candidate) => candidate.productId) } },
      select: { productId: true, storageKey: true },
    });
    const referenceImages = new Map<string, RgbImage[]>();
    for (const candidate of top3) {
      const row = references.find((reference) => reference.productId === candidate.productId);
      if (!row) {
        referenceImages.set(candidate.productId, []);
        continue;
      }
      try {
        referenceImages.set(candidate.productId, [
          await this.decoder.decodeReferenceImage(
            this.storage.internalPathFor(row.storageKey),
          ),
        ]);
      } catch {
        referenceImages.set(candidate.productId, []);
      }
    }
    return this.vlm.verify(
      {
        frames: crops
          .filter((crop) => crop.phase !== 'pre' || crop === crops.find((c) => c.phase === 'pre'))
          .map((crop) => ({ phase: crop.phase, image: crop.image })),
        crops,
        candidates: top3.map((candidate) => ({
          sku: candidate.sku,
          name: candidate.productName,
          fusedScore: candidate.fusedScore,
          referenceImages: referenceImages.get(candidate.productId) ?? [],
        })),
        ocrText: evidence.ocr.normalizedText || null,
        barcode: evidence.barcode.results[0]?.value ?? null,
        shelfContext: evidence.detector.events[0]?.shelfZoneId ?? null,
      },
      this.vlmTimeoutMs,
    );
  }

  private async persist(
    tenantId: string,
    videoAssetId: string,
    evidence: FusionEvidence,
    startedAt: number,
  ): Promise<{ runId: string }> {
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
    const run = await this.prisma.pickupFusionRun.findFirst({
      where: { tenantId, videoAssetId },
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
