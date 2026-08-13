/**
 * pickup-fusion-v2 — VERSIONED adapter contracts.
 *
 * Repository invariants these ports encode:
 * - EDGE-FIRST: every stage runs against locally decoded frames/crops; no
 *   stage may require cloud connectivity except the explicitly-gated VLM
 *   verifier, whose unavailability degrades to review (never a failure of
 *   store operation).
 * - ADAPTER-FIRST / MODEL-SWAPPABLE: each interface carries `adapterKey`
 *   and `version`; implementations register by key and are selected by
 *   configuration. Swapping YOLO for the classical detector — or CLIP for
 *   the HOG retriever — changes configuration, not orchestration.
 * - CV ONLY PROPOSES: the pipeline's terminal output is a POLICY-tagged
 *   proposal (PickupFusionRun row). It never writes vision events, never
 *   touches checkout sessions, inventory, or billing; inventory
 *   VALIDATES proposals (InventoryValidator) and low-confidence results
 *   route to review.
 *
 * Every interface exposes `checkReady()` (edge-offline detection: a
 * missing binary/model/endpoint reports not-ready and the policy engine
 * downgrades gracefully instead of fabricating output).
 */

import { AnalysisFrame, AnalysisGeometry, BoundingBox } from '../pickup-detection/analysis/pickup-analyzer';
import { RgbImage } from '../pickup-detection/analysis/product-matcher';

export interface VersionedAdapter {
  readonly adapterKey: string;
  readonly version: string;
  /** Edge-readiness: false must degrade, never fabricate. */
  checkReady(): Promise<boolean>;
}

// ---------------------------------------------------------------- decode

/**
 * Repository-owned media decode port — STORAGE-KEY-based pixel access for
 * the fusion pipeline. The orchestration service hands the adapter the
 * managed storage key it read from the asset/reference row; resolving the
 * key to a local filesystem path (internalPathFor) — or, for a future
 * object-store adapter, to a download — happens inside the adapter alone.
 * No path, storage vendor, or decode binary ever reaches the service.
 * `durationMs` (from the asset's probed metadata) lets the whole-clip
 * decode enforce its aggregate memory budget by downsampling fps instead
 * of failing a valid asset.
 */
export interface PickupMediaDecoder extends VersionedAdapter {
  /** Whole-clip downscaled analysis frames at `fps` (or the highest
   *  budget-fitting cadence below it — timestamps carry the truth). */
  decodeAnalysisFrames(
    storageKey: string,
    fps: number,
    geometry: AnalysisGeometry,
    durationMs: number,
  ): Promise<AnalysisFrame[]>;
  /** ONE frame at (or, on a tail-of-clip fallback, just before)
   *  `timestampMs` — the returned frame's timestampMs is the instant that
   *  ACTUALLY decoded, which callers must carry into evidence. */
  decodeFrameAt(
    storageKey: string,
    timestampMs: number,
    geometry: AnalysisGeometry,
  ): Promise<AnalysisFrame>;
  /** ONE stored reference image at the matcher's working size. */
  decodeReferenceImage(storageKey: string): Promise<RgbImage>;
}

// ---------------------------------------------------------------- events

export type PickupEventKind = 'PICKUP' | 'RETURN';

export interface DetectedBox {
  timestampMs: number;
  box: BoundingBox;
  /** Detector-specific label ('product', 'hand', ...) — never a SKU. */
  label: string;
  confidence: number;
}

export interface ObjectTrack {
  trackId: string;
  label: string;
  boxes: DetectedBox[];
}

export interface PickupEventProposal {
  kind: PickupEventKind;
  startMs: number;
  peakMs: number;
  endMs: number;
  trackId: string;
  /** Coarse shelf zone (grid cell id) — planogram hook. */
  shelfZoneId: string;
  /** Removal/insertion region in SOURCE pixels. */
  box: BoundingBox;
}

export interface PickupDetectionOutput {
  events: PickupEventProposal[];
  tracks: ObjectTrack[];
  /** Fixed-vocabulary refusals ('CAMERA_MOTION_SUSPECTED', 'NO_MOTION_EVENT', ...). */
  warnings: string[];
}

/** Segment the clip into pickup/return proposals with tracks and zones. */
export interface PickupEventDetector extends VersionedAdapter {
  detect(
    frames: AnalysisFrame[],
    geometry: AnalysisGeometry,
    source: { width: number; height: number },
  ): Promise<PickupDetectionOutput>;
}

/** Per-frame object detection (YOLO seat). NEVER a class-per-SKU
 *  classifier — labels are generic ('product', 'hand'). */
export interface ObjectDetector extends VersionedAdapter {
  detectObjects(frame: AnalysisFrame, geometry: AnalysisGeometry): Promise<DetectedBox[]>;
}

/** Associates per-frame detections into tracks. */
export interface ObjectTracker extends VersionedAdapter {
  track(detections: DetectedBox[][]): Promise<ObjectTrack[]>;
}

// ---------------------------------------------------------------- crops

