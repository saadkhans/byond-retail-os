/**
 * Pure procurement logic. No Prisma, no Nest — the repository loads rows and
 * this decides what they mean, so the two rules that matter most (how much of
 * an order has actually arrived, and what that makes its status) are
 * unit-testable in isolation.
 *
 * The shape of this file encodes the phase's central decision: received
 * quantity is a PROJECTION over goods-receipt lines, never a counter stored on
 * the order line. Every function here takes receipt rows and derives; none of
 * them increments anything.
 */

import { GoodsReceiptDiscrepancy, PurchaseOrderStatus } from '@prisma/client';

/** Normalizes a supplier code the way SKUs and price book codes are. */
export function normalizeSupplierCode(raw: string): string {
  return raw.trim().toUpperCase();
}

/** Supplier SKUs are the supplier's own strings — trimmed, case preserved. */
export function normalizeSupplierSku(raw: string): string {
  return raw.trim();
}

/** ISO-4217 alphabetic codes only — three uppercase letters. */
export function normalizeCurrencyCode(raw: string): string {
  return raw.trim().toUpperCase();
}

export function isCurrencyCode(value: string): boolean {
  return /^[A-Z]{3}$/.test(value);
}

/**
 * Units of our product admitted to the ledger by receiving `packs` packs.
 * Integer-exact: pack sizes and quantities are whole numbers, so there is no
 * floating point anywhere between a delivery note and a stock level.
 */
export function unitsForPacks(packs: number, packSize: number): number {
  return packs * packSize;
}

/** One order line, reduced to what the projection needs. */
export interface OrderLineQuantities {
  id: string;
  quantityOrdered: number;
  packSize: number;
  unitCostMinor: number;
}

/** One receipt line, reduced to what the projection needs. */
export interface ReceiptLineQuantities {
  purchaseOrderLineId: string;
  quantityReceived: number;
}

/**
 * Packs received per order line, summed across every receipt posted against
 * the order. Lines with no receipts appear with zero rather than being absent,
 * so callers never have to distinguish "not received" from "unknown".
 */
export function receivedPacksByLine(
  lines: readonly OrderLineQuantities[],
  receiptLines: readonly ReceiptLineQuantities[],
): Map<string, number> {
  const received = new Map<string, number>();
  for (const line of lines) {
    received.set(line.id, 0);
  }
  for (const receiptLine of receiptLines) {
    const current = received.get(receiptLine.purchaseOrderLineId);
    if (current === undefined) {
      // A receipt line for a line that is not on this order. The repository
      // never loads such a row; ignoring it keeps the projection total a
      // function of THIS order's lines only.
      continue;
    }
    received.set(
      receiptLine.purchaseOrderLineId,
      current + receiptLine.quantityReceived,
    );
  }
  return received;
}

/**
 * The status an order should be in, given what has arrived.
 *
 * Terminal states are respected: a CANCELLED order stays cancelled and a DRAFT
 * order is not yet receivable, so neither is recomputed. Everything else is a
 * pure function of the receipts, which means replaying them always lands on
 * the same status.
 *
 * Over-delivery counts as fulfilled: a line that received more packs than were
 * ordered is not "still partially received". The excess is recorded on the
 * receipt line as an OVER_DELIVERY discrepancy, where an operator can see it.
 */
export function derivePurchaseOrderStatus(
  currentStatus: PurchaseOrderStatus,
  lines: readonly OrderLineQuantities[],
  receivedPacks: ReadonlyMap<string, number>,
): PurchaseOrderStatus {
  if (
    currentStatus === PurchaseOrderStatus.CANCELLED ||
    currentStatus === PurchaseOrderStatus.DRAFT
  ) {
    return currentStatus;
  }
  if (lines.length === 0) {
    return currentStatus;
  }
  let anyReceived = false;
  let allFulfilled = true;
  for (const line of lines) {
    const packs = receivedPacks.get(line.id) ?? 0;
    if (packs > 0) {
      anyReceived = true;
    }
    if (packs < line.quantityOrdered) {
      allFulfilled = false;
    }
  }
  if (allFulfilled) {
    return PurchaseOrderStatus.RECEIVED;
  }
  return anyReceived
    ? PurchaseOrderStatus.PARTIALLY_RECEIVED
    : PurchaseOrderStatus.SUBMITTED;
}

/**
 * Order total in minor units: packs times cost per pack, summed. Integer-exact
 * for the same reason basket totals are.
 */
