/**
 * Pure price-resolution logic. No Prisma, no Nest — the repository loads
 * candidate rows and this decides which one wins, so the rule that determines
 * what a shopper is charged is unit-testable in isolation.
 */

/** Which version statuses can ever resolve a price. */
export const RESOLVABLE_VERSION_STATUSES = ['ACTIVE', 'SUPERSEDED'] as const;
export type ResolvableVersionStatus =
  (typeof RESOLVABLE_VERSION_STATUSES)[number];

/**
 * One row the repository offers to the resolver: a product's price in one
 * version of one book, flattened.
 */
export interface PriceCandidate {
  priceBookId: string;
  priceBookCode: string;
  /** NULL = tenant-wide book; set = scoped to that location. */
  priceBookLocationId: string | null;
  priceBookVersionId: string;
  versionNumber: number;
  status: ResolvableVersionStatus;
  effectiveFrom: Date;
  /** Exclusive; NULL while the version is still current. */
  effectiveTo: Date | null;
  unitPriceMinor: number;
  currencyCode: string;
}

export interface ResolvedPrice {
  unitPriceMinor: number;
  currencyCode: string;
  priceBookId: string;
  priceBookVersionId: string;
}

/**
 * True when `at` falls inside the version's half-open effective window
 * [effectiveFrom, effectiveTo).
 *
 * Half-open on purpose: the instant a new version starts is the instant the
 * old one stops, so exactly one version covers any instant and a price change
 * has no overlapping second of ambiguity.
 */
export function isEffectiveAt(candidate: PriceCandidate, at: Date): boolean {
  if (candidate.effectiveFrom.getTime() > at.getTime()) {
    return false;
  }
  return (
    candidate.effectiveTo === null ||
    candidate.effectiveTo.getTime() > at.getTime()
  );
}

/** Location-scoped books beat the tenant-wide book. */
function specificity(candidate: PriceCandidate): number {
  return candidate.priceBookLocationId === null ? 0 : 1;
}

/**
 * Picks the price that applies to one product at one instant.
 *
 * The rule, in order:
 *  1. Only versions whose effective window contains `at` are considered.
 *     SUPERSEDED versions stay eligible, which is what makes a historical
 *     lookup ("what did this cost last Tuesday?") return the right answer
 *     instead of today's price. DRAFT and ARCHIVED never resolve — the caller
 *     is expected not to offer them.
 *  2. Only books that apply at `locationId` are considered: the tenant-wide
 *     book (locationId null) always applies; a location-scoped book applies
 *     only at its own location.
 *  3. The most specific book wins — a location-scoped book overrides the
 *     tenant-wide one for that location.
 *  4. Ties (which should not happen, since a book has at most one ACTIVE
 *     version and windows do not overlap) break deterministically: later
 *     effectiveFrom, then higher versionNumber, then book code. Determinism
 *     matters more than the choice itself — the same basket must never price
 *     differently on a retry.
 *
 * Returns null when nothing applies, which callers must treat as "unpriced",
 * never as "free".
 */
export function selectPrice(
  candidates: readonly PriceCandidate[],
  at: Date,
  locationId?: string | null,
): ResolvedPrice | null {
  const applicable = candidates.filter(
    (candidate) =>
      isEffectiveAt(candidate, at) &&
      (candidate.priceBookLocationId === null ||
        (locationId != null && candidate.priceBookLocationId === locationId)),
  );
  if (applicable.length === 0) {
    return null;
  }
  const best = applicable.reduce((winner, candidate) =>
    comparePrecedence(candidate, winner) > 0 ? candidate : winner,
  );
  return {
    unitPriceMinor: best.unitPriceMinor,
    currencyCode: best.currencyCode,
    priceBookId: best.priceBookId,
    priceBookVersionId: best.priceBookVersionId,
  };
}

/** > 0 when `a` outranks `b`. */
function comparePrecedence(a: PriceCandidate, b: PriceCandidate): number {
  const bySpecificity = specificity(a) - specificity(b);
  if (bySpecificity !== 0) {
    return bySpecificity;
  }
  const byStart = a.effectiveFrom.getTime() - b.effectiveFrom.getTime();
  if (byStart !== 0) {
    return byStart;
  }
  const byVersion = a.versionNumber - b.versionNumber;
  if (byVersion !== 0) {
    return byVersion;
  }
  return a.priceBookCode < b.priceBookCode
    ? 1
    : a.priceBookCode > b.priceBookCode
      ? -1
      : 0;
}

/**
 * Line total for a quantity at a unit price. Integer-exact: prices are minor
 * units, so there is no floating point anywhere in the money path.
 */
export function lineTotalMinor(
  unitPriceMinor: number,
  quantity: number,
): number {
  return unitPriceMinor * quantity;
}

/** Normalizes a price book code the way SKUs are normalized. */
export function normalizePriceBookCode(raw: string): string {
  return raw.trim().toUpperCase();
}

/** ISO-4217 alphabetic codes only — three uppercase letters. */
export function normalizeCurrencyCode(raw: string): string {
  return raw.trim().toUpperCase();
}

export function isCurrencyCode(value: string): boolean {
  return /^[A-Z]{3}$/.test(value);
}

export interface BasketLinePrice {
  unitPriceMinor: number | null;
  lineTotalMinor: number | null;
  currencyCode: string | null;
}

export interface BasketTotals {
  subtotalMinor: number;
  totalMinor: number;
  currencyCode: string;
}

/**
 * Totals for a completed basket, or null when the basket cannot be totalled.
 *
 * Deliberately all-or-nothing: a partially priced basket produces NO total
 * rather than a total that silently omits lines. An order either carries a
 * complete, defensible amount or carries none at all — which is exactly the
 * pre-Phase-25 behaviour, so unpriced tenants are unaffected.
 *
 * `totalMinor` equals `subtotalMinor` today. Tax, discounts and promotions
 * are separate phases; keeping the two fields distinct now means adding them
 * later does not change the shape of an order.
 */
export function computeBasketTotals(
  lines: readonly BasketLinePrice[],
): BasketTotals | null {
  if (lines.length === 0) {
    return null;
  }
  let subtotalMinor = 0;
  let currencyCode: string | null = null;
  for (const line of lines) {
    if (
      line.unitPriceMinor === null ||
      line.lineTotalMinor === null ||
      line.currencyCode === null
    ) {
      return null;
    }
    if (currencyCode === null) {
      currencyCode = line.currencyCode;
    } else if (currencyCode !== line.currencyCode) {
      // A mixed-currency basket has no meaningful single total.
      return null;
    }
    subtotalMinor += line.lineTotalMinor;
  }
  if (currencyCode === null) {
    return null;
  }
  return { subtotalMinor, totalMinor: subtotalMinor, currencyCode };
}