export interface QualifiedCrop {
  /** 'pre' | 'peak' | 'post' */
  phase: 'pre' | 'peak' | 'post';
  timestampMs: number;
  box: BoundingBox;
  image: RgbImage;
  quality: {
    /** Mean gradient energy — higher is sharper. */
    sharpness: number;
    /** Fraction of the box overlapped by moving (hand) pixels at that instant. */
    occlusion: number;
    brightness: number;
  };
}

// ---------------------------------------------------------------- signals

export interface BarcodeResult {
  value: string;
  format: string;
  timestampMs: number;
}

export interface BarcodeReader extends VersionedAdapter {
  read(images: { image: RgbImage; timestampMs: number }[]): Promise<BarcodeResult[]>;
}

export interface OcrResult {
  rawText: string;
  normalizedText: string;
  /** Which language packs actually ran (e.g. ['eng'] or ['eng','ara']). */
  languages: string[];
}

/**
 * Classified OCR execution status — the same pattern as the VLM verdict
 * classification: a fixed code only, NEVER raw error text (an execFile
 * error message can embed command output or filesystem paths). 'OK'
 * includes a successful pass that simply saw no text; every other value
 * means the OCR stage DID NOT complete, so its empty text must not be
 * treated as a verified "no text on the product" observation.
 * - UNAVAILABLE: the OCR runtime (or every language pack) is missing.
 * - TIMEOUT: the process was killed at the OCR deadline.
 * - EXECUTION_FAILED: the runtime started but exited abnormally.
 */
export type OcrExecutionStatus =
  | 'OK'
  | 'UNAVAILABLE'
  | 'TIMEOUT'
  | 'EXECUTION_FAILED';

/** OcrResult plus the classified execution status. */
export interface ClassifiedOcrResult extends OcrResult {
  status: OcrExecutionStatus;
}

export interface OcrReader extends VersionedAdapter {
  recognize(image: RgbImage): Promise<ClassifiedOcrResult>;
}

export interface CandidateSignal {
  productId: string;
  sku: string;
  /** [0, 1], meaning defined by the emitting adapter — NOT calibrated. */
  score: number;
  detail?: string;
}

/** Nearest-neighbour retrieval over the versioned reference-embedding index. */
export interface VisualRetriever extends VersionedAdapter {
  readonly embeddingModelKey: string;
  readonly embeddingModelVersion: string;
  /** Ensure every stored reference image has a vector for this model. */
  ensureIndex(tenantId: string): Promise<{ indexed: number; total: number }>;
  retrieve(tenantId: string, crop: RgbImage, topK: number): Promise<CandidateSignal[]>;
}

/** The v1 HSV+NCC signal, kept verbatim as one fusion input. */
export interface ClassicalMatcher extends VersionedAdapter {
  match(tenantId: string, crop: RgbImage): Promise<CandidateSignal[]>;
}

export interface ContextInput {
  locationId: string | null;
  unitId: string | null;
  deviceId: string | null;
  shelfZoneId: string | null;
}

/** Store/planogram/availability priors per candidate product. */
export interface ContextSignalProvider extends VersionedAdapter {
  contextFor(
    tenantId: string,
    context: ContextInput,
    productIds: string[],
  ): Promise<CandidateSignal[]>;
}

// ---------------------------------------------------------------- fusion

export interface FusedCandidate {
  productId: string;
  sku: string;
  productName: string;
  rank: number;
  /** Fused score, EXPLICITLY UNCALIBRATED (see requirement 10). */
  fusedScore: number;
  /** Margin to the next-ranked candidate. */
  scoreMargin: number;
  /** Every contributing signal, retained verbatim. */
  signals: { source: string; score: number; detail?: string }[];
}

export interface CandidateFusion extends VersionedAdapter {
  fuse(inputs: {
    classical: CandidateSignal[];
    retrieval: CandidateSignal[];
    barcode: CandidateSignal[];
    ocr: CandidateSignal[];
    context: CandidateSignal[];
  }, products: Map<string, { sku: string; name: string }>): FusedCandidate[];
}

// ---------------------------------------------------------------- VLM

export interface VlmRequestEvidence {
  frames: { phase: 'pre' | 'peak' | 'post'; image: RgbImage }[];
  crops: QualifiedCrop[];
  candidates: {
    sku: string;
    name: string;
    fusedScore: number;
    referenceImages: RgbImage[];
  }[];
  ocrText: string | null;
  barcode: string | null;
  shelfContext: string | null;
}

/**
 * Exact failure classification — NEVER collapsed into a generic
 * "unavailable". Each non-VERDICT status names the precise stage that
 * failed so the UI and logs can say why:
 * - PROVIDER_UNREACHABLE: the endpoint did not answer (connection refused,
 *   DNS, network error).
 * - MODEL_NOT_FOUND: the provider answered but the pinned model is not
 *   installed/served.
 * - TIMEOUT: no completion within the deadline (a cold local model that is
 *   still loading reports TIMEOUT, not unavailable).
 * - MALFORMED_RESPONSE: transport-level nonsense — empty completion, or a
 *   body that is not the provider's response shape.
 * - INVALID_JSON: the model's text could not be parsed as JSON.
 * - INVALID_SCHEMA: parsed JSON but wrong fields/types/ranges.
 * - INVALID_SKU: valid shape but the choice is not a supplied candidate
 *   (an invented SKU is rejected structurally).
 * - PROVIDER_ERROR: the provider returned an HTTP error status.
 * - UNAVAILABLE: the verifier is not configured/enabled at all (disabled
 *   flag, missing API key) — legacy catch-all, still routed to review.
 */
