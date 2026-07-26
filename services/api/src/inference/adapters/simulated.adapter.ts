import { BadRequestException, Injectable } from '@nestjs/common';
import { InferenceJobType, VisionEventType } from '@prisma/client';
import { PG_INT_MAX } from '../../common/integer-bounds';
import { BASKET_AFFECTING_EVENT_TYPES } from '../../common/vision-event-policy';
import {
  InferenceAdapter,
  InferenceAdapterInput,
  InferenceAdapterRawOutput,
  InferenceJobContext,
  NormalizedInferenceResult,
  RankedCandidate,
} from './inference-adapter';

export const SIMULATED_ADAPTER_KEY = 'simulated';

/** Mirrors MAX_CANDIDATES in ml/scripts/sample_inference_to_vision_event.py. */
export const MAX_CANDIDATES = 20;

/**
 * Round a [0, 1] score to 4 decimals with round-half-to-EVEN, matching
 * Python's round(x, 4) in the Phase 8 mapper exactly.
 *
 * Neither naive JS idiom is Python-compatible: round(x * 10000) / 10000
 * introduces FP error in the scaled product (which can cross a .5 boundary
 * the true value never reaches), and toFixed(4) rounds ties half-AWAY —
 * Python emits round(0.03125, 4) === 0.0312 (down to even) while
 * (0.03125).toFixed(4) === "0.0313". Binary-exact ties (0.03125, 0.09375,
 * 0.15625, ...) are real inputs, so the tie rule matters.
 *
 * toFixed(25) is the decision base: the smallest positive 4-decimal tie
 * point is 0.00005, where doubles are spaced ~7e-21 apart, so 25 decimal
 * digits of the exact value always distinguish a true tie (…5 then zeros)
 * from every neighboring double. (20 digits are NOT enough near zero —
 * round(0.00005, 4) diverged from Python before this was widened.)
 */
export function roundScoreHalfEven(value: number): number {
  const fixed = value.toFixed(25);
  const dot = fixed.indexOf('.');
  const integer = fixed.slice(0, dot);
  const decimals = fixed.slice(dot + 1);
  const kept = decimals.slice(0, 4);
  const next = decimals[4] ?? '0';
  const tail = decimals.slice(5);
  const roundUp =
    next > '5' ||
    (next === '5' &&
      (/[1-9]/.test(tail) || Number(kept[3]) % 2 === 1));
  const truncated = Number(`${integer}.${kept}`);
  if (!roundUp) {
    return truncated;
  }
  // The +1e-4 step lands within ~1e-17 of an exact 4-decimal target, so
  // re-rounding with toFixed(4) always snaps to the intended value.
  return Number((truncated + 0.0001).toFixed(4));
}

/**
 * The Phase 9 simulated adapter: no real ML, no model download, no runtime
 * dependency. It takes caller-supplied sample model output, validates it
 * against the internal model-output contract, and normalizes detections into
 * the ranked-candidate result shape — matching the Phase 8 mapper
 * (ml/scripts/sample_inference_to_vision_event.py): duplicate SKUs
 * collapse to the strongest detection (first seen wins a tie), candidates
 * sort by confidence descending, ranks are 1-based, scores round to 4
 * decimals with round-half-to-EVEN (identical to Python's round(x, 4),
 * including binary-exact ties like 0.03125 → 0.0312 — see
 * roundScoreHalfEven), and the list caps at 20. Useful for tests and the
 * admin UI; real adapters replace `run()` in later phases.
 */
@Injectable()
export class SimulatedInferenceAdapter implements InferenceAdapter {
  readonly adapterKey = SIMULATED_ADAPTER_KEY;
  // The simulated adapter echoes sample output, so every job type is
  // supported; real adapters declare the subset they can actually run.
  readonly supportedJobTypes: readonly InferenceJobType[] =
    Object.values(InferenceJobType);

  validateInput(context: InferenceJobContext, input: InferenceAdapterInput): void {
    if (!this.supportedJobTypes.includes(context.jobType)) {
      throw new BadRequestException(
        `Adapter "${this.adapterKey}" does not support job type ${context.jobType}`,
      );
    }
    if (Number.isNaN(Date.parse(input.occurredAt))) {
      throw new BadRequestException(
        'occurredAt must be a valid ISO 8601 timestamp (the source-' +
          'reported interaction time)',
      );
    }
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

  /**
   * No real ML: simulated "inference" echoes the sample model output. The
   * job context is where a real adapter reads its crop/zone references
   * (by id) from — the simulated adapter has nothing to fetch.
   */
  run(
    _context: InferenceJobContext,
    input: InferenceAdapterInput,
  ): Promise<InferenceAdapterRawOutput> {
    return Promise.resolve(input);
  }

  normalizeResult(output: InferenceAdapterRawOutput): NormalizedInferenceResult {
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
        score: roundScoreHalfEven(candidate.confidence),
        ...(candidate.label !== undefined ? { label: candidate.label } : {}),
      }));
    return {
      eventType: output.eventType,
      quantityDelta: output.quantityDelta,
      occurredAt: new Date(output.occurredAt),
      candidates,
      evidenceScore: candidates[0]?.score,
      evidenceQuality: output.evidenceQuality,
      modelKey: output.modelKey,
      modelVersion: output.modelVersion,
    };
  }
}
