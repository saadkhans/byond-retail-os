import { InferenceJobStatus, PickupDetectionState } from './api';

/**
 * Pure presentation logic for the pickup-detection panel — kept free of
 * React so it is unit-testable (vitest) without a DOM.
 */

/** 0.6234 → "62%" (never claims more precision than the method has). */
export function confidencePercent(confidence: number): string {
  const bounded = Math.max(0, Math.min(1, confidence));
  return `${Math.round(bounded * 100)}%`;
}

/** Marker position on the timeline bar, clamped to [0, 100]. */
export function markerPercent(
  timestampMs: number,
  durationMs: number | null,
): number {
  if (durationMs === null || durationMs <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(100, (timestampMs / durationMs) * 100));
}

/** ms → "3.2 s" for the timestamps row. */
export function formatMs(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

/** The UI vocabulary for job states (requirement: QUEUED, RUNNING,
 *  COMPLETED, FAILED) mapped from the API's job statuses. */
export function jobStatusLabel(status: InferenceJobStatus): string {
  return status === 'SUCCEEDED' ? 'COMPLETED' : status;
}

/** Is the detection attempt still moving (UI should poll)? */
export function jobInFlight(status: InferenceJobStatus | undefined): boolean {
  return status === 'QUEUED' || status === 'RUNNING';
}

/** Human line for the detection outcome. */
export function detectionHeadline(
  state: PickupDetectionState,
): string | null {
  const detection = state.detection;
  if (!detection) {
    return null;
  }
  if (detection.result === 'UNKNOWN_PRODUCT') {
    return 'Pickup detected — product not recognized (below the match-score threshold)';
  }
  return detection.productName
    ? `Pickup detected — ${detection.productName} (${detection.sku ?? ''})`
    : `Pickup detected — ${detection.sku ?? 'product'}`;
}

/** Reviews are only writable while the event is pending. */
export function canReview(state: PickupDetectionState): boolean {
  return (
    state.detection !== null &&
    state.detection.visionEventStatus === 'PENDING_REVIEW'
  );
}

export interface GroundTruthFormInput {
  eventKind: 'PICKUP' | 'RETURN' | 'NONE';
  productId: string;
  timestampMs: string;
  quantity: string;
  durationMs: number | null;
}

export interface GroundTruthFieldErrors {
  productId?: string;
  timestampMs?: string;
  quantity?: string;
}

/**
 * Ground-truth form validation — pure and exhaustively testable. Every
 * invalid field gets a VISIBLE message (a submit is never silently
 * swallowed), and the parsed payload guarantees numbers travel as
 * numbers: `Number('')`/NaN can never reach the API.
 */
export function validateGroundTruth(input: GroundTruthFormInput):
  | { ok: true; payload: { eventKind: string; productId?: string; actualTimestampMs?: number; quantity?: number } }
  | { ok: false; errors: GroundTruthFieldErrors } {
  if (input.eventKind === 'NONE') {
    return { ok: true, payload: { eventKind: 'NONE' } };
  }
  const errors: GroundTruthFieldErrors = {};
  if (!input.productId) {
    errors.productId = 'Select the actual product.';
  }
  const trimmedTs = input.timestampMs.trim();
  const timestamp = Number(trimmedTs);
  if (trimmedTs === '' || !Number.isInteger(timestamp) || timestamp < 0) {
    errors.timestampMs = 'Enter the actual instant in whole milliseconds.';
  } else if (input.durationMs !== null && timestamp >= input.durationMs) {
    errors.timestampMs = `Must be below the clip duration (${input.durationMs} ms).`;
  }
  const quantity = Number(input.quantity.trim());
  if (
    input.quantity.trim() === '' ||
    !Number.isInteger(quantity) ||
    quantity < 1 ||
    quantity > 100
  ) {
    errors.quantity = 'Quantity must be a whole number of at least 1.';
  }
  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    payload: {
      eventKind: input.eventKind,
      productId: input.productId,
      actualTimestampMs: timestamp,
      quantity,
    },
  };
}
