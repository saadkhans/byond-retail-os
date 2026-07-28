import { randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  VideoStorageOperationError,
  VideoStoragePort,
} from './video-storage.port';

/**
 * Storage keys are server-generated (tenant id / random UUID / fixed names),
 * so this charset is a DEFENSE-IN-DEPTH invariant, not a parser: any key
 * outside it means a code path built a key from user input — refuse.
 */
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9/._-]*$/;

// Service-account-only modes: directories 0o700, media files 0o600. Tenant
// media on a shared dev host or mounted volume must not be world-readable
// even though the API exposes no media route. No-ops on Windows (Node maps
// them onto ACL-less semantics), enforced on POSIX hosts.
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * Dedicated subtree for PRE-STORAGE screening staging, INSIDE the storage
 * root (same confinement, same 0700/0600 modes). The '.' in the segment
 * guarantees it can never collide with a real asset key's first segment:
 * asset keys start with a tenant id (dot-free by construction), and the
 * safe-key charset forbids a LEADING dot, so no server-generated asset key
 * can ever begin with this prefix. Staged bytes are never listed or served
 * and exist only for the duration of one upload's pre-storage screen.
 */
const STAGING_PREFIX = 'staging.prestore';

export class InvalidStorageKeyError extends Error {
  constructor() {
    // Deliberately generic: the offending key is never echoed (it could be
    // attacker-shaped) and the storage root is never revealed.
    super('Invalid internal storage key');
    this.name = 'InvalidStorageKeyError';
  }
}

/**
 * Local/dev media storage under one configured, gitignored root
 * (VIDEO_STORAGE_ROOT, default ".local/video-ingest" next to the repo
 * root). Every operation re-verifies that the resolved path stays INSIDE
 * the root — a key that escapes (traversal, absolute path, drive letter)
 * throws before any filesystem call — and every underlying filesystem
 * failure is mapped to a controlled, PATH-FREE VideoStorageOperationError
 * (raw fs errors embed absolute paths, which must never reach logs or
 * clients).
 */
@Injectable()
export class LocalVideoStorageAdapter extends VideoStoragePort {
  private readonly root: string;

  constructor(config: ConfigService) {
    super();
    const configured = config.get<string>('VIDEO_STORAGE_ROOT');
    // Default: <repo>/.local/video-ingest when the API runs from
    // services/api (dev/test); a deployment sets VIDEO_STORAGE_ROOT
    // explicitly. Resolved once — relative keys can never re-anchor it.
    this.root = resolve(
      configured && configured.trim().length > 0
        ? configured
        : resolve(process.cwd(), '..', '..', '.local', 'video-ingest'),
    );
  }

  /**
   * Root-confinement gate for EVERY filesystem operation. Rejects key
   * shapes that could escape (.., absolute, backslash, colon, unsafe
   * charset) and re-checks the RESOLVED path prefix afterwards, so even a
   * shape the charset missed cannot leave the root.
   */
  private resolveWithinRoot(storageKey: string): string {
    if (
      storageKey.length === 0 ||
      storageKey.includes('..') ||
      storageKey.includes('\\') ||
      storageKey.includes(':') ||
      isAbsolute(storageKey) ||
      !SAFE_KEY.test(storageKey)
    ) {
      throw new InvalidStorageKeyError();
    }
    const resolved = resolve(this.root, storageKey);
    if (resolved !== this.root && !resolved.startsWith(this.root + sep)) {
      throw new InvalidStorageKeyError();
    }
    return resolved;
  }

  /** Path-free failure mapping — see VideoStorageOperationError. */
  private async guarded<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof InvalidStorageKeyError) {
        throw error;
      }
      throw new VideoStorageOperationError();
    }
  }

  async put(storageKey: string, data: Buffer): Promise<void> {
    const target = this.resolveWithinRoot(storageKey);
    // Atomic publish via temp-file + rename: a write that fails partway
    // (ENOSPC, ...) must never leave a half-written object under the FINAL
    // key — callers record keys only after put succeeds, so a partial
    // target would otherwise be unreachable garbage no retry cleans up.
    // rename() on the same directory is atomic on POSIX and NTFS.
    const temp = `${target}.tmp-${randomUUID()}`;
    await this.guarded(async () => {
      // recursive mkdir applies the mode to every directory it CREATES; a
      // pre-existing directory (e.g. a root provisioned with a broader
      // umask) is tightened explicitly. chmod failures on exotic mounts
      // must not lose the write — permissions are best-effort hardening on
      // top of the gitignored, non-served root.
      const parent = resolve(target, '..');
      await mkdir(parent, { recursive: true, mode: DIR_MODE });
      await chmod(parent, DIR_MODE).catch(() => undefined);
      try {
        await writeFile(temp, data, { mode: FILE_MODE, flag: 'wx' });
        await chmod(temp, FILE_MODE).catch(() => undefined);
        await rename(temp, target);
      } catch (error) {
        await unlink(temp).catch(() => undefined);
        throw error;
      }
    });
  }

  async read(storageKey: string): Promise<Buffer> {
    const target = this.resolveWithinRoot(storageKey);
    return this.guarded(() => readFile(target));
  }

  async delete(storageKey: string): Promise<void> {
    const target = this.resolveWithinRoot(storageKey);
    await this.guarded(async () => {
      await unlink(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      });
    });
  }

  async deletePrefix(storageKeyPrefix: string): Promise<boolean> {
    const target = this.resolveWithinRoot(storageKeyPrefix);
    // Refuse to treat the root itself as a deletable prefix.
    if (target === this.root) {
      throw new InvalidStorageKeyError();
    }
    return this.guarded(async () => {
      // Report whether anything existed: callers use this to record a
      // media-removal completion exactly once (an idempotent replay over an
      // already-clean prefix returns false and records nothing).
      const existed = await stat(target).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') {
            return false;
          }
          throw error;
        },
      );
      if (existed) {
        await rm(target, { recursive: true, force: true });
      }
      return existed;
    });
  }

  async putStaging(storageKey: string, data: Buffer): Promise<string> {
    // Validate the RAW key first (same gate as every operation), then
    // stage under the deterministic staging key. Deterministic mapping is
    // the contract: the asset row that stores storageKey is the recovery
    // record for the staged bytes too — deleteStaging (and the DELETE
    // recovery flow) can re-derive this location from the row alone.
    this.resolveWithinRoot(storageKey);
    const stagingKey = `${STAGING_PREFIX}/${storageKey}`;
    await this.put(stagingKey, data);
    return stagingKey;
  }

  async deleteStaging(storageKey: string): Promise<void> {
    this.resolveWithinRoot(storageKey);
    // Remove the staged media's DIRECTORY (tenant/uuid), mirroring the
    // asset-directory removal shape — idempotent via deletePrefix.
    const slash = storageKey.lastIndexOf('/');
    const dir = slash > 0 ? storageKey.slice(0, slash) : storageKey;
    await this.deletePrefix(`${STAGING_PREFIX}/${dir}`);
  }

  /**
   * Absolute filesystem path for a key — a capability of THIS local
   * adapter, deliberately NOT part of VideoStoragePort (an object-store
   * adapter has no local paths; the port stays provider-neutral). Used only
   * by the optional local system-binary extractor, which must hand the OS a
   * real path. The result must never leave the process: not in API
   * responses, not in error messages, not in audit rows.
   */
  internalPathFor(storageKey: string): string {
    return this.resolveWithinRoot(storageKey);
  }
}
