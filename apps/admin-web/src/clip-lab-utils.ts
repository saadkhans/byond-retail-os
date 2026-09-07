/**
 * Clip Lab formatting helpers — PURE. The confidence summary renders the
 * stages' own 0..1 signals as percentages for readability; they are
 * uncalibrated ranking values, never probabilities, and the page says so.
 * Keeping the arithmetic here (not in the page) keeps the page's static
 * safety pin on inline "score * 100" meaningful.
 */

/** 0..1 → "61%"; null / non-finite → "—". Clamped to 0..100. */
export function percentLabel(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '—';
  }
  const clamped = Math.min(1, Math.max(0, value));
  return `${Math.round(clamped * 100)}%`;
}

/** Margin between the top two candidates, in percentage points. */
export function marginLabel(points: number | null | undefined): string {
  if (typeof points !== 'number' || !Number.isFinite(points)) {
    return '—';
  }
  const rounded = Math.round(points * 100);
  return `${rounded >= 0 ? '+' : ''}${rounded} pts`;
}

/** "product in N of M sampled frames" or "—" when the detector did not run. */
export function frameCoverageLabel(
  productFrames: number | null,
  sampledFrames: number | null,
): string {
  if (productFrames === null || sampledFrames === null) {
    return '—';
  }
  return `product in ${productFrames} of ${sampledFrames} sampled frames`;
}
