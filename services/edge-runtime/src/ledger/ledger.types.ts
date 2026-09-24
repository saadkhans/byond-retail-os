/**
 * The edge inventory ledger mirrors the cloud's invariant: stock is never a
 * mutable number. Every movement is an append-only fact and every stock level
 * is a projection derived by replaying those facts.
 *
 * Movement types match the cloud's `InventoryMovementType` so an edge fact
 * needs no translation when it reaches the control plane.
 */
export type EdgeMovementType =
  | 'ADJUSTMENT'
  | 'SALE'
  | 'RECEIPT'
  | 'CORRECTION_IN'
  | 'CORRECTION_OUT';

export interface EdgeLedgerEntry {
  /** Stable id; also the idempotency key when the movement is synced. */
  readonly movementId: string;
  readonly type: EdgeMovementType;
  readonly productId: string;
  readonly unitId: string;
  /** Signed change in units. A SALE is negative; a RECEIPT is positive. */
  readonly quantityDelta: number;
  readonly occurredAt: string;
  /** Opaque lineage reference — a proposal id, never a media locator. */
  readonly reference?: string;
}

export interface StockLevel {
  readonly productId: string;
  readonly unitId: string;
  readonly quantity: number;
  /** Ledger sequence this level was projected through. */
  readonly throughSequence: number;
}

export function stockKey(productId: string, unitId: string): string {
  return `${productId}::${unitId}`;
}

/**
 * Replays ledger entries into stock levels. Pure, so the cached projection and
 * a full replay can be compared in a test — which is the only way to be sure
 * the cache never drifts from the facts.
 */
export function projectStock(
  entries: ReadonlyArray<{ sequence: number; entry: EdgeLedgerEntry }>,
  from: ReadonlyMap<string, StockLevel> = new Map(),
): Map<string, StockLevel> {
  const levels = new Map<string, StockLevel>(from);
  for (const { sequence, entry } of entries) {
    const key = stockKey(entry.productId, entry.unitId);
    const current = levels.get(key);
    levels.set(key, {
      productId: entry.productId,
      unitId: entry.unitId,
      quantity: (current?.quantity ?? 0) + entry.quantityDelta,
      throughSequence: sequence,
    });
  }
  return levels;
}
