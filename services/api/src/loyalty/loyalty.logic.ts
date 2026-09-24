/**
 * Pure loyalty and promotion logic. No Prisma, no Nest — the repository loads
 * candidate rows and this decides what a promotion does to a price, and what a
 * points movement does to a balance. Both are money decisions, so both are
 * unit-testable in isolation and both are integer-exact.
 *
 * THE INVARIANT THIS FILE ENFORCES: a promotion is strictly SUBTRACTIVE and
 * composes on top of an already-resolved price version. Nothing here takes a
 * price book, a price version, or a price entry as input — the only thing it
 * ever sees of pricing is a `basePriceMinor` number that pricing already
 * decided — and nothing here can produce a final price above that base.
 */

import { BASIS_POINTS_PER_WHOLE, LOYALTY_POINTS_MAX } from './loyalty.constants';

// ---------------------------------------------------------------- promotions

/** Promotion version statuses that can ever apply a discount. */
export const APPLICABLE_PROMOTION_STATUSES = ['ACTIVE', 'SUPERSEDED'] as const;
export type ApplicablePromotionStatus =
  (typeof APPLICABLE_PROMOTION_STATUSES)[number];

export type PromotionRuleKindValue =
  | 'PERCENT_OFF'
  | 'AMOUNT_OFF'
  | 'FIXED_UNIT_PRICE';

export type PromotionAudienceValue = 'ALL_SHOPPERS' | 'LOYALTY_MEMBERS';

/** One rule the repository offers to the selector, flattened. */
export interface PromotionRuleCandidate {
  ruleId: string;
  /** NULL = applies to every product; set = that product only. */
  productId: string | null;
  kind: PromotionRuleKindValue;
  value: number;
  maxDiscountMinor: number | null;
}

/** One promotion version the repository offers to the selector, flattened. */
export interface PromotionCandidate {
  promotionId: string;
  promotionCode: string;
  /** NULL = tenant-wide promotion; set = scoped to that location. */
  promotionLocationId: string | null;
  audience: PromotionAudienceValue;
  priority: number;
  promotionVersionId: string;
  versionNumber: number;
  status: ApplicablePromotionStatus;
  effectiveFrom: Date;
  /** Exclusive; NULL while the version is still current. */
  effectiveTo: Date | null;
  rules: readonly PromotionRuleCandidate[];
}

export interface PromotionContext {
  productId: string;
  /** The price the price version resolved. Never mutated, only subtracted from. */
  basePriceMinor: number;
  at: Date;
  locationId: string | null;
  /** True only when the basket carries an ACTIVE loyalty account. */
  memberPresent: boolean;
}

export interface PromotionOutcome {
  promotionId: string;
  promotionVersionId: string;
  ruleId: string;
  kind: PromotionRuleKindValue;
  /** Always in [0, basePriceMinor]. */
  discountMinor: number;
  /** Always basePriceMinor - discountMinor. */
  finalUnitPriceMinor: number;
}

/**
 * True when `at` falls inside the version's half-open window
 * [effectiveFrom, effectiveTo).
 *
 * Half-open for the same reason price windows are: the instant a new version
 * starts is the instant the old one stops, so exactly one version of a
 * promotion covers any instant and a discount change has no ambiguous second.
 */
export function isPromotionEffectiveAt(
  candidate: PromotionCandidate,
  at: Date,
): boolean {
  if (candidate.effectiveFrom.getTime() > at.getTime()) {
    return false;
  }
  return (
    candidate.effectiveTo === null ||
    candidate.effectiveTo.getTime() > at.getTime()
  );
}

/**
 * What one rule takes off a base price, in minor units.
 *
 * Clamped into [0, basePriceMinor] on every path, so no rule kind — and no
 * operator typo in a rule value — can produce a negative price or an increase.
 *
 * Integer-exact: PERCENT_OFF floors the DISCOUNT, never the price, so the
 * rounding direction is fixed and stated rather than emergent. There is no
 * floating-point money anywhere in this path.
 */
