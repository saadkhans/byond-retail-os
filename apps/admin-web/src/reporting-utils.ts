import type { BadgeTone } from './components';

/**
 * Display helpers for the Phase 30 reporting page.
 *
 * Everything here is presentation only. No number is derived, adjusted or
 * combined in the browser: the API computed each figure from the ledger and
 * the evaluation tables, and the page's job is to show it — and to show, just
 * as plainly, when a figure does not reconcile or when a "variance" is
 * actually a platform defect.
 */

/** Minor currency units to a readable amount. Display only; never maths. */
export function money(minor: number | null, currencyCode: string | null): string {
  if (minor === null) {
    return '—';
  }
  return `${(minor / 100).toFixed(2)}${currencyCode ? ` ${currencyCode}` : ''}`;
}

/**
 * A rate the API declined to compute stays declined. A null denominator is
 * "not enough data", never 0%.
 */
export function percent(rate: number | null): string {
  return rate === null ? 'not enough data' : `${(rate * 100).toFixed(1)}%`;
}

/** Signed integers read better with the sign shown. */
export function signed(quantity: number): string {
  return quantity > 0 ? `+${quantity}` : `${quantity}`;
}

/** An ISO window as a readable "from → to". */
export function windowLabel(window: { from: string; to: string }): string {
  return `${new Date(window.from).toLocaleString()} → ${new Date(
    window.to,
  ).toLocaleString()}`;
}

/**
 * The line every report carries above its numbers.
 *
 * Reporting derives on read, so the answer is "as of the moment you asked".
 * The phrasing is deliberate: if a materialised figure is ever introduced,
 * `stale` stops being false and this sentence has to change with it — the
 * page can never present a stale number as live.
 */
export function asOfLabel(provenance: {
  generatedAt: string;
  derivation: string;
  stale: boolean;
  sourceOfTruth: string[];
}): string {
  const at = new Date(provenance.generatedAt).toLocaleString();
  const from = provenance.sourceOfTruth.join(', ');
  return provenance.stale
    ? `Cached figure — as of ${at}, from ${from}. NOT live.`
    : `Derived on read at ${at}, from ${from}. Nothing here is cached.`;
}

/**
 * Does a reconciliation flag mean "these two independent computations agree"?
 * Rendered as a badge, because a report that quietly disagrees with itself is
 * worse than one that says so.
 */
export function reconciliationTone(reconciled: boolean): BadgeTone {
  return reconciled ? 'ok' : 'down';
}

export function reconciliationLabel(reconciled: boolean): string {
  return reconciled ? 'Reconciles' : 'Does not reconcile';
}

/**
 * Projection-vs-ledger drift is NOT stock variance.
 *
 * Phase 27 recorded the two as separate columns precisely so an operator
 * would never see a platform bug averaged into their shelf count, and this
 * page keeps them apart: drift gets its own tone, its own words, and never
 * appears in the same figure as a variance.
 */
export function driftTone(healthy: boolean): BadgeTone {
  return healthy ? 'ok' : 'down';
}

export function driftLabel(healthy: boolean): string {
  return healthy
    ? 'Projection agrees with the ledger'
    : 'PLATFORM DEFECT — the projection disagrees with its own ledger history';
}

/**
 * How a shrink figure relates to damaged returns. The answer is always "it
 * does not": a damaged return writes no ledger movement, so it is never part
 * of a shrink total.
 */
export function damagedReturnsNote(units: number): string {
  return units === 0
    ? 'No damaged returns in this window.'
    : `${units} unit(s) came back damaged and did NOT go back on the shelf. ` +
        'These write no ledger movement and are NOT counted as shrink.';
}
