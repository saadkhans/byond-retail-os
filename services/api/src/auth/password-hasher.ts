import { Injectable } from '@nestjs/common';
import { compare, hash } from 'bcryptjs';

/**
 * Adapter seam for credential hashing (AGENTS.md: adapter-first, no vendor
 * lock-in). Swapping to argon2id later means providing a new implementation
 * for this token — no service changes.
 */
export interface PasswordHasher {
  hash(plaintext: string): Promise<string>;
  verify(plaintext: string, passwordHash: string): Promise<boolean>;
  /**
   * Burns the same work a real verify() would, against an adapter-owned
   * dummy credential — used to equalize response timing on login paths that
   * would otherwise short-circuit (unknown email, no local credential, ...).
   * Adapter-owned so the equalization cost always matches the algorithm in
   * use (bcrypt today, argon2id later). MUST never throw and MUST never
   * succeed as an authentication.
   */
  equalizeTiming(candidate: string): Promise<void>;
}

export const PASSWORD_HASHER = Symbol('PASSWORD_HASHER');

/** bcrypt cost 12 per SECURITY.md guidance (argon2id preferred later). */
export const BCRYPT_COST = 12;

/**
 * bcrypt silently truncates input after 72 BYTES (not characters — UTF-8
 * multibyte counts). Anything longer must be rejected up front, otherwise
 * two long passwords sharing their first 72 bytes verify as equal.
 */
export const MAX_PASSWORD_BYTES = 72;

/** Login password policy minimum — shared by the DTO and the seed. */
export const MIN_PASSWORD_LENGTH = 8;

export class PasswordTooLongError extends Error {
  constructor() {
    super(
      `Password exceeds the ${MAX_PASSWORD_BYTES}-byte limit of the hashing algorithm`,
    );
    this.name = 'PasswordTooLongError';
  }
}

export function exceedsPasswordByteLimit(plaintext: string): boolean {
  return Buffer.byteLength(plaintext, 'utf8') > MAX_PASSWORD_BYTES;
}

// Precomputed bcrypt cost-12 hash of an arbitrary published constant
// ('byond-timing-equalization-constant'). NOT a secret and NOT a usable
// credential — it exists only so equalizeTiming() burns real cost-12 work
// without any boot-time hashing that could fail and silently disable
// equalization.
const TIMING_EQUALIZATION_HASH =
  '$2b$12$5upyktepvVaMGD799dAXfe3lOBjv6Tk/Fg4n31vF8xpL4FNQQcYOy';

@Injectable()
export class BcryptPasswordHasher implements PasswordHasher {
  async hash(plaintext: string): Promise<string> {
    if (exceedsPasswordByteLimit(plaintext)) {
      throw new PasswordTooLongError();
    }
    return hash(plaintext, BCRYPT_COST);
  }

  async verify(plaintext: string, passwordHash: string): Promise<boolean> {
    if (exceedsPasswordByteLimit(plaintext)) {
      // Fail closed without doing bcrypt work: an over-limit password can
      // never be the credential, because hash() refuses to create one.
      return false;
    }
    try {
      return await compare(plaintext, passwordHash);
    } catch {
      // A malformed/corrupted stored hash must read as a normal failed
      // login (fail closed), not bubble up as a 500 that would reveal the
      // account exists but its credential is broken.
      return false;
    }
  }

  async equalizeTiming(candidate: string): Promise<void> {
    try {
      await this.verify(candidate, TIMING_EQUALIZATION_HASH);
    } catch {
      // Contract: equalization never throws and never changes outcomes.
    }
  }
}
