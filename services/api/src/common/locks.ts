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

/**
 * Serializes a brand's UPDATE and DELETE against each other within a tenant.
 * Both `BrandsRepository.update()` and `.delete()` take
 * `pg_advisory_xact_lock(hashtext(key))` before reading the row, so a
 * concurrent PATCH can no longer commit between DELETE's snapshot read and the
 * row removal — the DELETE audit `before` snapshot always matches the row
 * actually deleted. Both call sites MUST derive the key identically.
 */
export function brandAdvisoryLockKey(
  tenantId: string,
  brandId: string,
): string {
  return `brand:${tenantId}:${brandId}`;
}

/**
 * Serializes a category's UPDATE and DELETE against each other within a
 * tenant, for the same reason as brands above. This is distinct from the
 * per-tenant `category-tree:` lock (which serializes reparent MOVES to prevent
 * cycles): this one is per-category and guards the update/delete audit race.
 * Both `CategoriesRepository.update()` and `.delete()` MUST derive it
 * identically.
 */
export function categoryAdvisoryLockKey(
  tenantId: string,
  categoryId: string,
): string {
  return `category:${tenantId}:${categoryId}`;
}
