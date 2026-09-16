import { Trigger } from '../trigger/trigger.types';

/**
 * Where triggers go. A port, so the queue can be exercised in tests
 * without a network and so a broker-backed transport can replace the HTTP
 * client later exactly as ARCHITECTURE.md describes for the API's own
 * queue: "each arrives as an adapter behind the contracts, never as a
 * rewrite".
 */

/**
 * The submission verdict, as a closed vocabulary. The distinction that
 * matters is RETRYABLE versus not: a descriptor the API rejected will be
 * rejected identically forever, so retrying it is a way to turn one bug
 * into a sustained load; a connection failure is worth backing off on.
 */
export const SUBMIT_OUTCOMES = [
  'ACCEPTED',
  'DUPLICATE',
  'REJECTED',
  'UNAUTHORIZED',
  'UNAVAILABLE',
  'TIMEOUT',
] as const;
export type SubmitOutcome = (typeof SUBMIT_OUTCOMES)[number];

export function isRetryable(outcome: SubmitOutcome): boolean {
  // REJECTED and UNAUTHORIZED are decisions, not weather: the same
  // request will get the same answer. DUPLICATE already succeeded — the
  // API's idempotency key did its job.
  return outcome === 'UNAVAILABLE' || outcome === 'TIMEOUT';
}

export interface SubmitResult {
  outcome: SubmitOutcome;
  /** The API's job id, when it accepted one. Opaque. */
  jobId?: string;
}

/** The typed job the pipeline asks the API to create. Mirrors the API's
 *  CreateInferenceJob contract without importing it — the two packages
 *  ship independently and the wire shape is the seam. */
export interface InferenceJobRequest {
  jobType: string;
  locationId?: string;
  unitId?: string;
  deviceId?: string;
  priority: number;
  sourceType: string;
  sourceId: string;
  inputDescriptor: Record<string, unknown>;
  idempotencyKey: string;
}

export abstract class InferenceClientPort {
  abstract readonly kind: string;

  abstract submit(request: InferenceJobRequest): Promise<SubmitResult>;
}

/** Built from a trigger; exported so the queue and the client agree on
 *  what a pending item is. */
export interface PendingSubmission {
  request: InferenceJobRequest;
  trigger: Trigger;
  attempts: number;
  /** Earliest time this may be retried — set by the backoff schedule. */
  notBefore: number;
}
