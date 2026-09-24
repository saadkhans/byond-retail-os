import type {
  LoyaltyPointMovement,
  PriceQuote,
  Promotion,
  PromotionRule,
  PromotionRuleKind,
  PromotionVersion,
} from './api';

/**
 * Pure presentation helpers for the Loyalty & promotions page.
 *
 * They live here, away from JSX, so the two things an operator MUST be able
 * to trust are unit-tested: that a quote is explained as base minus discount
 * (never as a mystery number), and that a points balance is read off the
 * ledger rather than invented.
 */

/** Minor units → a readable amount. Display only; never used for maths. */
export function formatMoney(
  minor: number | null | undefined,
  currencyCode: string | null | undefined,
): string {
  if (minor === null || minor === undefined || !currencyCode) {
    return '—';
  }
  return `${(minor / 100).toFixed(2)} ${currencyCode}`;
}

/** Signed points, always with an explicit sign so a redemption reads as one. */
export function formatPoints(points: number): string {
  return points > 0 ? `+${points}` : `${points}`;
}

/** Plain-English description of one rule, for operators who do not read enums. */
export function describeRule(rule: {
  kind: PromotionRuleKind;
  value: number;
  maxDiscountMinor?: number | null;
}): string {
  switch (rule.kind) {
    case 'PERCENT_OFF': {
      const percent = (rule.value / 100).toFixed(2).replace(/\.?0+$/, '');
      const cap =
        rule.maxDiscountMinor === null || rule.maxDiscountMinor === undefined
          ? ''
          : `, capped at ${(rule.maxDiscountMinor / 100).toFixed(2)}`;
      return `${percent}% off${cap}`;
    }
    case 'AMOUNT_OFF':
      return `${(rule.value / 100).toFixed(2)} off`;
    case 'FIXED_UNIT_PRICE':
      return `fixed unit price ${(rule.value / 100).toFixed(2)}`;
    default:
      return 'unknown rule';
  }
}

export function describeRuleScope(
  rule: Pick<PromotionRule, 'productId'> & {
    product?: { sku: string } | null;
  },
): string {
  if (rule.productId === null) {
    return 'every product';
  }
  return rule.product?.sku ?? rule.productId;
}

/**
 * The ONE sentence the quote panel exists to show. It always names the price
 * version, so a discounted price is never presented as if it came from
 * nowhere — and when no promotion applies it says the price version alone
 * decided the price.
 */
export function explainQuote(quote: PriceQuote): string {
  const base = formatMoney(quote.basePriceMinor, quote.currencyCode);
  if (!quote.promotion) {
    return `${base} from price version ${quote.priceBookVersionId}. No promotion applies.`;
  }
  const discount = formatMoney(
    quote.promotion.discountMinor,
    quote.currencyCode,
  );
  const paid = formatMoney(quote.unitPriceMinor, quote.currencyCode);
  return (
    `${base} from price version ${quote.priceBookVersionId}, ` +
    `less ${discount} from promotion version ${quote.promotion.promotionVersionId}, ` +
    `= ${paid}.`
  );
}

/**
 * True when a quote is internally consistent: what is paid is exactly the
 * base minus the discount, and the discount never exceeds the base. A false
 * here means the page is being shown a price it cannot explain, which is a
 * bug worth surfacing rather than rendering.
 */
export function quoteIsExplainable(quote: PriceQuote): boolean {
  const discount = quote.promotion?.discountMinor ?? 0;
  if (discount < 0 || discount > quote.basePriceMinor) {
    return false;
  }
  return quote.unitPriceMinor === quote.basePriceMinor - discount;
}

/** The version currently in force, if any. */
export function activeVersion(
  promotion: Pick<Promotion, 'versions'>,
): PromotionVersion | null {
  return (
    promotion.versions?.find((version) => version.status === 'ACTIVE') ?? null
  );
}

/** Newest draft, which is the one an operator is most likely editing. */
export function latestDraft(
  promotion: Pick<Promotion, 'versions'>,
): PromotionVersion | null {
  const drafts = (promotion.versions ?? []).filter(
    (version) => version.status === 'DRAFT',
  );
  if (drafts.length === 0) {
    return null;
  }
  return drafts.reduce((newest, version) =>
    version.versionNumber > newest.versionNumber ? version : newest,
  );
}

/**
 * The balance as the LEDGER reports it: the stamp on the newest movement, or
 * zero for an empty ledger. Never a running total the page keeps for itself.
 */
export function balanceFromLedger(
  movements: readonly LoyaltyPointMovement[],
): number {
  if (movements.length === 0) {
    return 0;
  }
  return movements.reduce((newest, movement) =>
    movement.sequenceNumber > newest.sequenceNumber ? movement : newest,
  ).balanceAfter;
}

/**
 * A replay-safe key for one operator action. The API is idempotent on it, so
 * a double-click or a retried request moves points once.
 */
export function movementIdempotencyKey(
  accountId: string,
  action: string,
  at: Date = new Date(),
): string {
  return `admin:${action}:${accountId}:${at.getTime()}`;
}
