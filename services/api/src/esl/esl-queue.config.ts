import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isEnvFlagEnabled } from '../config/env.validation';
import { ESL_PROCESS_MAX_BATCH } from './esl.constants';

/**
 * Configuration for the background ESL queue runner.
 *
 * Same shape and the same fail-closed parsing as PickupDetectionConfig: every
 * knob is env-driven, an unparseable value falls back to the DEFAULT (never a
 * silent zero, which would mean "sweep continuously" or "reconcile every
 * tick"), and the master switch uses the repository's single definition of a
 * boolean env flag.
 *
 * Every key read here is declared in config/env.validation.ts. It has to be:
 * validateSync runs with `whitelist: true`, so an undeclared key is stripped
 * before ConfigService is constructed and the flag would read as permanently
 * off — the runner would look configured and do nothing.
 */

/** Poll cadence. A queued push should reach the shelf in seconds, not
 *  minutes, but each tick costs one indexed claim query per active tenant. */
export const DEFAULT_ESL_SWEEP_INTERVAL_MS = 15_000;
/** Jobs claimed per tenant per sweep. Bounded by ESL_PROCESS_MAX_BATCH. */
export const DEFAULT_ESL_SWEEP_BATCH = 50;
/** Drift repair cadence. Reconciliation reads EVERY bound label and resolves
 *  the price in force for each, so it is far more expensive than a drain and
 *  runs on its own, much slower clock. */
export const DEFAULT_ESL_RECONCILE_INTERVAL_MS = 15 * 60_000;

function boundedInt(
  raw: string | number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = Number(raw);
  return Number.isInteger(value) && value >= min && value <= max
    ? value
    : fallback;
}

@Injectable()
export class EslQueueConfig {
  /**
   * Master switch. OFF by default — a deployment opts in explicitly, and no
   * test process ever runs the timer (test/setup-env.ts forces it off, the
   * same way it does for the pickup worker).
   */
  readonly enabled: boolean;

  /** Milliseconds between sweeps. */
  readonly sweepIntervalMs: number;

  /** Jobs claimed per tenant per sweep. */
  readonly batchSize: number;

  /** Milliseconds between drift-repair passes for one tenant. */
  readonly reconcileIntervalMs: number;

  constructor(config: ConfigService) {
    this.enabled = isEnvFlagEnabled(
      config.get<string>('ESL_QUEUE_WORKER_ENABLED'),
    );
    this.sweepIntervalMs = boundedInt(
      config.get<string | number>('ESL_QUEUE_WORKER_INTERVAL_MS'),
      DEFAULT_ESL_SWEEP_INTERVAL_MS,
      1_000,
      3_600_000,
    );
    this.batchSize = boundedInt(
      config.get<string | number>('ESL_QUEUE_WORKER_BATCH_SIZE'),
      DEFAULT_ESL_SWEEP_BATCH,
      1,
      ESL_PROCESS_MAX_BATCH,
    );
    this.reconcileIntervalMs = boundedInt(
      config.get<string | number>('ESL_RECONCILE_INTERVAL_MS'),
      DEFAULT_ESL_RECONCILE_INTERVAL_MS,
      60_000,
      86_400_000,
    );
  }
}