export function ruleDiscountMinor(
  rule: PromotionRuleCandidate,
  basePriceMinor: number,
): number {
  if (!Number.isInteger(basePriceMinor) || basePriceMinor <= 0) {
    return 0;
  }
  let discount: number;
  switch (rule.kind) {
    case 'PERCENT_OFF':
      discount = Math.floor(
        (basePriceMinor * rule.value) / BASIS_POINTS_PER_WHOLE,
      );
      break;
    case 'AMOUNT_OFF':
      discount = rule.value;
      break;
    case 'FIXED_UNIT_PRICE':
      // A "fixed price" above the base is not a price rise — it is simply not
      // a discount, so the promotion does not apply at all.
      discount = rule.value >= basePriceMinor ? 0 : basePriceMinor - rule.value;
      break;
    default: {
      const exhaustive: never = rule.kind;
      void exhaustive;
      return 0;
    }
  }
  if (rule.maxDiscountMinor !== null) {
    discount = Math.min(discount, rule.maxDiscountMinor);
  }
  return Math.max(0, Math.min(discount, basePriceMinor));
}

/**
 * The rule of a version that applies to one product: the product-specific
 * rule if the version has one, otherwise the catalog-wide rule. Never both —
 * rules within a version do not stack either.
 */
export function ruleForProduct(
  candidate: PromotionCandidate,
  productId: string,
): PromotionRuleCandidate | null {
  const specific = candidate.rules.find((rule) => rule.productId === productId);
  if (specific) {
    return specific;
  }
  return candidate.rules.find((rule) => rule.productId === null) ?? null;
}

/** Location-scoped promotions beat the tenant-wide one, as price books do. */
function promotionSpecificity(candidate: PromotionCandidate): number {
  return candidate.promotionLocationId === null ? 0 : 1;
}

interface ScoredPromotion {
  candidate: PromotionCandidate;
  rule: PromotionRuleCandidate;
  discountMinor: number;
}

/**
 * Picks the ONE promotion that applies to a basket line.
 *
 * The rule, in order:
 *  1. Only versions whose half-open window contains `at` are considered.
 *     SUPERSEDED versions stay eligible so a historical quote ("what did this
 *     basket cost last Tuesday?") reproduces exactly. DRAFT and ARCHIVED
 *     never apply.
 *  2. Only promotions that apply at `locationId`: tenant-wide always, a
 *     location-scoped promotion only at its own location.
 *  3. LOYALTY_MEMBERS promotions need an ACTIVE loyalty account on the basket.
 *  4. The version must have a rule for this product (specific, else
 *     catalog-wide) that actually takes something off. A promotion that
 *     discounts nothing is NOT applied, so a line never names a promotion
 *     that did not change its price.
 *  5. PROMOTIONS DO NOT STACK. Exactly one applies — the one giving the
 *     largest discount. Stacking is refused deliberately: two discounts
 *     composing produce a price no single rule explains, and the resulting
 *     total is unbounded below without a separate floor rule. Operators who
 *     want a combined effect express it as one rule.
 *  6. Ties break deterministically: higher promotion priority, then the more
 *     specific (location-scoped) promotion, then the later effectiveFrom,
 *     then the higher version number, then the promotion code. Determinism
 *     matters more than the choice itself — the same basket must never price
 *     differently on a retry.
 *
 * Returns null when nothing applies, which callers must treat as "no
 * discount" — the base price stands, unchanged and still fully explained by
 * its price version.
 */
export function selectPromotion(
  candidates: readonly PromotionCandidate[],
  ctx: PromotionContext,
): PromotionOutcome | null {
  const scored: ScoredPromotion[] = [];
  for (const candidate of candidates) {
    if (!isPromotionEffectiveAt(candidate, ctx.at)) {
      continue;
    }
    if (
      candidate.promotionLocationId !== null &&
      (ctx.locationId == null ||
        candidate.promotionLocationId !== ctx.locationId)
    ) {
      continue;
    }
    if (candidate.audience === 'LOYALTY_MEMBERS' && !ctx.memberPresent) {
      continue;
    }
    const rule = ruleForProduct(candidate, ctx.productId);
    if (!rule) {
      continue;
    }
    const discountMinor = ruleDiscountMinor(rule, ctx.basePriceMinor);
    if (discountMinor <= 0) {
      continue;
    }
    scored.push({ candidate, rule, discountMinor });
  }
  if (scored.length === 0) {
    return null;
  }
  const best = scored.reduce((winner, entry) =>
    comparePromotions(entry, winner) > 0 ? entry : winner,
  );
  return {
    promotionId: best.candidate.promotionId,
    promotionVersionId: best.candidate.promotionVersionId,
    ruleId: best.rule.ruleId,
    kind: best.rule.kind,
    discountMinor: best.discountMinor,
    finalUnitPriceMinor: ctx.basePriceMinor - best.discountMinor,
  };
}

