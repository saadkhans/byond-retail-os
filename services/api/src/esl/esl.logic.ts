import { createHash } from 'node:crypto';
import {
  ESL_UPDATE_BACKOFF_BASE_SECONDS,
  ESL_UPDATE_MAX_ATTEMPTS,
} from './esl.constants';
import { EslLabelContent } from './ports';

/**
 * Pure ESL rules, kept out of the service so they can be exercised without a
 * database — same split as pricing.logic.ts.
 */

export function normalizeGatewayCode(raw: string): string {
  return raw.trim().toUpperCase();
}

export function normalizeVendorCode(raw: string): string {
  return raw.trim().toUpperCase();
}

/**
 * Fingerprint of what a label should show. Stable across processes (it feeds
 * an idempotency decision), and it stores no content itself — only the hash
 * is persisted, so a label's rendered state is comparable without keeping a
 * copy of the price on the job row.
 */
export function contentHash(content: EslLabelContent): string {
  const canonical = JSON.stringify([
    content.sku,
    content.productName,
    content.unitPriceMinor,
    content.currencyCode,
  ]);
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

/**
 * De-duplication key. A price activation uses the version and the label, so
 * replaying the same activation — by a retried publish, a reconnecting
 * listener, or the reconciliation sweep — cannot enqueue the work twice.
 * Non-activation triggers carry a caller-supplied discriminator instead,
 * because an operator asking twice for a re-render means it twice.
 */
export function activationIdempotencyKey(
  priceBookVersionId: string,
  labelId: string,
): string {
  return `activation:${priceBookVersionId}:${labelId}`;
}

export function manualIdempotencyKey(
  labelId: string,
  discriminator: string,
): string {
  return `manual:${labelId}:${discriminator}`;
}

export function reconciliationIdempotencyKey(
  labelId: string,
  hash: string,
): string {
  return `reconcile:${labelId}:${hash}`;
}

/**
 * When a failed attempt becomes claimable again: exponential backoff from the
 * attempt number, so a flapping gateway spreads its budget over minutes
 * instead of burning it in a single processing pass.
 */
export function nextAttemptAt(attempts: number, from: Date): Date {
  const exponent = Math.max(0, attempts - 1);
  const seconds = ESL_UPDATE_BACKOFF_BASE_SECONDS * 2 ** exponent;
  return new Date(from.getTime() + seconds * 1000);
}

/** True when this attempt exhausted the budget and the job must FAIL. */
export function attemptsExhausted(attempts: number): boolean {
  return attempts >= ESL_UPDATE_MAX_ATTEMPTS;
}

/**
 * A push is unnecessary when the label already shows exactly this content.
 * Treated as success rather than skipped work, so replay is free and the job
 * history still records that the label was verified.
 */
export function alreadyRendered(
  renderedContentHash: string | null,
  desired: string,
): boolean {
  return renderedContentHash !== null && renderedContentHash === desired;
}

/** Clamp vendor-reported health into the range the CHECK constraints allow. */
export function clampPercent(value: number | undefined): number | null {
  if (value === undefined || !Number.isFinite(value)) {
    return null;
  }
  return Math.min(100, Math.max(0, Math.round(value)));
}
