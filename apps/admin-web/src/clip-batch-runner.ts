import { ApiError } from './api';

/**
 * Sequential runner for the Clip Lab batch — ONE item in flight, ever.
 * Uploads, screening previews, approvals, ground-truth saves and lab
 * runs all go through it, because the server gates (pre-buffer upload
 * guard, single-in-flight local runtime) are per request and parallel
 * calls only degrade results.
 *
 * Pause finishes the current item and stops; Resume continues from the
 * next undone item; Cancel pauses and forgets the queue. A 401 halts
 * the run as AUTH_EXPIRED so the page can re-authenticate inline and
 * resume without losing state. Transient transport failures (status 0,
 * 502, 503, 504) retry once after a short delay.
 */

export type RunnerState = 'idle' | 'running' | 'paused' | 'auth_expired' | 'done' | 'cancelled';

export interface RunnerSnapshot {
  state: RunnerState;
  index: number;
  total: number;
  failed: number;
}

export interface SequentialRunner<T> {
  start(items: T[]): void;
  pause(): void;
  resume(): void;
  cancel(): void;
  snapshot(): RunnerSnapshot;
}

export interface RunnerOptions<T> {
  work: (item: T, index: number) => Promise<void>;
  /** Called after every item (done or failed) and on every state change. */
  onChange?: (snapshot: RunnerSnapshot) => void;
  onItemError?: (item: T, index: number, error: unknown) => void;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const RETRYABLE_STATUSES = new Set([0, 502, 503, 504]);

export function isAuthExpired(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

export function isTransient(error: unknown): boolean {
  return error instanceof ApiError && RETRYABLE_STATUSES.has(error.status);
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createSequentialRunner<T>(options: RunnerOptions<T>): SequentialRunner<T> {
  const sleep = options.sleep ?? defaultSleep;
  const retryDelayMs = options.retryDelayMs ?? 2000;
  let items: T[] = [];
  let index = 0;
  let failed = 0;
  let state: RunnerState = 'idle';
  let pauseRequested = false;
  let cancelRequested = false;
  let loopActive = false;

  const snapshot = (): RunnerSnapshot => ({ state, index, total: items.length, failed });
  const emit = () => options.onChange?.(snapshot());
  const setState = (next: RunnerState) => {
    state = next;
    emit();
  };

  async function runOne(item: T, at: number): Promise<'ok' | 'failed' | 'auth'> {
    try {
      await options.work(item, at);
      return 'ok';
    } catch (error) {
      if (isAuthExpired(error)) {
        return 'auth';
      }
      if (isTransient(error)) {
        await sleep(retryDelayMs);
        try {
          await options.work(item, at);
          return 'ok';
        } catch (again) {
          if (isAuthExpired(again)) {
            return 'auth';
          }
          options.onItemError?.(item, at, again);
          return 'failed';
        }
      }
      options.onItemError?.(item, at, error);
      return 'failed';
    }
  }

  async function loop(): Promise<void> {
    if (loopActive) {
      return;
    }
    loopActive = true;
    try {
      while (index < items.length) {
        if (cancelRequested) {
          cancelRequested = false;
          items = [];
          setState('cancelled');
          return;
        }
        if (pauseRequested) {
          pauseRequested = false;
          setState('paused');
          return;
        }
        const outcome = await runOne(items[index], index);
        if (outcome === 'auth') {
          // Do not advance: the same item runs again after re-login.
          setState('auth_expired');
          return;
        }
        if (outcome === 'failed') {
          failed += 1;
        }
        index += 1;
        emit();
      }
      setState('done');
    } finally {
      loopActive = false;
    }
  }

  return {
    start(next: T[]) {
      if (loopActive) {
        return;
      }
      items = [...next];
      index = 0;
      failed = 0;
      pauseRequested = false;
      cancelRequested = false;
      setState(items.length === 0 ? 'done' : 'running');
      if (items.length > 0) {
        void loop();
      }
    },
    pause() {
      if (state === 'running') {
        pauseRequested = true;
      }
    },
    resume() {
      if ((state === 'paused' || state === 'auth_expired') && index < items.length) {
        setState('running');
        void loop();
      } else if ((state === 'paused' || state === 'auth_expired') && index >= items.length) {
        setState('done');
      }
    },
    cancel() {
      if (state === 'running') {
        cancelRequested = true;
      } else if (state === 'paused' || state === 'auth_expired') {
        items = [];
        setState('cancelled');
      }
    },
    snapshot,
  };
}
