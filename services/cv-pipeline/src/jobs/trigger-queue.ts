import {
  InferenceClientPort,
  InferenceJobRequest,
  PendingSubmission,
  SubmitOutcome,
  isRetryable,
} from './inference-client.port';
import { Trigger } from '../trigger/trigger.types';

/**
 * The bounded buffer between tier 2 and the API.
 *
 * The failure this exists to prevent is the one that takes a store down
 * quietly: the API becomes unreachable, triggers keep arriving because
 * the camera has no idea, and an unbounded buffer grows until the process
 * dies — taking tracking with it. So:
 *
 * - CAPACITY IS FIXED. At capacity the OLDEST pending submission is
 *   dropped, not the newest. A minute-old moment is worth less than the
 *   one happening now, and the alternative — refusing new work — means
 *   the store stops being observed the moment it gets busy.
 * - DROPS ARE COUNTED, never silent. `droppedForCapacity` is the number
 *   an operator needs to know the pipeline is degraded rather than quiet.
 * - TRACKING NEVER BLOCKS ON IT. `offer` is synchronous and always
 *   returns; draining happens on its own schedule.
 * - RETRIES ARE ONLY FOR WEATHER. A rejected descriptor is rejected
 *   forever, so it is dropped on the first answer instead of being
 *   retried into a sustained load against a failing endpoint.
 */

export interface TriggerQueueConfig {
  capacity: number;
  maxAttempts: number;
  /** First retry delay; doubles per attempt up to the ceiling. */
  backoffBaseMs: number;
  backoffMaxMs: number;
}

export interface QueueCounters {
  accepted: number;
  duplicate: number;
  rejected: number;
  droppedForCapacity: number;
  droppedForAttempts: number;
  retries: number;
  depth: number;
  /** The last non-success outcome, as a code. Never a message, never a
   *  URL — an operator gets the class of failure and nothing quotable. */
  lastErrorCode: SubmitOutcome | null;
}

export class TriggerQueue {
  private readonly pending: PendingSubmission[] = [];

  private accepted = 0;
  private duplicate = 0;
  private rejected = 0;
  private droppedForCapacity = 0;
  private droppedForAttempts = 0;
  private retries = 0;
  private lastErrorCode: SubmitOutcome | null = null;

  constructor(
    private readonly client: InferenceClientPort,
    private readonly config: TriggerQueueConfig,
  ) {}

  counters(): QueueCounters {
    return {
      accepted: this.accepted,
      duplicate: this.duplicate,
      rejected: this.rejected,
      droppedForCapacity: this.droppedForCapacity,
      droppedForAttempts: this.droppedForAttempts,
      retries: this.retries,
      depth: this.pending.length,
      lastErrorCode: this.lastErrorCode,
    };
  }

  /**
   * Enqueue one submission. Never throws, never blocks, and never grows
   * past capacity. Returns false when an older item had to be dropped to
   * make room, so the caller can log the degradation once rather than
   * discovering it from a counter much later.
   */
  offer(request: InferenceJobRequest, trigger: Trigger, now: number): boolean {
    let madeRoom = true;
    while (this.pending.length >= this.config.capacity) {
      this.pending.shift();
      this.droppedForCapacity += 1;
      madeRoom = false;
    }
    this.pending.push({ request, trigger, attempts: 0, notBefore: now });
    return madeRoom;
  }

  /**
   * Attempt every submission whose backoff has elapsed, oldest first.
   *
   * Sequential on purpose: a parallel drain against an API that is
   * already struggling is how a recoverable outage becomes an outage that
   * does not recover. The loop also stops at the first retryable failure
   * — if the API is down for one item it is down for the next, and
   * hammering it with the rest of the queue helps nobody.
   */
  async drain(now: number): Promise<void> {
    while (this.pending.length > 0) {
      const item = this.pending[0];
      if (item.notBefore > now) {
        // The head is still backing off; everything behind it is newer.
        return;
      }
      this.pending.shift();
      item.attempts += 1;

      const result = await this.client.submit(item.request);
      if (result.outcome === 'ACCEPTED') {
        this.accepted += 1;
        continue;
      }
      if (result.outcome === 'DUPLICATE') {
        // The API's idempotency key recognised a replay. That is a
        // success: at-least-once delivery working as designed.
        this.duplicate += 1;
        continue;
      }

      this.lastErrorCode = result.outcome;

      if (!isRetryable(result.outcome)) {
        this.rejected += 1;
        continue;
      }
      if (item.attempts >= this.config.maxAttempts) {
        this.droppedForAttempts += 1;
        return;
      }

      // Re-queue at the FRONT: order matters for reconciliation, and a
      // failed item that goes to the back can starve behind a steady
      // stream of new triggers.
      item.notBefore = now + this.backoffFor(item.attempts);
      this.pending.unshift(item);
      this.retries += 1;
      return;
    }
  }

  /**
   * Exponential backoff with a ceiling. No jitter: a single pipeline
   * process per camera is not a thundering herd, and a deterministic
   * schedule is one a test can assert exactly.
   */
  private backoffFor(attempts: number): number {
    const delay = this.config.backoffBaseMs * 2 ** (attempts - 1);
    return Math.min(delay, this.config.backoffMaxMs);
  }
}
