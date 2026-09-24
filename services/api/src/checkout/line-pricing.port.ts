import { Prisma } from '@prisma/client';

/**
 * The single thing checkout needs from pricing: "what does this product cost
 * here, right now?".
 *
 * It is a PORT rather than a direct dependency so the basket keeps working
 * when pricing is absent — the repository treats a missing implementation and
 * an unresolved price identically, which is what makes Phase 25 backwards
 * compatible with every tenant that has no price books yet.
 */
export interface ResolvedLinePrice {
  unitPriceMinor: number;
  currencyCode: string;
  priceBookId: string;
  priceBookVersionId: string;
}

export interface LinePricingQuery {
  tenantId: string;
  productId: string;
  /** Store the session belongs to; location-scoped books win there. */
  locationId: string;
  /** Instant to price at — the moment the line is written. */
  at: Date;
}

export interface LinePricingPort {
  /**
   * Resolves a price inside the caller's transaction, so the price
   * snapshotted onto a basket line is read under the same locks that create
   * the line. Returns null when the tenant has not enabled pricing, or when
   * no price book covers this product — callers must treat that as
   * "unpriced", never as "free".
   */
  resolveForLine(
    client: Prisma.TransactionClient,
    query: LinePricingQuery,
  ): Promise<ResolvedLinePrice | null>;
}

export const LINE_PRICING_PORT = Symbol('LINE_PRICING_PORT');
