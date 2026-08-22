import { createHash } from 'node:crypto';

/**
 * Phase 18 — deterministic split bucketing.
 *
 * sha256 is used (NOT Postgres hashtext, which is a locking convenience
 * with no cross-version stability contract) so the same
 * tenant/run/group key lands in the same bucket on every machine and
 * every rerun — split assignment must be reproducible, never random.
 */
export const SPLIT_BUCKET_SPACE = 10000;

export function splitBucket(key: string): number {
  const head = createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 8);
  return Number.parseInt(head, 16) % SPLIT_BUCKET_SPACE;
}
