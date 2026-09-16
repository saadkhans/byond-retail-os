/**
 * Every collection and log name in one place, so a typo cannot silently
 * create a second, empty stream.
 */
export const COLLECTIONS = {
  /** Cloud-pushed configuration, keyed by `${resourceType}:${resourceId}`. */
  configuration: 'configuration',
  /** Locally-derived cursors and counters. */
  cursors: 'cursors',
  /** Local review queue items awaiting an operator decision. */
  review: 'review',
  /** The tenant/location/device this store is sealed to. Written once. */
  identity: 'identity',
} as const;

export const LOGS = {
  /** Append-only inventory ledger. Stock is a projection over this. */
  ledger: 'ledger',
  /** Locally-originated operations awaiting delivery to the cloud. */
  outbox: 'outbox',
  /** Cloud-pushed configuration entries, in the order they were received. */
  inbox: 'inbox',
  /** Operations the cloud rejected or that exhausted their attempt budget. */
  deadletter: 'deadletter',
  /** Divergences between edge facts and cloud state, surfaced never dropped. */
  conflicts: 'conflicts',
  /** CV proposals as observed, before any decision was taken. */
  proposals: 'proposals',
} as const;

export const IDENTITY_ID = {
  node: 'node',
} as const;

export const CURSOR_IDS = {
  outboxAckedThrough: 'outbox-acked-through',
  inboxAppliedThrough: 'inbox-applied-through',
  configurationVersion: 'configuration-version',
} as const;
