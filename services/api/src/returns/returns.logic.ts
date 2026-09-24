import { InventoryMovementType, UnitOfMeasure } from '@prisma/client';
import { PG_INT_MAX } from '../common/integer-bounds';
import { MAX_RETURN_LINES } from './returns.constants';

/**
 * Phase 27 — the arithmetic of the reverse flow, with no database and no
 * framework anywhere near it.
 *
 * Everything here is a pure function over snapshots, which is what lets the
 * hard parts (how much of an order may still come back, what a return is
 * worth, what a count disagrees with) be exhaustively tested without a
 * transaction. The repository owns locking, persistence and the ledger; this
 * file owns the numbers.
 */

/** The order-line facts a return decision needs. Snapshots, never live rows. */
export interface ReturnableOrderLine {
  readonly id: string;
  readonly productId: string;
  readonly sku: string;
  readonly productName: string;
  readonly unitOfMeasure: UnitOfMeasure;
  readonly quantity: number;
  readonly unitPriceMinor: number | null;
  readonly currencyCode: string | null;
}

/** What the caller asked to take back. */
export interface ReturnLineRequest {
  readonly orderLineId: string;
  readonly quantity: number;
  /** Did the goods go back on the shelf? Damaged stock does not. */
  readonly restock?: boolean;
  readonly note?: string;
}

export interface PlannedReturnLine {
  readonly orderLineId: string;
  readonly productId: string;
  readonly sku: string;
  readonly productName: string;
  readonly unitOfMeasure: UnitOfMeasure;
  readonly quantity: number;
  readonly restocked: boolean;
  readonly note: string | null;
  /** quantity x the line's snapshotted unit price, or null when unpriced. */
  readonly refundAmountMinor: number | null;
  readonly currencyCode: string | null;
}

export type ReturnPlanRejection =
  | 'no-lines'
  | 'too-many-lines'
  | 'duplicate-line'
  | 'line-not-on-order'
  | 'quantity-invalid'
  | 'quantity-exceeds-remaining'
  | 'nothing-left-to-return';

export interface ReturnPlan {
  readonly lines: readonly PlannedReturnLine[];
  /** Units that will go back on the shelf (restocked lines only). */
  readonly restockedQuantity: number;
  /**
   * What the return is worth, or null when it cannot be valued. Null is the
   * honest answer for an order completed before pricing existed, or one whose
   * basket could not be priced — a refund is never invented from a guess.
   */
  readonly refundAmountMinor: number | null;
  readonly currencyCode: string | null;
}

/**
 * Works out exactly what comes back, or why it cannot.
 *
 * `alreadyReturned` is the per-order-line total of every EARLIER return, so
 * the ceiling is "ordered minus already returned" — an order line can never be
 * returned more times than it was bought, however many separate returns are
 * recorded against it.
 *
 * `requested` of `null` means "everything that is left", which is what an
 * ORDER_CANCELLATION asks for.
 */
