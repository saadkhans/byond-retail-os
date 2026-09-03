/**
 * Phase 19 — pretrained retail vision adapter layer: PURE types,
 * normalization, and sanitization (no I/O, no Nest).
 *
 * Every provider is LOCAL-ONLY. Provider output crosses into BYOND
 * exclusively through `sanitizeProviderEvidence`, an ALLOWLIST rebuild:
 * classified codes, clamped numbers, normalized boxes, and SKU snapshots
 * — never file paths, model paths, stream URLs, raw media, encoded
 * frame blobs, credentials, raw logs, or tensors. Evidence is shadow-only: nothing
 * derived here can touch checkout, order, payment, settlement, or
 * inventory state.
 */

// ---------------------------------------------------------- providers

export const PRETRAINED_PROVIDER_CODES = [
  'CLASSICAL',
  'YOLO_LOCAL',
  'HAND_SIGNAL_LOCAL',
  'EMBEDDING_LOCAL',
] as const;
export type PretrainedProviderCode =
  (typeof PRETRAINED_PROVIDER_CODES)[number];

export type ProviderKind = 'CLASSICAL' | 'DETECTOR' | 'HAND' | 'EMBEDDING';

export type ProviderAvailability = 'READY' | 'DISABLED' | 'UNAVAILABLE';

/** Path-free description of the LOCAL runtime behind a READY provider:
 *  an opaque registry model id, the runtime family, the weight format,
 *  the operator's version label, and the compute device class. Never a
 *  file name, directory, interpreter, or argv. */
export interface ProviderRuntimeInfo {
  modelId: string;
  runtimeKind: string;
  format: string;
  version: string;
  device: string | null;
}

export interface ProviderStatus {
  provider: PretrainedProviderCode;
  kind: ProviderKind;
  availability: ProviderAvailability;
  /** Classified reason CODE only (e.g. LOCAL_RUNTIME_NOT_INSTALLED) —
   *  never an error message, path, or provider log line. */
  reasonCode: string | null;
  /** True when the adapter runs in the lab-only deterministic stub mode
   *  — its output is SYNTHETIC and labeled as such end to end. */
  stubMode: boolean;
  /** Present only for a provider backed by a real local runtime;
   *  classical and stub statuses carry null. */
  runtime: ProviderRuntimeInfo | null;
}

// ---------------------------------------------------------- evidence

export interface NormalizedBox {
  /** Normalized 0..1 coordinates in the ANALYSIS frame — never pixels
   *  of a local file, never a crop path. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export type DetectionLabel = 'PRODUCT' | 'PRODUCT_IN_HAND' | 'HAND';

export interface NormalizedDetection {
  label: DetectionLabel;
  timestampMs: number;
  box: NormalizedBox;
  confidence: number;
  quality: {
    sharpness: number | null;
    occlusion: number | null;
    brightness: number | null;
  } | null;
}

export interface HandSignalSummary {
  handPresent: boolean;
  nearShelfZone: boolean;
  enteredZoneAtMs: number | null;
  contactStartMs: number | null;
  contactEndMs: number | null;
  leftZoneAtMs: number | null;
  contactDurationMs: number | null;
}

export interface EmbeddingCandidate {
  sku: string;
  productId: string | null;
  /** Uncalibrated similarity RANKING signal, 0..1 — not a probability. */
  similarity: number;
}

export type ActionCandidate = 'PICKUP' | 'RETURN' | 'FALSE_TOUCH' | 'UNKNOWN';

export interface InteractionFeatures {
  preCropQuality: number | null;
  peakCropQuality: number | null;
  postCropQuality: number | null;
  bboxMovement: number | null;
  handProximity: number | null;
  objectDisappeared: boolean | null;
  objectAppeared: boolean | null;
  occlusionScore: number | null;
  sharpnessScore: number | null;
  brightnessScore: number | null;
  topSkuCandidates: EmbeddingCandidate[];
  actionCandidate: ActionCandidate;
}

export interface ProviderEvidence {
  provider: PretrainedProviderCode;
  availability: ProviderAvailability;
  reasonCode: string | null;
  /** TRUE for lab-stub output — synthetic, never real inference. */
  synthetic: boolean;
  detections: NormalizedDetection[];
  handSignal: HandSignalSummary | null;
  embeddingCandidates: EmbeddingCandidate[];
  features: InteractionFeatures | null;
  /** Classified note CODES only (UPPER_SNAKE), never free text. */
  notes: string[];
}

// -------------------------------------------------------- sanitization

const CODE_PATTERN = /^[A-Z0-9_]{1,64}$/;
/** SKU/product codes as the catalog stores them — safe identifiers. */
const SKU_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _.\-()]{0,63}$/;
/** Product IDs are cuid-like opaque identifiers: strictly alphanumeric
 *  plus - and _. No slash, backslash, colon, dot, or space — a provider
 *  bug can never smuggle a path, URL, or token through this field. */
const PRODUCT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function num01(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(Math.min(1, Math.max(0, value)) * 1000) / 1000
    : null;
}

function numAny(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(value * 1000) / 1000
    : null;
}

function intMs(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;
}

function boolOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function code(value: unknown): string | null {
  return typeof value === 'string' && CODE_PATTERN.test(value) ? value : null;
}

const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const RUNTIME_LABEL_PATTERN = /^[A-Za-z0-9._-]{1,32}$/;

/**
 * Allowlist rebuild of a runtime descriptor. ANY field failing its
 * pattern drops the WHOLE descriptor to null — a runtime can never
 * smuggle a path or log line into the providers listing through a
 * "version" or "device" string.
 */
export function sanitizeProviderRuntime(value: unknown): ProviderRuntimeInfo | null {
  const raw = value as Partial<ProviderRuntimeInfo> | null | undefined;
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const label = (input: unknown): string | null =>
    typeof input === 'string' && RUNTIME_LABEL_PATTERN.test(input)
      ? input
      : null;
  const modelId =
    typeof raw.modelId === 'string' && MODEL_ID_PATTERN.test(raw.modelId)
      ? raw.modelId
      : null;
  const runtimeKind = label(raw.runtimeKind);
  const format = label(raw.format);
  const version = label(raw.version);
  if (modelId === null || runtimeKind === null || format === null || version === null) {
    return null;
  }
  if (raw.device !== null && raw.device !== undefined && label(raw.device) === null) {
    return null;
  }
  return {
    modelId,
    runtimeKind,
    format,
    version,
    device: raw.device === null || raw.device === undefined ? null : (label(raw.device) as string),
  };
}

function sanitizeBox(value: unknown): NormalizedBox | null {
  const box = value as Partial<NormalizedBox> | null | undefined;
  const x = num01(box?.x);
  const y = num01(box?.y);
  const width = num01(box?.width);
  const height = num01(box?.height);
  return x !== null && y !== null && width !== null && height !== null
    ? { x, y, width, height }
    : null;
}

function sanitizeDetection(value: unknown): NormalizedDetection | null {
  const raw = value as Partial<NormalizedDetection> | null | undefined;
  const label = raw?.label;
  if (label !== 'PRODUCT' && label !== 'PRODUCT_IN_HAND' && label !== 'HAND') {
    return null;
  }
  const box = sanitizeBox(raw?.box);
  const timestampMs = intMs(raw?.timestampMs);
  const confidence = num01(raw?.confidence);
  if (box === null || timestampMs === null || confidence === null) {
    return null;
  }
  const quality = raw?.quality
    ? {
        sharpness: numAny(raw.quality.sharpness),
        occlusion: num01(raw.quality.occlusion),
        brightness: numAny(raw.quality.brightness),
      }
    : null;
  return { label, timestampMs, box, confidence, quality };
}

function sanitizeEmbeddingCandidate(value: unknown): EmbeddingCandidate | null {
  const raw = value as Partial<EmbeddingCandidate> | null | undefined;
  const similarity = num01(raw?.similarity);
  if (
    typeof raw?.sku !== 'string' ||
    !SKU_PATTERN.test(raw.sku) ||
    similarity === null
  ) {
    return null;
  }
  const productId =
    typeof raw.productId === 'string' && PRODUCT_ID_PATTERN.test(raw.productId)
      ? raw.productId
      : null;
  return { sku: raw.sku, productId, similarity };
}

function sanitizeHandSignal(value: unknown): HandSignalSummary | null {
  const raw = value as Partial<HandSignalSummary> | null | undefined;
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  return {
    handPresent: raw.handPresent === true,
    nearShelfZone: raw.nearShelfZone === true,
    enteredZoneAtMs: intMs(raw.enteredZoneAtMs),
    contactStartMs: intMs(raw.contactStartMs),
    contactEndMs: intMs(raw.contactEndMs),
    leftZoneAtMs: intMs(raw.leftZoneAtMs),
    contactDurationMs: intMs(raw.contactDurationMs),
  };
}

function sanitizeFeatures(value: unknown): InteractionFeatures | null {
  const raw = value as Partial<InteractionFeatures> | null | undefined;
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const action = raw.actionCandidate;
  return {
    preCropQuality: num01(raw.preCropQuality),
    peakCropQuality: num01(raw.peakCropQuality),
    postCropQuality: num01(raw.postCropQuality),
    bboxMovement: num01(raw.bboxMovement),
    handProximity: num01(raw.handProximity),
    objectDisappeared: boolOrNull(raw.objectDisappeared),
    objectAppeared: boolOrNull(raw.objectAppeared),
    occlusionScore: num01(raw.occlusionScore),
    sharpnessScore: numAny(raw.sharpnessScore),
    brightnessScore: numAny(raw.brightnessScore),
    topSkuCandidates: (Array.isArray(raw.topSkuCandidates)
      ? raw.topSkuCandidates
      : []
    )
      .map(sanitizeEmbeddingCandidate)
      .filter((row): row is EmbeddingCandidate => row !== null)
      .slice(0, 10),
    actionCandidate:
      action === 'PICKUP' ||
      action === 'RETURN' ||
      action === 'FALSE_TOUCH' ||
      action === 'UNKNOWN'
        ? action
        : 'UNKNOWN',
  };
}

