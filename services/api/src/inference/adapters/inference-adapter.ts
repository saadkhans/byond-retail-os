import {
  EvidenceQuality,
  InferenceJobType,
  VisionEventType,
} from '@prisma/client';

/**
 * One raw detection reported by a model/detector: an (already catalog-
 * normalized) SKU string with a [0, 1] confidence and an optional opaque
 * label. This is the internal model-output shape shared with the Phase 8
 * mapper (ml/scripts/sample_inference_to_vision_event.py) — field
 * spellings are kept in lockstep.
 */
export interface InferenceDetectionInput {
  sku: string;
  confidence: number;
  label?: string;
}

/**
 * The provider-neutral input an adapter runs on: the event suggestion
 * (eventType + signed quantityDelta) plus the raw detections. NO raw media,
 * frames, or storage references of any kind — heavy inference operates on
 * data the caller already reduced to safe, typed fields.
 */
export interface InferenceAdapterInput {
  jobType: InferenceJobType;
  eventType: VisionEventType;
  quantityDelta: number;
  detections: InferenceDetectionInput[];
  evidenceQuality?: EvidenceQuality;
  modelKey?: string;
  modelVersion?: string;
}

/** A ranked SKU candidate (rank 1 = strongest), score rounded to 4 dp. */
export interface RankedCandidate {
  sku: string;
  rank: number;
  score: number;
  label?: string;
}

/**
 * The normalized outcome an adapter produces: what InferenceResult persists
 * and what the VisionEvent conversion consumes. Candidate ranking follows
 * the exact Phase 8 mapper rules (dedupe by uppercased SKU keeping the
 * strongest, sort by score descending, 1-based ranks, cap 20).
 */
export interface NormalizedInferenceResult {
  eventType: VisionEventType;
  quantityDelta: number;
  candidates: RankedCandidate[];
  evidenceScore?: number;
  evidenceQuality?: EvidenceQuality;
  modelKey?: string;
  modelVersion?: string;
}

/**
 * Provider-neutral adapter contract. Real detector/OCR/VLM providers plug in
 * behind this interface in later phases — core code depends only on the
 * contract and never names a vendor. Phase 9 ships exactly one
 * implementation: the simulated adapter (no real ML).
 *
 * `validateInput` throws a BadRequestException naming the offending field;
 * `run` executes the (simulated) inference; `normalizeResult` reduces raw
 * output to the ranked-candidate result shape.
 */
export interface InferenceAdapter {
  readonly adapterKey: string;
  readonly supportedJobTypes: readonly InferenceJobType[];
  validateInput(input: InferenceAdapterInput): void;
  run(input: InferenceAdapterInput): Promise<InferenceAdapterInput>;
  normalizeResult(output: InferenceAdapterInput): NormalizedInferenceResult;
}
