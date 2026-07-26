import { BadRequestException, Injectable } from '@nestjs/common';
import { InferenceJobType, VisionEventType } from '@prisma/client';
import { PG_INT_MAX } from '../../common/integer-bounds';
import { BASKET_AFFECTING_EVENT_TYPES } from '../../common/vision-event-policy';
import {
  InferenceAdapter,
  InferenceAdapterInput,
  NormalizedInferenceResult,
  RankedCandidate,
} from './inference-adapter';

export const SIMULATED_ADAPTER_KEY = 'simulated';

/** Mirrors MAX_CANDIDATES in ml/scripts/sample_inference_to_vision_event.py. */
export const MAX_CANDIDATES = 20;

/**
 * The Phase 9 simulated adapter: no real ML, no model download, no runtime
 * dependency. It takes caller-supplied sample model output, validates it
 * against the internal model-output contract, and normalizes detections into
 * the ranked-candidate result shape — with EXACT parity to the Phase 8
 * mapper (ml/scripts/sample_inference_to_vision_event.py): duplicate SKUs
 * collapse to the strongest detection (first seen wins a tie), candidates
 * sort by confidence descending, ranks are 1-based, scores round to 4
 * decimals, and the list caps at 20. Useful for tests and the admin UI;
 * real adapters replace `run()` in later phases.
 */
@Injectable()
export class SimulatedInferenceAdapter implements InferenceAdapter {
  readonly adapterKey = SIMULATED_ADAPTER_KEY;
  // The simulated adapter echoes sample output, so every job type is
  // supported; real adapters declare the subset they can actually run.
  readonly supportedJobTypes: readonly InferenceJobType[] =
    Object.values(InferenceJobType);

  validateInput(input: InferenceAdapterInput): void {
    if (!Number.isInteger(input.quantityDelta) || input.quantityDelta === 0) {
      throw new BadRequestException('quantityDelta must be a non-zero integer');
    }
    if (Math.abs(input.quantityDelta) > PG_INT_MAX) {
      throw new BadRequestException(
        `quantityDelta magnitude must not exceed ${PG_INT_MAX}`,
      );
    }
    // The sign carries the direction (the VisionEvent conversion emits the
    // magnitude): negative is only valid for PRODUCT_RETURN, and a return is
    // always negative — same rule as the Phase 8 mapper.
    if (
      input.quantityDelta < 0 &&
      input.eventType !== VisionEventType.PRODUCT_RETURN
    ) {
      throw new BadRequestException(
        'negative quantityDelta is only valid with eventType PRODUCT_RETURN',
      );
    }
    if (
      input.quantityDelta > 0 &&
      input.eventType === VisionEventType.PRODUCT_RETURN
    ) {
      throw new BadRequestException(
        'PRODUCT_RETURN requires a negative quantityDelta',
      );
    }
    if (
      input.detections.length === 0 &&
      BASKET_AFFECTING_EVENT_TYPES.includes(input.eventType)
    ) {
      throw new BadRequestException(
        'basket-affecting event types require at least one detection',
      );
    }
    for (const [index, detection] of input.detections.entries()) {
      if (detection.sku.trim().length === 0) {
        throw new BadRequestException(
          `detections[${index}].sku must not be blank`,
        );
      }
      if (
        !Number.isFinite(detection.confidence) ||
        detection.confidence < 0 ||
        detection.confidence > 1
      ) {
        throw new BadRequestException(
          `detections[${index}].confidence must be within [0, 1]`,
        );
      }
    }
  }

  /** No real ML: simulated "inference" echoes the sample model output. */
  run(input: InferenceAdapterInput): Promise<InferenceAdapterInput> {
    return Promise.resolve(input);
  }

  normalizeResult(output: InferenceAdapterInput): NormalizedInferenceResult {
    // Collapse duplicate SKUs (uppercase-normalized): keep the strongest
    // detection per SKU; on an exact confidence tie the first-seen entry
    // wins — identical to the Phase 8 mapper.
    const strongestBySku = new Map<
      string,
      { sku: string; confidence: number; label?: string }
    >();
    for (const detection of output.detections) {
      const sku = detection.sku.trim().toUpperCase();
      const existing = strongestBySku.get(sku);
      if (!existing || detection.confidence > existing.confidence) {
        strongestBySku.set(sku, {
          sku,
          confidence: detection.confidence,
          label: detection.label,
        });
      }
    }
    // Array.prototype.sort is stable, so equal confidences keep first-seen
    // order (Python sort parity).
    const candidates: RankedCandidate[] = [...strongestBySku.values()]
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, MAX_CANDIDATES)
      .map((candidate, index) => ({
        sku: candidate.sku,
        rank: index + 1,
        score: Math.round(candidate.confidence * 10_000) / 10_000,
        ...(candidate.label !== undefined ? { label: candidate.label } : {}),
      }));
    return {
      eventType: output.eventType,
      quantityDelta: output.quantityDelta,
      candidates,
      evidenceScore: candidates[0]?.score,
      evidenceQuality: output.evidenceQuality,
      modelKey: output.modelKey,
      modelVersion: output.modelVersion,
    };
  }
}
