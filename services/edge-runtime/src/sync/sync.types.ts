/**
 * The sync contract between an edge node and the cloud control plane.
 *
 * Direction decides ownership, and ownership decides who wins a conflict:
 * - The cloud owns CONFIGURATION. Catalog, planogram, prices, units, devices
 *   and thresholds flow down through the inbox, and the cloud's version always
 *   wins. The edge never edits configuration locally.
 * - The edge owns locally-OBSERVED FACTS. Ledger movements, CV proposals and
 *   review decisions flow up through the outbox, and the cloud never
 *   overwrites them. They are append-only history, not editable state.
 *
 * Anything that does not fit those two rules is a CONFLICT, and a conflict is
 * recorded and surfaced rather than resolved by guessing.
 */

export type OutboxOperationType =
  | 'INVENTORY_MOVEMENT'
  | 'VISION_EVENT_PROPOSAL'
  | 'REVIEW_DECISION'
  | 'DEVICE_HEARTBEAT';

export interface OutboxOperation {
  readonly type: OutboxOperationType;
  /**
   * Stable across every retry of the same fact. The cloud deduplicates on it,
   * which is what makes at-least-once delivery safe to replay after a crash.
   */
  readonly idempotencyKey: string;
  readonly occurredAt: string;
  readonly payload: Record<string, unknown>;
}

export interface OutboxEntry extends OutboxOperation {
  readonly sequence: number;
}

export type ConfigurationResourceType =
  | 'UNIT'
  | 'DEVICE'
  | 'PRODUCT'
  | 'PLANOGRAM'
  | 'PRICE'
  | 'THRESHOLD';

export interface InboxEntry {
  readonly resourceType: ConfigurationResourceType;
  readonly resourceId: string;
  /**
   * The cloud's change sequence for this publication: strictly increasing
   * across the whole configuration stream, and therefore increasing per
   * resource too. Both properties are load-bearing and for different reasons.
   *
   * Because it is global, the node can track what it has seen with ONE
   * watermark and ask for everything after it — a per-resource version would
   * need a cursor per resource and would silently lose an update whenever one
   * resource's numbering ran behind another's.
   *
   * Because it also increases per resource, an entry whose version is not
   * greater than the one already applied to that resource is stale and is
   * ignored. That check is what makes applying the same batch twice a no-op.
   */
  readonly version: number;
  /**
   * The tenant the cloud says this resource belongs to, when it says so.
   * A node applies configuration only for the tenant its store is sealed to.
   */
  readonly tenantId?: string;
  readonly payload: Record<string, unknown>;
  /** True when the cloud is retiring the resource. */
  readonly deleted?: boolean;
}

export interface ConfigurationRecord {
  readonly resourceType: ConfigurationResourceType;
  readonly resourceId: string;
  readonly version: number;
  readonly payload: Record<string, unknown>;
  readonly appliedAt: string;
}

export type ConflictKind =
  | 'STALE_CONFIGURATION'
  | 'FOREIGN_TENANT_CONFIGURATION'
  | 'CLOUD_REJECTED_FACT'
  | 'DELIVERY_BUDGET_EXHAUSTED';

export interface ConflictRecord {
  readonly kind: ConflictKind;
  readonly detectedAt: string;
  readonly detail: Record<string, unknown>;
}

export interface CloudPushResult {
  /** Idempotency keys the cloud durably accepted. */
  readonly accepted: readonly string[];
  /** Keys the cloud refused, with a closed-vocabulary reason code. */
  readonly rejected: ReadonlyArray<{
    readonly idempotencyKey: string;
    readonly reasonCode: string;
  }>;
}

export function configurationKey(
  resourceType: ConfigurationResourceType,
  resourceId: string,
): string {
  return `${resourceType}:${resourceId}`;
}

/**
 * Exponential backoff with a ceiling. Deterministic: the sync loop's timing is
 * part of its behaviour, so a test can assert it rather than sleep for it.
 */
export function backoffDelayMs(
  attempt: number,
  baseMs: number,
  maxMs: number,
): number {
  if (attempt <= 0) {
    return 0;
  }
  const exponent = Math.min(attempt - 1, 30);
  return Math.min(baseMs * 2 ** exponent, maxMs);
}
