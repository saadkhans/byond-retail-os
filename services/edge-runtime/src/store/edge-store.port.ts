/**
 * The edge runtime's durable local store, behind a port this repository owns.
 *
 * Two shapes, deliberately only two:
 * - RECORDS: the working set the cloud pushes down (units, devices, catalog
 *   snapshot, planogram, resolved prices) plus locally-derived cursors. Last
 *   write wins; a record is replaceable.
 * - LOGS: append-only streams of facts (the inventory ledger, the outbox, the
 *   inbox, conflicts, dead letters). A log entry is never updated or deleted.
 *   Stock levels and outbox state are PROJECTIONS over these logs, which is
 *   what makes a silent overwrite structurally impossible on the edge exactly
 *   as it is in the cloud.
 *
 * Implementations must survive process restart and must never hold media
 * bytes or card data — see `assertPersistable`.
 */
export interface EdgeStorePort {
  readonly adapterKey: string;
  readonly version: string;

  /** Edge-readiness: false must degrade, never fabricate. */
  checkReady(): Promise<boolean>;

  /** Creates the backing location if absent and loads log sequences. */
  open(): Promise<void>;

  get<T>(collection: string, id: string): Promise<T | null>;
  put<T>(collection: string, id: string, value: T): Promise<void>;
  remove(collection: string, id: string): Promise<void>;
  list<T>(collection: string): Promise<ReadonlyArray<StoredRecord<T>>>;

  /** Appends one entry and returns its assigned monotonic sequence. */
  append<T>(log: string, entry: T): Promise<number>;

  /** Entries with `sequence > afterSequence`, in order, at most `limit`. */
  read<T>(
    log: string,
    afterSequence: number,
    limit: number,
  ): Promise<ReadonlyArray<LoggedEntry<T>>>;

  /** Highest assigned sequence in the log, or 0 when empty. */
  lastSequence(log: string): Promise<number>;

  /** Number of readable entries in the log. */
  count(log: string): Promise<number>;
}

export interface StoredRecord<T> {
  readonly id: string;
  readonly value: T;
}

export interface LoggedEntry<T> {
  readonly sequence: number;
  readonly entry: T;
}

export const EDGE_STORE = Symbol('EDGE_STORE');
