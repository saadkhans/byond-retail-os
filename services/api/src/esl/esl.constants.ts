/** Platform module code gating every ESL route. */
export const ESL_MODULE_CODE = 'esl';

/**
 * Lease taken by each claim. Shorter than the inference queue's 300 s because
 * a label push is a small, fast vendor call — a worker that has held a label
 * for two minutes has hung, and the label should be recoverable.
 */
export const ESL_UPDATE_LEASE_SECONDS = 120;

/**
 * A job whose lease expired with this many attempts already spent FAILS with
 * LEASE_EXPIRED instead of requeueing: at-least-once delivery, never an
 * infinite crash loop. Same contract as INFERENCE_JOB_MAX_ATTEMPTS.
 */
export const ESL_UPDATE_MAX_ATTEMPTS = 3;

/**
 * Exponential backoff base. Attempt n becomes claimable again
 * `BASE * 2^(n-1)` seconds after it failed, so a flapping gateway backs off
 * instead of burning its attempt budget in one second.
 */
export const ESL_UPDATE_BACKOFF_BASE_SECONDS = 30;

/** Default page size for the job and label listings. */
export const ESL_DEFAULT_TAKE = 50;
export const ESL_MAX_TAKE = 200;

/** How many jobs one process() call may claim. */
export const ESL_PROCESS_MAX_BATCH = 100;

/** The adapter every deployment has; used when no vendor is configured. */
export const SIMULATED_VENDOR_CODE = 'SIMULATED';
