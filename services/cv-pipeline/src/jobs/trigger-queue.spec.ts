import {
  InferenceClientPort,
  InferenceJobRequest,
  SubmitOutcome,
  SubmitResult,
  isRetryable,
} from './inference-client.port';
import { TriggerQueue, TriggerQueueConfig } from './trigger-queue';
import { Trigger } from '../trigger/trigger.types';

const CONFIG: TriggerQueueConfig = {
  capacity: 3,
  maxAttempts: 3,
  backoffBaseMs: 1_000,
  backoffMaxMs: 10_000,
};

/** A client whose answers are scripted, so the queue's reaction to each
 *  outcome can be asserted without a network. */
class ScriptedClient extends InferenceClientPort {
  readonly kind = 'scripted';
  readonly seen: InferenceJobRequest[] = [];

  constructor(private readonly script: SubmitOutcome[]) {
    super();
  }

  submit(request: InferenceJobRequest): Promise<SubmitResult> {
    this.seen.push(request);
    // The last scripted outcome repeats once the script runs out.
    const outcome =
      this.script[Math.min(this.seen.length - 1, this.script.length - 1)];
    return Promise.resolve({ outcome });
  }
}

function request(id: string): InferenceJobRequest {
  return {
    jobType: 'PRODUCT_RECOGNITION',
    priority: 200,
    sourceType: 'VISION',
    sourceId: id,
    inputDescriptor: { trigger: { kind: 'HAND_IN_ZONE' } },
    idempotencyKey: id,
  };
}

const TRIGGER: Trigger = {
  kind: 'HAND_IN_ZONE',
  zoneCode: 'A1',
  startedAt: new Date(0),
  endedAt: new Date(1_000),
  startFrameIndex: 1,
  endFrameIndex: 5,
  evidence: {
    peakMotionRatio: 0.4,
    peakZoneCoverage: 0.5,
    peakPresenceConfidence: 0.5,
    frameCount: 5,
  },
};

describe('isRetryable', () => {
  it('retries weather, never decisions', () => {
    expect(isRetryable('UNAVAILABLE')).toBe(true);
    expect(isRetryable('TIMEOUT')).toBe(true);
    // A rejected descriptor is rejected forever; retrying it turns one bug
    // into sustained load against an endpoint that is already saying no.
    expect(isRetryable('REJECTED')).toBe(false);
    expect(isRetryable('UNAUTHORIZED')).toBe(false);
    expect(isRetryable('ACCEPTED')).toBe(false);
    expect(isRetryable('DUPLICATE')).toBe(false);
  });
});

describe('TriggerQueue — happy path', () => {
  it('submits queued items oldest first and counts them', async () => {
    const client = new ScriptedClient(['ACCEPTED']);
    const queue = new TriggerQueue(client, CONFIG);

    queue.offer(request('a'), TRIGGER, 0);
    queue.offer(request('b'), TRIGGER, 0);
    await queue.drain(0);

    expect(client.seen.map((item) => item.sourceId)).toEqual(['a', 'b']);
    expect(queue.counters().accepted).toBe(2);
    expect(queue.counters().depth).toBe(0);
  });

  it('counts a DUPLICATE as a success, not a failure', async () => {
    const client = new ScriptedClient(['DUPLICATE']);
    const queue = new TriggerQueue(client, CONFIG);

    queue.offer(request('a'), TRIGGER, 0);
    await queue.drain(0);

    const counters = queue.counters();
    expect(counters.duplicate).toBe(1);
    expect(counters.rejected).toBe(0);
    expect(counters.depth).toBe(0);
  });
});

describe('TriggerQueue — backpressure', () => {
  it('drops the OLDEST pending item at capacity and counts the drop', () => {
    const client = new ScriptedClient(['UNAVAILABLE']);
    const queue = new TriggerQueue(client, CONFIG);

    expect(queue.offer(request('a'), TRIGGER, 0)).toBe(true);
    expect(queue.offer(request('b'), TRIGGER, 0)).toBe(true);
    expect(queue.offer(request('c'), TRIGGER, 0)).toBe(true);
    // Capacity is 3; the fourth evicts the first and reports degradation.
    expect(queue.offer(request('d'), TRIGGER, 0)).toBe(false);

    const counters = queue.counters();
    expect(counters.depth).toBe(3);
    expect(counters.droppedForCapacity).toBe(1);
  });

  it('keeps the newest moments when the API is unreachable', async () => {
    const client = new ScriptedClient(['ACCEPTED']);
    const queue = new TriggerQueue(client, CONFIG);

    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      queue.offer(request(id), TRIGGER, 0);
    }
    await queue.drain(0);

    // 'a' and 'b' were evicted; the three most recent survived, because a
    // minute-old moment is worth less than the one happening now.
    expect(client.seen.map((item) => item.sourceId)).toEqual(['c', 'd', 'e']);
  });

  it('never blocks the caller', () => {
    const client = new ScriptedClient(['UNAVAILABLE']);
    const queue = new TriggerQueue(client, { ...CONFIG, capacity: 1 });
    for (let index = 0; index < 1_000; index += 1) {
      queue.offer(request(`t${index}`), TRIGGER, 0);
    }
    expect(queue.counters().depth).toBe(1);
    expect(queue.counters().droppedForCapacity).toBe(999);
  });
});