export type VlmVerdictStatus =
  | 'VERDICT'
  | 'PROVIDER_UNREACHABLE'
  | 'MODEL_NOT_FOUND'
  | 'TIMEOUT'
  | 'MALFORMED_RESPONSE'
  | 'INVALID_JSON'
  | 'INVALID_SCHEMA'
  | 'INVALID_SKU'
  | 'PROVIDER_ERROR'
  | 'UNAVAILABLE';

/** What the verifier concluded about the event. */
export type VlmVerdictKind = 'MATCH' | 'AMBIGUOUS' | 'UNKNOWN' | 'INVALID_INPUT';
export type VlmSupportLevel = 'STRONG' | 'MEDIUM' | 'WEAK' | 'NONE';
export type VlmBarcodeSupport = 'EXACT' | 'PARTIAL' | 'NONE';

/** Controlled vocabulary for reasonCodes — free-form prose is rejected. */
export const VLM_REASON_CODES = [
  'REFERENCE_VISUAL_MATCH',
  'OCR_TEXT_MATCH',
  'BARCODE_MATCH',
  'PACKAGING_SHAPE_MATCH',
  'COLOR_PATTERN_MATCH',
  'MULTIPLE_SIMILAR_CANDIDATES',
  'LOW_IMAGE_QUALITY',
  'PRODUCT_OCCLUDED',
  'NO_CANDIDATE_RESEMBLES',
  'WRONG_CATEGORY_ITEM',
  'EVIDENCE_INSUFFICIENT',
  'LEGACY_SCHEMA_MAPPED',
] as const;
export type VlmReasonCode = (typeof VLM_REASON_CODES)[number];

/** Controlled vocabulary for contradictions — short values only. */
export const VLM_CONTRADICTION_CODES = [
  'OCR_MISMATCH',
  'BARCODE_MISMATCH',
  'VISUAL_MISMATCH',
  'SIZE_MISMATCH',
  'COLOR_MISMATCH',
  'LABEL_MISMATCH',
] as const;
export type VlmContradictionCode = (typeof VLM_CONTRADICTION_CODES)[number];

/**
 * The STRICT verifier result. Structural guarantees enforced by the shared
 * parser, never trusted to the model:
 * - selectedSku is null unless verdict is MATCH, and when present it is
 *   EXACTLY one of the supplied candidate SKUs (invented SKUs rejected).
 * - Every enum field is whitelist-validated; unknown values are rejected.
 * - reasonCodes/contradictions carry controlled codes only.
 * The verifier NEVER sets policy — the fusion policy engine consumes this
 * result and decides AUTO_PROPOSE / NEEDS_HUMAN_REVIEW itself.
 */
export interface VlmStructuredResult {
  verdict: VlmVerdictKind;
  selectedSku: string | null;
  visualSupport: VlmSupportLevel;
  ocrSupport: VlmSupportLevel;
  barcodeSupport: VlmBarcodeSupport;
  reasonCodes: VlmReasonCode[];
  contradictions: VlmContradictionCode[];
  requiresHumanReview: boolean;
}

export interface VlmVerdict {
  status: VlmVerdictStatus;
  /** Present ONLY when status is VERDICT — the validated structured result. */
  result: VlmStructuredResult | null;
  modelKey: string | null;
  modelVersion: string | null;
  latencyMs: number | null;
  /** Short, safe failure detail (HTTP status, parse error class) — never
   *  images, base64 payloads, secrets, or customer data. */
  errorDetail?: string | null;
  /** Short, safe preview of the model's raw TEXT output (base64 runs are
   *  elided) — for the debugging panel only. */
  rawPreview?: string | null;
}

/** Escalation verifier. Returns the strict structured result only —
 *  selectedSku must be a supplied SKU (MATCH) or null; malformed/invented
 *  output is classified (INVALID_JSON/INVALID_SCHEMA/INVALID_SKU).
 *  Unavailability/timeout must degrade to review. */
export interface VlmVerifier extends VersionedAdapter {
  verify(evidence: VlmRequestEvidence, timeoutMs: number): Promise<VlmVerdict>;
}

// ---------------------------------------------------------------- validate

export interface InventoryValidation {
  productId: string;
  sku: string;
  stockedAtStore: boolean;
  onHandQuantity: number | null;
  verdict: 'PLAUSIBLE' | 'NOT_STOCKED' | 'OUT_OF_STOCK' | 'NO_STORE_CONTEXT';
}

/** Inventory VALIDATES what CV proposes — the proposal never mutates stock. */
export interface InventoryValidator extends VersionedAdapter {
  validate(
    tenantId: string,
    locationId: string | null,
    productIds: string[],
  ): Promise<InventoryValidation[]>;
}
