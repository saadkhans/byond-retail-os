import { Prisma } from '@prisma/client';
import { ResolvedLinePrice } from './line-pricing.port';

/**
 * The second, optional thing checkout asks for when it writes a basket line:
 * "does a promotion reduce this already-resolved price?".
 *
 * IT IS A SECOND PORT ON PURPOSE. Pricing answers "what does this cost" and
 * nothing else; promotions compose ON TOP of that answer. Modelling the
 * discount as a separate, later question is what keeps the Phase 25 invariant
 * intact — a promotion never reaches inside price resolution, never edits a
 * price version, and cannot make a price that is not derived from one.
 *
 * Like LINE_PRICING_PORT it is @Optional: a deployment without the loyalty
 * module, or a tenant with it disabled, gets exactly the Phase 28 behaviour —
 * the base price stands and the promotion columns stay null.
 */
export interface PromotedLinePrice {
  /** What the price version said, before any promotion. */
  basePriceMinor: number;
  /** Always in [0, basePriceMinor]. */
  discountMinor: number;
  /** Always basePriceMinor - discountMinor: what the shopper pays. */
  unitPriceMinor: number;
  currencyCode: string;
  promotionId: string;
  promotionVersionId: string;
}

export interface LinePromotionQuery {
  tenantId: string;
  productId: string;
  /** Store the session belongs to; location-scoped promotions win there. */
  locationId: string;
  /** Instant to evaluate at — the moment the line is written. */
  at: Date;
  /** The resolved price this promotion may reduce. Read-only input. */
  base: ResolvedLinePrice;
  /** The basket's loyalty account, when the shopper identified themselves. */
  loyaltyAccountId: string | null;
}

export interface LinePromotionPort {
  /**
   * Resolves a promotion inside the caller's transaction, so the discount
   * snapshotted onto a basket line is decided under the same locks that
   * created the line and read the price.
   *
   * Returns null when the tenant has not enabled loyalty, or when no
   * promotion applies — callers must treat that as "no discount", leaving the
   * base price exactly as pricing resolved it.
   */
  resolveForLine(
    client: Prisma.TransactionClient,
    query: LinePromotionQuery,
  ): Promise<PromotedLinePrice | null>;
}

export const LINE_PROMOTION_PORT = Symbol('LINE_PROMOTION_PORT');
