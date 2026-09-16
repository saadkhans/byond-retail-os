import { Inject, Injectable } from '@nestjs/common';
import { ReviewQueueService } from '../decisioning/review-queue.service';
import { DriverHealth } from '../hardware/hardware.port';
import { DriverRegistryService } from '../hardware/driver-registry.service';
import { EDGE_STORE, EdgeStorePort } from '../store/edge-store.port';
import { LOGS } from '../store/store-names';
import { OutboxService } from '../sync/outbox.service';
import { ConnectivityState, SyncService } from '../sync/sync.service';

export interface EdgeMetrics {
  readonly connectivity: ConnectivityState;
  readonly lastSyncAt: string | null;
  readonly outboxPending: number;
  readonly deadLetters: number;
  readonly conflicts: number;
  readonly ledgerEntries: number;
  readonly proposalsObserved: number;
  readonly reviewsPending: number;
  readonly devices: ReadonlyArray<DriverHealth>;
}

/**
 * The operational snapshot. Counts and states only: it must be safe to look at
 * without disclosing what was sold, to whom, or where any media lives.
 */
@Injectable()
export class MetricsService {
  constructor(
    @Inject(EDGE_STORE) private readonly store: EdgeStorePort,
    private readonly sync: SyncService,
    private readonly outbox: OutboxService,
    private readonly reviews: ReviewQueueService,
    private readonly drivers: DriverRegistryService,
  ) {}

  async snapshot(): Promise<EdgeMetrics> {
    const [
      outboxPending,
      deadLetters,
      conflicts,
      ledgerEntries,
      proposalsObserved,
      reviewsPending,
    ] = await Promise.all([
      this.outbox.pendingCount(),
      this.store.count(LOGS.deadletter),
      this.store.count(LOGS.conflicts),
      this.store.count(LOGS.ledger),
      this.store.count(LOGS.proposals),
      this.reviews.pendingCount(),
    ]);
    return {
      connectivity: this.sync.connectivity,
      lastSyncAt: this.sync.lastSyncedAt,
      outboxPending,
      deadLetters,
      conflicts,
      ledgerEntries,
      proposalsObserved,
      reviewsPending,
      devices: this.drivers.health(),
    };
  }
}
