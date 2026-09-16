import { CloudClientPort } from './cloud-client.port';
import { CloudPushResult, InboxEntry, OutboxEntry } from './sync.types';

/**
 * The adapter used when no cloud URL is configured.
 *
 * It is not a stub that pretends to succeed: it reports not-ready and refuses
 * every call, so an unconfigured node runs permanently offline — accumulating
 * facts in the outbox — instead of silently discarding them.
 */
export class OfflineCloudClient implements CloudClientPort {
  readonly adapterKey = 'offline';
  readonly version = '1.0.0';

  async checkReady(): Promise<boolean> {
    return false;
  }

  async pushOperations(_batch: readonly OutboxEntry[]): Promise<CloudPushResult> {
    throw new Error('Cloud control plane is not configured');
  }

  async pullConfiguration(_sinceVersion: number): Promise<readonly InboxEntry[]> {
    throw new Error('Cloud control plane is not configured');
  }
}