export function planReturn(
  orderLines: readonly ReturnableOrderLine[],
  alreadyReturned: ReadonlyMap<string, number>,
  requested: readonly ReturnLineRequest[] | null,
): ReturnPlan | ReturnPlanRejection {
  const byId = new Map(orderLines.map((line) => [line.id, line]));

  let effective: ReturnLineRequest[];
  if (requested === null) {
    effective = orderLines
      .map((line) => ({
        orderLineId: line.id,
        quantity: line.quantity - (alreadyReturned.get(line.id) ?? 0),
        restock: true,
      }))
      .filter((line) => line.quantity > 0);
    if (effective.length === 0) {
      // Every line has already come back. Reversing nothing is not a
      // cancellation; it is a no-op the caller has to see.
      return 'nothing-left-to-return';
    }
  } else {
    if (requested.length === 0) {
      return 'no-lines';
    }
    effective = [...requested];
  }
  if (effective.length > MAX_RETURN_LINES) {
    return 'too-many-lines';
  }

  const seen = new Set<string>();
  const planned: PlannedReturnLine[] = [];
  let restockedQuantity = 0;
  for (const request of effective) {
    if (seen.has(request.orderLineId)) {
      // Two entries for one line would each pass the remaining-quantity check
      // on their own while together exceeding it.
      return 'duplicate-line';
    }
    seen.add(request.orderLineId);
    const line = byId.get(request.orderLineId);
    if (!line) {
      return 'line-not-on-order';
    }
    if (!Number.isInteger(request.quantity) || request.quantity < 1) {
      return 'quantity-invalid';
    }
    const remaining = line.quantity - (alreadyReturned.get(line.id) ?? 0);
    if (request.quantity > remaining) {
      return 'quantity-exceeds-remaining';
    }
    const restocked = request.restock !== false;
    if (restocked) {
      restockedQuantity += request.quantity;
    }
    planned.push({
      orderLineId: line.id,
      productId: line.productId,
      sku: line.sku,
      productName: line.productName,
      unitOfMeasure: line.unitOfMeasure,
      quantity: request.quantity,
      restocked,
      note: request.note?.trim() || null,
      refundAmountMinor:
        line.unitPriceMinor === null
          ? null
          : line.unitPriceMinor * request.quantity,
      currencyCode: line.currencyCode,
    });
  }

  const value = valueReturn(planned);
  return {
    lines: planned,
    restockedQuantity,
    refundAmountMinor: value.refundAmountMinor,
    currencyCode: value.currencyCode,
  };
}

/**
 * Values a planned return, ALL OR NOTHING.
 *
 * A return is worth something only when EVERY line it carries is priced, in
 * ONE currency, and the total fits the column. A partially priced return would
 * otherwise quietly refund the priced half and silently drop the rest — the
 * same rule checkout uses when it refuses to total a basket with an unpriced
 * line. When it cannot be valued, BOTH the amount and the currency are null,
 * so no caller can read one without the other.
 */
export function valueReturn(lines: readonly PlannedReturnLine[]): {
  refundAmountMinor: number | null;
  currencyCode: string | null;
} {
  const unvaluable = { refundAmountMinor: null, currencyCode: null };
  if (lines.length === 0) {
    return unvaluable;
  }
  const currencies = new Set<string>();
  let total = 0;
  for (const line of lines) {
    if (line.refundAmountMinor === null || line.currencyCode === null) {
      return unvaluable;
    }
    currencies.add(line.currencyCode);
    total += line.refundAmountMinor;
  }
  if (currencies.size !== 1 || total > PG_INT_MAX || total < 0) {
    // Mixed currencies cannot be summed, and an amount that cannot be stored
    // is not an amount — refuse to value it rather than persist a wrong one.
    return unvaluable;
  }
  return { refundAmountMinor: total, currencyCode: [...currencies][0] };
}

// ---------------------------------------------------------------------------
// Cycle counts
// ---------------------------------------------------------------------------

export interface CountComparison {
  /** counted - projection. What becomes a correction movement. */
  readonly varianceQuantity: number;
  /**
   * projection - ledger replay. MUST be zero. Anything else means the stock
   * projection and its own append-only history disagree, which is a platform
   * bug rather than a stock discrepancy, and is reported rather than absorbed
   * into the variance.
   */
  readonly ledgerDriftQuantity: number;
  /**
   * The movement type the variance becomes, or null when there is nothing to
   * correct. A count with no variance writes NO movement — a count that
   * agrees with the books must leave the ledger exactly as it found it.
   */
  readonly movementType: InventoryMovementType | null;
}

/**
 * Compares one counted product against the projection and the ledger.
 *
 * This is the heart of "reconciliation must not become a second source of
 * truth": the function never produces a quantity to SET. It produces a signed
 * DELTA and the movement type that expresses it, which is the only shape the
 * ledger accepts.
 */
export function compareCount(input: {
  countedQuantity: number;
  systemQuantity: number;
  ledgerQuantity: number;
}): CountComparison {
  const varianceQuantity = input.countedQuantity - input.systemQuantity;
  return {
    varianceQuantity,
    ledgerDriftQuantity: input.systemQuantity - input.ledgerQuantity,
    movementType:
      varianceQuantity === 0
        ? null
        : varianceQuantity > 0
          ? InventoryMovementType.CORRECTION_IN
          : InventoryMovementType.CORRECTION_OUT,
  };
}