describe('TriggerQueue — retries and degradation', () => {
  it('backs off exponentially and stops draining while the head waits', async () => {
    const client = new ScriptedClient(['UNAVAILABLE']);
    const queue = new TriggerQueue(client, CONFIG);

    queue.offer(request('a'), TRIGGER, 0);
    queue.offer(request('b'), TRIGGER, 0);

    await queue.drain(0);
    // One attempt, then the head backs off; 'b' is not hammered against an
    // API that just failed.
    expect(client.seen).toHaveLength(1);
    expect(queue.counters().retries).toBe(1);

    // Still inside the first backoff window.
    await queue.drain(500);
    expect(client.seen).toHaveLength(1);

    // Backoff elapsed: the head is retried.
    await queue.drain(1_000);
    expect(client.seen).toHaveLength(2);
    expect(client.seen[1].sourceId).toBe('a');

    // Second backoff is double the first.
    await queue.drain(2_000);
    expect(client.seen).toHaveLength(2);
    await queue.drain(3_000);
    expect(client.seen).toHaveLength(3);
  });

  it('gives up after maxAttempts and counts the abandonment', async () => {
    const client = new ScriptedClient(['UNAVAILABLE']);
    const queue = new TriggerQueue(client, CONFIG);

    queue.offer(request('a'), TRIGGER, 0);
    await queue.drain(0);
    await queue.drain(1_000);
    await queue.drain(3_000);

    const counters = queue.counters();
    expect(counters.droppedForAttempts).toBe(1);
    expect(counters.depth).toBe(0);
    expect(counters.lastErrorCode).toBe('UNAVAILABLE');
  });

  it('caps the backoff at the configured ceiling', async () => {
    const client = new ScriptedClient(['TIMEOUT']);
    const queue = new TriggerQueue(client, {
      capacity: 5,
      maxAttempts: 10,
      backoffBaseMs: 1_000,
      backoffMaxMs: 2_000,
    });

    queue.offer(request('a'), TRIGGER, 0);
    await queue.drain(0); // attempt 1 -> wait 1000
    await queue.drain(1_000); // attempt 2 -> wait 2000 (capped)
    await queue.drain(3_000); // attempt 3 -> wait 2000 (capped, not 4000)
    await queue.drain(5_000); // attempt 4

    expect(client.seen).toHaveLength(4);
  });

  it('drops a rejected descriptor immediately rather than retrying it', async () => {
    const client = new ScriptedClient(['REJECTED']);
    const queue = new TriggerQueue(client, CONFIG);

    queue.offer(request('a'), TRIGGER, 0);
    queue.offer(request('b'), TRIGGER, 0);
    await queue.drain(0);

    // Both were attempted once and neither was re-queued.
    expect(client.seen).toHaveLength(2);
    expect(queue.counters().rejected).toBe(2);
    expect(queue.counters().retries).toBe(0);
    expect(queue.counters().depth).toBe(0);
  });

  it('recovers and drains once the API comes back', async () => {
    const client = new ScriptedClient(['UNAVAILABLE', 'ACCEPTED']);
    const queue = new TriggerQueue(client, CONFIG);

    queue.offer(request('a'), TRIGGER, 0);
    await queue.drain(0);
    expect(queue.counters().accepted).toBe(0);

    await queue.drain(1_000);
    expect(queue.counters().accepted).toBe(1);
    expect(queue.counters().depth).toBe(0);
  });

  it('reports the last error as a code and never a message', async () => {
    const client = new ScriptedClient(['UNAUTHORIZED']);
    const queue = new TriggerQueue(client, CONFIG);

    queue.offer(request('a'), TRIGGER, 0);
    await queue.drain(0);

    const counters = queue.counters();
    expect(counters.lastErrorCode).toBe('UNAUTHORIZED');
    // Everything else in the snapshot is a number.
    const { lastErrorCode, ...rest } = counters;
    void lastErrorCode;
    for (const value of Object.values(rest)) {
      expect(typeof value).toBe('number');
    }
  });
});
