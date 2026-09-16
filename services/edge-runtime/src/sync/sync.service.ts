import { Inject, Injectable } from '@nestjs/common';
import { EdgeConfigService } from '../config/edge-config.service';
import { StructuredLogger, errorClass } from '../logging/structured-logger';
import { CLOUD_CLIENT, CloudClientPort } from './cloud-client.port';
import { ConfigurationService } from './configuration.service';
import { OutboxService } from './outbox.service';
import { backoffDelayMs } from './sync.types';

export type ConnectivityState = 'ONLINE' | 'OFFLINE';

export interface SyncOutcome {
  readonly connectivity: ConnectivityState;
  readonly pushed: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly configurationApplied: number;
  readonly pendingAfter: number;
  readonly skippedForBackoff: boolean;
  readonly errorClass?: string;
}

/**
 * One reconciliation pass, driven by a timer but callable directly so tests
 * never sleep.
 *
 * Ordering matters: configuration is pulled BEFORE facts are pushed, so a
 * batch is always evaluated against the freshest local view of the world the
 * cloud has published.
 *
 * Losing connectivity is not an error path. The pass reports OFFLINE, leaves
 * the outbox untouched apart from an attempt increment, and the store keeps
 * operating.
 */
@Injectable()
export class SyncService {
  private nextAttemptAt = 0;
  private lastOutcome: SyncOutcome | null = null;
  private lastSyncAt: string | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(CLOUD_CLIENT) private readonly cloud: CloudClientPort,
    private readonly outbox: OutboxService,
    private readonly configuration: ConfigurationService,
    private readonly config: EdgeConfigService,
    private readonly logger: StructuredLogger,
  ) {}

  start(): void {
    if (this.timer !== null) {
      return;
    }
    this.timer = setInterval(() => {
      void this.runOnce().catch((cause) => {
        this.logger.failure('sync pass failed', cause, 'SyncService');
      });
    }, this.config.syncIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  get connectivity(): ConnectivityState {
    return this.lastOutcome?.connectivity ?? 'OFFLINE';
  }

  get lastSyncedAt(): string | null {
    return this.lastSyncAt;
  }

  get outcome(): SyncOutcome | null {
    return this.lastOutcome;
  }

  async runOnce(now: number = Date.now()): Promise<SyncOutcome> {
    if (now < this.nextAttemptAt) {
      const outcome: SyncOutcome = {
        connectivity: this.connectivity,
        pushed: 0,
        accepted: 0,
        rejected: 0,
        configurationApplied: 0,
        pendingAfter: await this.outbox.pendingCount(),
        skippedForBackoff: true,
      };
      this.lastOutcome = outcome;
      return outcome;
    }

    let configurationApplied = 0;
    try {
      const since = await this.configuration.appliedVersion();
      const entries = await this.cloud.pullConfiguration(since);
      configurationApplied = await this.configuration.apply(entries);
    } catch (cause) {
      return this.degrade(now, cause, configurationApplied);
    }

    const batch = await this.outbox.nextBatch();
    if (batch.length === 0) {
      this.nextAttemptAt = 0;
      const outcome: SyncOutcome = {
        connectivity: 'ONLINE',
        pushed: 0,
        accepted: 0,
        rejected: 0,
        configurationApplied,
        pendingAfter: 0,
        skippedForBackoff: false,
      };
      this.lastOutcome = outcome;
      this.lastSyncAt = new Date(now).toISOString();
      return outcome;
    }

    try {
      const result = await this.cloud.pushOperations(batch);
      await this.outbox.settle(batch, result);
      this.nextAttemptAt = 0;
      const outcome: SyncOutcome = {
        connectivity: 'ONLINE',
        pushed: batch.length,
        accepted: result.accepted.length,
        rejected: result.rejected.length,
        configurationApplied,
        pendingAfter: await this.outbox.pendingCount(),
        skippedForBackoff: false,
      };
      this.lastOutcome = outcome;
      this.lastSyncAt = new Date(now).toISOString();
      return outcome;
    } catch (cause) {
      await this.outbox.recordDeliveryFailure(batch);
      return this.degrade(now, cause, configurationApplied);
    }
  }

  private async degrade(
    now: number,
    cause: unknown,
    configurationApplied: number,
  ): Promise<SyncOutcome> {
    const attempts = await this.outbox.headAttempts();
    this.nextAttemptAt =
      now +
      backoffDelayMs(
        Math.max(attempts, 1),
        this.config.syncBackoffBaseMs,
        this.config.syncBackoffMaxMs,
      );
    const outcome: SyncOutcome = {
      connectivity: 'OFFLINE',
      pushed: 0,
      accepted: 0,
      rejected: 0,
      configurationApplied,
      pendingAfter: await this.outbox.pendingCount(),
      skippedForBackoff: false,
      errorClass: errorClass(cause),
    };
    this.lastOutcome = outcome;
    this.logger.detail(
      'warn',
      'sync degraded to offline',
      { errorClass: outcome.errorClass, pending: outcome.pendingAfter },
      'SyncService',
    );
    return outcome;
  }
}
