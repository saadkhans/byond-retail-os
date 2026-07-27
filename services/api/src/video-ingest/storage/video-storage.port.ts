/**
 * Phase 10 media storage contract — LOCAL/DEV ONLY by design. Keys are
 * OPAQUE, SERVER-GENERATED, storage-root-relative identifiers; they are
 * never user-supplied, never exposed through the API, and never carry
 * credentials or URLs. Cloud/object storage arrives in a later phase behind
 * this same port.
 */
export abstract class VideoStoragePort {
  /** Persist bytes under a server-generated key (parents auto-created). */
  abstract put(storageKey: string, data: Buffer): Promise<void>;

  /** Read bytes back (extraction adapters only — never served to clients). */
  abstract read(storageKey: string): Promise<Buffer>;

  /** Remove one object; missing objects are a no-op (idempotent delete). */
  abstract delete(storageKey: string): Promise<void>;

  /**
   * Remove every object under a key prefix (an asset's directory) —
   * idempotent, used by asset deletion to clean the original plus all
   * extracted artifacts.
   */
  abstract deletePrefix(storageKeyPrefix: string): Promise<void>;

  /**
   * Absolute filesystem path for a key — for the OPTIONAL local system
   * binary extraction adapter ONLY (it must hand the OS a real path). The
   * result must never leave the process: not in API responses, not in
   * error messages, not in audit rows.
   */
  abstract internalPathFor(storageKey: string): string;
}
