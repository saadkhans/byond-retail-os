import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import { createSequentialRunner, type RunnerSnapshot } from './clip-batch-runner';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const settle = async (rounds = 20) => {
  for (let i = 0; i < rounds; i += 1) await tick();
};

describe('createSequentialRunner', () => {
  it('runs items one at a time, in order, and reports done', async () => {
    const order: number[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const states: RunnerSnapshot[] = [];
    const runner = createSequentialRunner<number>({
      work: async (item) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await tick();
        order.push(item);
        inFlight -= 1;
      },
      onChange: (s) => states.push(s),
    });
    runner.start([1, 2, 3]);
    await settle();
    expect(order).toEqual([1, 2, 3]);
    expect(maxInFlight).toBe(1);
    expect(runner.snapshot()).toMatchObject({ state: 'done', index: 3, total: 3, failed: 0 });
    expect(states[0].state).toBe('running');
  });

  it('pauses after the current item and resumes from the next one', async () => {
    const order: number[] = [];
    const runner = createSequentialRunner<number>({
      work: async (item) => {
        await tick();
        order.push(item);
      },
    });
    runner.start([1, 2, 3, 4]);
    runner.pause();
    await settle();
    expect(order).toEqual([1]);
    expect(runner.snapshot().state).toBe('paused');
    runner.resume();
    await settle();
    expect(order).toEqual([1, 2, 3, 4]);
    expect(runner.snapshot().state).toBe('done');
  });

  it('halts on 401 without advancing, then re-runs the same item on resume', async () => {
    let allow = false;
    const attempts: number[] = [];
    const runner = createSequentialRunner<number>({
      work: async (item) => {
        attempts.push(item);
        if (item === 2 && !allow) {
          throw new ApiError(401, 'expired');
        }
      },
    });
    runner.start([1, 2, 3]);
    await settle();
    expect(runner.snapshot()).toMatchObject({ state: 'auth_expired', index: 1 });
    allow = true;
    runner.resume();
    await settle();
    expect(attempts).toEqual([1, 2, 2, 3]);
    expect(runner.snapshot().state).toBe('done');
  });

  it('retries a transient failure once and counts a hard failure without stopping', async () => {
    let calls = 0;
    const errors: unknown[] = [];
    const runner = createSequentialRunner<string>({
      work: async (item) => {
        calls += 1;
        if (item === 'flaky' && calls === 1) {
          throw new ApiError(503, 'busy');
        }
        if (item === 'broken') {
          throw new ApiError(400, 'bad');
        }
      },
      onItemError: (_item, _index, error) => errors.push(error),
      sleep: async () => undefined,
    });
    runner.start(['flaky', 'broken', 'ok']);
    await settle();
    expect(runner.snapshot()).toMatchObject({ state: 'done', failed: 1, index: 3 });
    expect(errors).toHaveLength(1);
    expect((errors[0] as ApiError).status).toBe(400);
  });

  it('cancels and forgets the queue', async () => {
    const order: number[] = [];
    const runner = createSequentialRunner<number>({
      work: async (item) => {
        await tick();
        order.push(item);
      },
    });
    runner.start([1, 2, 3]);
    runner.cancel();
    await settle();
    expect(order).toEqual([1]);
    expect(runner.snapshot()).toMatchObject({ state: 'cancelled', total: 0 });
  });
});
