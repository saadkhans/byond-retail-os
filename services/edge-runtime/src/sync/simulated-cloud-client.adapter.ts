import { CloudClientPort } from './cloud-client.port';
import { CloudPushResult, InboxEntry, OutboxEntry } from './sync.types';

/**
 * In-memory control plane for tests and for a development node with no cloud.
 *
 * It models the two behaviours the sync layer must survive: going offline at
 * any moment, and deduplicating a replayed idempotency key. `received` keeps
 * every delivery INCLUDING duplicates, so a test can assert that a crash
 * replay re-sends the same key rather than a second distinct fact.
 */
export class SimulatedCloudClient implements CloudClientPort {
  readonly adapterKey = 'simulated';
  readonly version = '1.0.0';

  online = true;
  /** Keys refused on arrival, simulating a cloud-side validation failure. */
  readonly rejectKeys = new Set<string>();
  /** Every delivery attempt, duplicates included. */
  readonly received: OutboxEntry[] = [];
  /** Distinct facts the cloud durably holds, by idempotency key. */
  readonly durable = new Map<string, OutboxEntry>();

  private configuration: InboxEntry[] = [];

  async checkReady(): Promise<boolean> {
    return this.online;
  }

  publishConfiguration(entries: readonly InboxEntry[]): void {
    this.configuration = [...this.configuration, ...entries];
  }

  async pushOperations(batch: readonly OutboxEntry[]): Promise<CloudPushResult> {
    if (!this.online) {
      throw new Error('offline');
    }
    const accepted: string[] = [];
    const rejected: { idempotencyKey: string; reasonCode: string }[] = [];
    for (const entry of batch) {
      this.received.push(entry);
      if (this.rejectKeys.has(entry.idempotencyKey)) {
        rejected.push({
          idempotencyKey: entry.idempotencyKey,
          reasonCode: 'REJECTED_BY_CLOUD',
        });
        continue;
      }
      // Deduplication: a replayed key is accepted again without creating a
      // second fact, which is what makes at-least-once delivery safe.
      if (!this.durable.has(entry.idempotencyKey)) {
        this.durable.set(entry.idempotencyKey, entry);
      }
      accepted.push(entry.idempotencyKey);
    }
    return { accepted, rejected };
  }

  async pullConfiguration(sinceVersion: number): Promise<readonly InboxEntry[]> {
    if (!this.online) {
      throw new Error('offline');
    }
    return this.configuration
      .filter((entry) => entry.version > sinceVersion)
      .sort((left, right) => left.version - right.version);
  }
}
