import { CloudPushResult, InboxEntry, OutboxEntry } from './sync.types';

/**
 * The control-plane client, behind a port this repository owns so the edge
 * runtime can be tested, and run offline, without a network.
 */
export interface CloudClientPort {
  readonly adapterKey: string;
  readonly version: string;

  /** Connectivity probe. False means offline, not broken. */
  checkReady(): Promise<boolean>;

  /** At-least-once delivery; the cloud deduplicates on idempotency key. */
  pushOperations(batch: readonly OutboxEntry[]): Promise<CloudPushResult>;

  /** Configuration newer than `sinceVersion`, oldest first. */
  pullConfiguration(sinceVersion: number): Promise<readonly InboxEntry[]>;
}

export const CLOUD_CLIENT = Symbol('CLOUD_CLIENT');
