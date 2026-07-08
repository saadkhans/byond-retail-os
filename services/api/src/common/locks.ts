/**
 * Advisory-lock keys used to serialize operations that a single database row
 * lock cannot cover on its own.
 */

/**
 * Serializes product mutations that depend on ledger state — unit-of-measure
 * immutability and archive-with-on-hand-stock — against inventory adjustments
 * for the SAME product.
 *
 * Both `InventoryRepository.adjust()` and `ProductsRepository.update()` take
 * `pg_advisory_xact_lock(hashtext(key))` at the top of their transaction, so
 * the ledger-dependent checks always observe each other's committed writes
 * instead of racing under READ COMMITTED. The two call sites MUST derive the
 * key identically, or the lock does not exclude them — hence this single
 * helper.
 */
export function productStockAdvisoryLockKey(
  tenantId: string,
  productId: string,
): string {
  return `product-stock:${tenantId}:${productId}`;
}
