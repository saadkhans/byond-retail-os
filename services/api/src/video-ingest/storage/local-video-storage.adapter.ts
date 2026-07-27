import { mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VideoStoragePort } from './video-storage.port';

/**
 * Storage keys are server-generated (tenant id / random UUID / fixed names),
 * so this charset is a DEFENSE-IN-DEPTH invariant, not a parser: any key
 * outside it means a code path built a key from user input — refuse.
 */
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9/._-]*$/;

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
 * throws before any filesystem call.
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

  async put(storageKey: string, data: Buffer): Promise<void> {
    const target = this.resolveWithinRoot(storageKey);
    await mkdir(resolve(target, '..'), { recursive: true });
    await writeFile(target, data);
  }

  async read(storageKey: string): Promise<Buffer> {
    return readFile(this.resolveWithinRoot(storageKey));
  }

  async delete(storageKey: string): Promise<void> {
    await unlink(this.resolveWithinRoot(storageKey)).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      },
    );
  }

  async deletePrefix(storageKeyPrefix: string): Promise<void> {
    const target = this.resolveWithinRoot(storageKeyPrefix);
    // Refuse to treat the root itself as a deletable prefix.
    if (target === this.root) {
      throw new InvalidStorageKeyError();
    }
    await rm(target, { recursive: true, force: true });
  }

  internalPathFor(storageKey: string): string {
    return this.resolveWithinRoot(storageKey);
  }
}
