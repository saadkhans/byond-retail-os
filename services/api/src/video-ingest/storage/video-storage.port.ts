import type { Readable } from 'node:stream';

/**
 * Controlled, PATH-FREE storage failure. Raw filesystem/provider errors
 * carry absolute paths (and a deployment root can carry credential-bearing
 * directory components), and Nest's default handler logs unexpected
 * exception messages — so adapters must map every underlying failure to
 * this generic error before it escapes.
 */
export class VideoStorageOperationError extends Error {
  constructor() {
    super('Video storage operation failed');
    this.name = 'VideoStorageOperationError';
  }
}

/**
 * Phase 10 media storage contract — provider-neutral by construction. Keys
 * are OPAQUE, SERVER-GENERATED, storage-root-relative identifiers; they are
 * never user-supplied, never exposed through the API, and never carry
 * credentials or URLs. The port speaks bytes and keys ONLY — no filesystem
 * paths, so a cloud/object-store adapter can implement it unchanged in a
 * later phase. (Local-path resolution for the optional system-binary
 * extractor is a capability of the LOCAL adapter class, not of this port.)
 */
export abstract class VideoStoragePort {
  /** Persist bytes under a server-generated key (parents auto-created). */
  abstract put(storageKey: string, data: Buffer): Promise<void>;

  /** Read bytes back (extraction adapters only — never served to clients). */
  abstract read(storageKey: string): Promise<Buffer>;

  /**
   * Open a read STREAM over one object, optionally narrowed to an
   * INCLUSIVE byte window — the media-serving path (Codex P2): a clip is
   * piped to the review player chunk by chunk, so per-request memory stays
   * bounded instead of buffering up to the whole file like `read`.
   * Adapters must fail path-free like every other operation, including
   * errors the underlying stream raises AFTER this promise resolved — a
   * raw provider/fs error must never reach the stream's consumer.
   */
  abstract createReadStream(
    storageKey: string,
    range?: { start: number; end: number },
  ): Promise<Readable>;

  /** Remove one object; missing objects are a no-op (idempotent delete). */
  abstract delete(storageKey: string): Promise<void>;

  /**
   * Remove every object under a key prefix (an asset's directory) —
   * idempotent, used by asset deletion and screening rejection to clean
   * the original plus all extracted artifacts. Returns whether anything
   * existed under the prefix (true = something was removed by THIS call,
   * false = already gone). INFORMATIONAL only: adapters cannot make the
   * observe-then-remove pair atomic (two concurrent removals may both
   * report true), so callers must never use this report to gate
   * exactly-once side effects — media-removal completion evidence is
   * recorded through the repository's DB marker CAS instead.
   */
  abstract deletePrefix(storageKeyPrefix: string): Promise<boolean>;
}
