/**
 * The repository's ONE request-rate mechanism, lifted out of
 * `LoginThrottleGuard` so the second caller (the public shopper surface) is
 * the same throttle rather than a second one with its own bugs.
 *
 * It is an in-memory sliding window over a set of named buckets. Callers
 * decide what a bucket MEANS — login uses (IP + attempted email) and (IP);
 * the shopper surface uses (IP) and (IP + credential fingerprint) — and every
 * bucket a request names must have headroom, so a caller cannot slip past a
 * broad bucket by varying what the narrow one keys on.
 *
 * PRODUCTION NOTE (unchanged from the login guard): this store is
 * per-process. Multi-instance deployments need shared (e.g. Redis-backed)
 * throttling in a later phase — this is the app-level control, not the final
 * distributed one.
 */

/** One named counter and the number of requests it admits per window. */
export interface ThrottleBucket {
  key: string;
  limit: number;
}

export class SlidingWindowThrottle {
  private readonly attempts = new Map<string, number[]>();

  /**
   * Charge ONE request against every bucket, or against none.
   *
   * Returns false when ANY bucket is already exhausted, and records nothing
   * in that case, so a refused request does not extend its own lockout and
   * the window slides out naturally.
   */
  consume(buckets: readonly ThrottleBucket[], windowMs: number): boolean {
    const now = Date.now();
    const recent = buckets.map((bucket) =>
      this.recentAttempts(bucket.key, now, windowMs),
    );
    const exhausted = buckets.some(
      (bucket, index) => recent[index].length >= bucket.limit,
    );
    if (exhausted) {
      return false;
    }
    buckets.forEach((bucket, index) => {
      recent[index].push(now);
      this.attempts.set(bucket.key, recent[index]);
    });
    this.pruneIfLarge(now, windowMs);
    return true;
  }

  private recentAttempts(
    key: string,
    now: number,
    windowMs: number,
  ): number[] {
    const recent = (this.attempts.get(key) ?? []).filter(
      (timestamp) => now - timestamp < windowMs,
    );
    this.attempts.set(key, recent);
    return recent;
  }

  /** Bound the map: without this, one key per rotated value would grow it
   *  without limit. Entries whose whole window has slid out are dropped. */
  private pruneIfLarge(now: number, windowMs: number): void {
    if (this.attempts.size <= 10_000) {
      return;
    }
    for (const [key, timestamps] of this.attempts) {
      const live = timestamps.filter((timestamp) => now - timestamp < windowMs);
      if (live.length === 0) {
        this.attempts.delete(key);
      } else {
        this.attempts.set(key, live);
      }
    }
  }
}
