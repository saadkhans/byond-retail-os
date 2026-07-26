import {
  EvidenceQuality,
  EvidenceSourceType,
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
 * The CLAIMED JOB a run belongs to: id, tenant, and the screened trigger
 * context (store/unit/device/session binding, source lineage, and the safe
 * input descriptor with its crop/zone references BY ID). A real detector/
 * OCR/VLM adapter needs exactly this to do its work — it never performs an
 * out-of-band lookup, and it still receives NO raw media, frames, or
 * storage references of any kind.
 */
export interface InferenceJobContext {
  jobId: string;
  tenantId: string;
  jobType: InferenceJobType;
  locationId?: string;
  unitId?: string;
  deviceId?: string;
  sessionId?: string;
  sourceType: EvidenceSourceType;
  sourceId?: string;
  inputDescriptor?: unknown;
}

/**
 * The provider-neutral model-output input an adapter validates and runs
 * on: the event suggestion (eventType + signed quantityDelta), the
 * source-reported occurrence time, and the raw detections. For the Phase 9
 * simulated adapter this is caller-supplied sample output; a real adapter
 * treats it as the provider response envelope it must reduce.
 */
export interface InferenceAdapterInput {
  eventType: VisionEventType;
  quantityDelta: number;
  occurredAt: string;
  detections: InferenceDetectionInput[];
  evidenceQuality?: EvidenceQuality;
  modelKey?: string;
  modelVersion?: string;
}

/**
 * The RAW output of a run, before normalization. Kept as the internal
 * model-output shape: the simulated adapter echoes its input; a real
 * adapter reduces its provider response to this same shape inside run(),
 * so normalizeResult() stays provider-neutral.
 */
export type InferenceAdapterRawOutput = InferenceAdapterInput;

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
 * strongest, sort by score descending, 1-based ranks, cap 20). occurredAt
 * is the SOURCE-reported interaction time carried through from the input —
 * never the completion time.
 */
export interface NormalizedInferenceResult {
  eventType: VisionEventType;
  quantityDelta: number;
  occurredAt: Date;
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
 * Every call receives the claimed job's context, so a real provider can act
 * on the job it was handed (tenant, job type, screened input descriptor)
 * without changing core service code or looking anything up out of band.
 * `validateInput` throws a BadRequestException naming the offending field;
 * `run` executes the (simulated) inference and returns raw output;
 * `normalizeResult` reduces raw output to the ranked-candidate result shape.
 */
export interface InferenceAdapter {
  readonly adapterKey: string;
  readonly supportedJobTypes: readonly InferenceJobType[];
  validateInput(context: InferenceJobContext, input: InferenceAdapterInput): void;
  run(
    context: InferenceJobContext,
    input: InferenceAdapterInput,
  ): Promise<InferenceAdapterRawOutput>;
  normalizeResult(output: InferenceAdapterRawOutput): NormalizedInferenceResult;
}