export function orderTotalMinor(
  lines: readonly OrderLineQuantities[],
): number {
  return lines.reduce(
    (total, line) => total + line.quantityOrdered * line.unitCostMinor,
    0,
  );
}

/**
 * The discrepancy a receipt line implies, when the operator does not state one.
 *
 * This is a SUGGESTION the service applies only to lines the operator left as
 * NONE — an operator who says DAMAGED is never overruled by arithmetic. It
 * compares the running total against what was ordered, so the last of three
 * partial deliveries is not reported as a short delivery when the order is
 * finally complete.
 */
export function suggestDiscrepancy(
  quantityOrdered: number,
  packsReceivedBefore: number,
  packsReceivedNow: number,
): GoodsReceiptDiscrepancy {
  const total = packsReceivedBefore + packsReceivedNow;
  if (total > quantityOrdered) {
    return GoodsReceiptDiscrepancy.OVER_DELIVERY;
  }
  if (total < quantityOrdered) {
    return GoodsReceiptDiscrepancy.SHORT_DELIVERY;
  }
  return GoodsReceiptDiscrepancy.NONE;
}

/**
 * A minted reference and the two numbers it was minted from. Both are stored:
 * the string is what a human reads on the paperwork, the year and sequence are
 * what the allocator orders by.
 */
export interface AllocatedReference {
  reference: string;
  /** The calendar year the sequence belongs to; it resets every January. */
  year: number;
  /** Position within that year, 1-based. Strictly increasing, never padded. */
  sequence: number;
}

/**
 * Formats one reference in the `PREFIX-YYYY-NNNN` shape.
 *
 * Four digits is a MINIMUM WIDTH, not a ceiling: `padStart` pads and never
 * truncates, so sequence 9999 formats as `PO-2026-9999`, 10000 as
 * `PO-2026-10000`, and the year's numbering simply carries on getting wider.
 * Nothing downstream may compare two of these strings to decide which came
 * first — `'PO-2026-9999' > 'PO-2026-10000'` lexicographically, which is
 * exactly the trap this module fell into. Order by `sequence`.
 */
export function formatReference(
  prefix: string,
  year: number,
  sequence: number,
): string {
  return `${prefix}-${String(year).padStart(4, '0')}-${String(sequence).padStart(4, '0')}`;
}

/**
 * The sequence a reference carries, or null when the string is not one of ours
 * — a legacy import, a hand-typed number, anything that does not match the
 * canonical shape for this prefix and year. Used by the migration's backfill
 * and by nothing on the hot path.
 */
export function referenceSequenceOf(
  prefix: string,
  year: number,
  reference: string,
): number | null {
  const match = new RegExp(
    `^${prefix}-${String(year).padStart(4, '0')}-(\\d+)$`,
  ).exec(reference);
  return match ? Number.parseInt(match[1], 10) : null;
}

/**
 * Next reference for a (tenant, prefix, year), given the highest sequence
 * already allocated in that year.
 *
 * Takes the NUMBER, not the previous string, on purpose. The caller reads the
 * maximum from an integer column with a total numeric order, so the successor
 * is correct at 10,000 and at 100,000 alike; deriving it by parsing "the
 * lexicographically largest reference" is what broke at the four-digit
 * boundary. `null` means the year is empty and numbering starts at 1.
 *
 * The successor strictly increases with the maximum it is given, which is what
 * makes the caller's conflict retry terminate: a losing racer re-reads a
 * maximum that now includes the winner's row and computes a different number.
 */
export function nextReference(
  prefix: string,
  year: number,
  latestSequence: number | null,
): AllocatedReference {
  const sequence = (latestSequence ?? 0) + 1;
  return { reference: formatReference(prefix, year, sequence), year, sequence };
}

/** Statuses from which an order may still be cancelled. */
export const CANCELLABLE_STATUSES: readonly PurchaseOrderStatus[] = [
  PurchaseOrderStatus.DRAFT,
  PurchaseOrderStatus.SUBMITTED,
  PurchaseOrderStatus.PARTIALLY_RECEIVED,
];

/** Statuses from which goods may be received. */
export const RECEIVABLE_STATUSES: readonly PurchaseOrderStatus[] = [
  PurchaseOrderStatus.SUBMITTED,
  PurchaseOrderStatus.PARTIALLY_RECEIVED,
];

/** Statuses whose lines may still be edited. */
export const EDITABLE_STATUSES: readonly PurchaseOrderStatus[] = [
  PurchaseOrderStatus.DRAFT,
];