/**
 * The ONLY door provider output passes through before persistence or an
 * API response. Field-by-field allowlist rebuild — anything a provider
 * emits that is not explicitly picked and pattern/range validated here
 * (paths, URLs, logs, tensors, encoded frame blobs) never leaves the
 * adapter.
 */
export function sanitizeProviderEvidence(raw: {
  provider: PretrainedProviderCode;
  availability: ProviderAvailability;
  reasonCode?: unknown;
  synthetic?: unknown;
  detections?: unknown;
  handSignal?: unknown;
  embeddingCandidates?: unknown;
  features?: unknown;
  notes?: unknown;
}): ProviderEvidence {
  return {
    provider: raw.provider,
    availability: raw.availability,
    reasonCode: code(raw.reasonCode),
    synthetic: raw.synthetic === true,
    detections: (Array.isArray(raw.detections) ? raw.detections : [])
      .map(sanitizeDetection)
      .filter((row): row is NormalizedDetection => row !== null)
      .slice(0, 64),
    handSignal: sanitizeHandSignal(raw.handSignal),
    embeddingCandidates: (Array.isArray(raw.embeddingCandidates)
      ? raw.embeddingCandidates
      : []
    )
      .map(sanitizeEmbeddingCandidate)
      .filter((row): row is EmbeddingCandidate => row !== null)
      .slice(0, 10),
    features: sanitizeFeatures(raw.features),
    notes: (Array.isArray(raw.notes) ? raw.notes : [])
      .map(code)
      .filter((row): row is string => row !== null)
      .slice(0, 16),
  };
}

// ------------------------------------------- interaction features (P19)

/**
 * RetailInteractionFeatureAdapter core: combine detector, hand, and
 * crop-quality signals into the structured feature set and a
 * PICKUP / RETURN / FALSE_TOUCH / UNKNOWN action CANDIDATE. UNKNOWN
 * always stays review-required downstream — this never auto-decides.
 */
export function deriveActionCandidate(signals: {
  handContact: boolean;
  objectDisappeared: boolean | null;
  objectAppeared: boolean | null;
}): ActionCandidate {
  if (!signals.handContact) {
    return 'UNKNOWN';
  }
  if (signals.objectDisappeared === true) {
    return 'PICKUP';
  }
  if (signals.objectAppeared === true) {
    return 'RETURN';
  }
  if (signals.objectDisappeared === false && signals.objectAppeared === false) {
    return 'FALSE_TOUCH';
  }
  return 'UNKNOWN';
}

export function buildInteractionFeatures(input: {
  detections: NormalizedDetection[];
  handSignal: HandSignalSummary | null;
  cropQuality: {
    pre: number | null;
    peak: number | null;
    post: number | null;
    occlusion: number | null;
    sharpness: number | null;
    brightness: number | null;
  };
  objectDisappeared: boolean | null;
  objectAppeared: boolean | null;
  topSkuCandidates: EmbeddingCandidate[];
}): InteractionFeatures {
  const productBoxes = input.detections.filter(
    (row) => row.label === 'PRODUCT' || row.label === 'PRODUCT_IN_HAND',
  );
  const handBoxes = input.detections.filter((row) => row.label === 'HAND');
  let bboxMovement: number | null = null;
  if (productBoxes.length >= 2) {
    const first = productBoxes[0].box;
    const last = productBoxes[productBoxes.length - 1].box;
    bboxMovement =
      Math.round(
        Math.min(
          1,
          Math.hypot(last.x - first.x, last.y - first.y),
        ) * 1000,
      ) / 1000;
  }
  let handProximity: number | null = null;
  if (productBoxes.length && handBoxes.length) {
    const product = productBoxes[0].box;
    const hand = handBoxes[0].box;
    const distance = Math.hypot(
      product.x + product.width / 2 - (hand.x + hand.width / 2),
      product.y + product.height / 2 - (hand.y + hand.height / 2),
    );
    handProximity = Math.round(Math.max(0, 1 - distance) * 1000) / 1000;
  }
  const handContact =
    input.handSignal?.contactDurationMs !== null &&
    input.handSignal?.contactDurationMs !== undefined
      ? input.handSignal.contactDurationMs > 0
      : (handProximity ?? 0) > 0.7;
  return {
    preCropQuality: input.cropQuality.pre,
    peakCropQuality: input.cropQuality.peak,
    postCropQuality: input.cropQuality.post,
    bboxMovement,
    handProximity,
    objectDisappeared: input.objectDisappeared,
    objectAppeared: input.objectAppeared,
    occlusionScore: input.cropQuality.occlusion,
    sharpnessScore: input.cropQuality.sharpness,
    brightnessScore: input.cropQuality.brightness,
    topSkuCandidates: input.topSkuCandidates.slice(0, 10),
    actionCandidate: deriveActionCandidate({
      handContact,
      objectDisappeared: input.objectDisappeared,
      objectAppeared: input.objectAppeared,
    }),
  };
}

// ------------------------------------------------------ deterministic

/** Small deterministic PRNG (mulberry32 over a string seed) for the
 *  lab-only stub adapters — reproducible synthetic evidence, no
 *  Math.random, no wall clock. */
export function seededRandom(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i += 1) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