/** > 0 when `a` outranks `b`. */
function comparePromotions(a: ScoredPromotion, b: ScoredPromotion): number {
  const byDiscount = a.discountMinor - b.discountMinor;
  if (byDiscount !== 0) {
    return byDiscount;
  }
  const byPriority = a.candidate.priority - b.candidate.priority;
  if (byPriority !== 0) {
    return byPriority;
  }
  const bySpecificity =
    promotionSpecificity(a.candidate) - promotionSpecificity(b.candidate);
  if (bySpecificity !== 0) {
    return bySpecificity;
  }
  const byStart =
    a.candidate.effectiveFrom.getTime() - b.candidate.effectiveFrom.getTime();
  if (byStart !== 0) {
    return byStart;
  }
  const byVersion = a.candidate.versionNumber - b.candidate.versionNumber;
  if (byVersion !== 0) {
    return byVersion;
  }
  return a.candidate.promotionCode < b.candidate.promotionCode
    ? 1
    : a.candidate.promotionCode > b.candidate.promotionCode
      ? -1
      : 0;
}

// -------------------------------------------------------------- points ledger

export type LedgerRejection =
  | 'zero-points'
  | 'insufficient-points'
  | 'points-overflow';

export interface LedgerTail {
  /** Highest sequence number already used by this account; 0 when empty. */
  sequenceNumber: number;
  /** Balance DERIVED from the movements so far (SUM of points). */
  balance: number;
}

export interface LedgerAppend {
  sequenceNumber: number;
  balanceAfter: number;
}

/**
 * Projects the next ledger row from the tail and a signed delta.
 *
 * This is where the balance floor is DECIDED; it is not where the floor is
 * ENFORCED. Enforcement is the `balanceAfter >= 0` CHECK on the inserted row
 * plus the unique (accountId, sequenceNumber) index, both in the Phase 29
 * migration: if this function ever had a bug, or two appends raced past the
 * advisory lock, the write FAILS instead of producing a negative balance.
 * Deciding here only buys a clean 409 instead of a database error.
 */
export function projectLedgerAppend(
  tail: LedgerTail,
  points: number,
): LedgerAppend | LedgerRejection {
  if (!Number.isInteger(points) || points === 0) {
    return 'zero-points';
  }
  const balanceAfter = tail.balance + points;
  if (balanceAfter < 0) {
    return 'insufficient-points';
  }
  if (balanceAfter > LOYALTY_POINTS_MAX) {
    return 'points-overflow';
  }
  return { sequenceNumber: tail.sequenceNumber + 1, balanceAfter };
}

/**
 * The signed delta a movement type applies, given a positive magnitude.
 * REDEMPTION and EXPIRY take points away; ACCRUAL adds them. ADJUSTMENT and
 * REVERSAL carry their own sign, because a correction can go either way.
 */
export function signedPoints(
  type: 'ACCRUAL' | 'REDEMPTION' | 'ADJUSTMENT' | 'EXPIRY' | 'REVERSAL',
  magnitudeOrSigned: number,
): number {
  switch (type) {
    case 'ACCRUAL':
      return Math.abs(magnitudeOrSigned);
    case 'REDEMPTION':
    case 'EXPIRY':
      return -Math.abs(magnitudeOrSigned);
    default:
      return magnitudeOrSigned;
  }
}

// ------------------------------------------------------------- normalization

/** Normalizes a loyalty member code the way SKUs and price book codes are. */
export function normalizeMemberCode(raw: string): string {
  return raw.trim().toUpperCase();
}

/** Normalizes a promotion code the way price book codes are. */
export function normalizePromotionCode(raw: string): string {
  return raw.trim().toUpperCase();
}

/**
 * Normalizes an operator reason code into the closed-vocabulary shape the
 * ledger stores: uppercase, underscore-separated, letters and digits only.
 * Anything else is rejected by the DTO before it gets here.
 */
export function normalizeReasonCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[\s-]+/g, '_');
}

export function isReasonCode(value: string): boolean {
  return /^[A-Z][A-Z0-9_]{0,39}$/.test(value);
}
