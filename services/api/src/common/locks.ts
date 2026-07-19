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

/**
 * Serializes a location's (store's) UPDATE and DELETE against each other
 * within a tenant — same audit-snapshot rationale as brands above. Both
 * `LocationsRepository.update()` and `.delete()` MUST derive it identically.
 */
export function locationAdvisoryLockKey(
  tenantId: string,
  locationId: string,
): string {
  return `location:${tenantId}:${locationId}`;
}

/**
 * Serializes a retail unit's UPDATE and DELETE against each other AND
 * against device creation under that unit: delete() counts the unit's
 * devices before removing it, so a concurrent device create must not land
 * between the count and the delete. All three call sites
 * (`UnitsRepository.update()`, `.delete()`, `DevicesRepository.create()`)
 * MUST derive it identically.
 */
export function unitAdvisoryLockKey(
  tenantId: string,
  unitId: string,
): string {
  return `retail-unit:${tenantId}:${unitId}`;
}

/**
 * Serializes a device's mutations (update, delete, heartbeat, registration
 * token issuance/redemption) against each other within a tenant. Heartbeats
 * and registration decide status transitions from a read-then-write, so they
 * must not interleave with update/delete. All DevicesRepository mutation
 * methods MUST derive it identically.
 */
export function deviceAdvisoryLockKey(
  tenantId: string,
  deviceId: string,
): string {
  return `device:${tenantId}:${deviceId}`;
}

/**
 * Serializes a checkout session's mutations (status transitions, basket line
 * add/update/remove, completion) against each other within a tenant. Line
 * mutations and completion decide from a read-then-write of the session's
 * status, so two concurrent requests (e.g. duplicate completion attempts, or
 * a line add racing a cancel) must not interleave. All CheckoutSessions
 * repository mutation methods MUST derive it identically.
 */
export function checkoutSessionAdvisoryLockKey(
  tenantId: string,
  sessionId: string,
): string {
  return `checkout-session:${tenantId}:${sessionId}`;
}

/**
 * Serializes order-number generation per tenant: completion computes the
 * next ORD-… sequence from a count inside its transaction, so two
 * simultaneous completions must not observe the same count. Any code path
 * that assigns an orderNumber MUST take this lock first.
 */
export function tenantOrderNumberAdvisoryLockKey(tenantId: string): string {
  return `order-number:${tenantId}`;
}

/**
 * Serializes a payment intent's mutations (authorize, capture, cancel/void,
 * fail) against each other within a tenant. Each transition decides from a
 * read-then-write of the intent's status, so two concurrent requests (e.g. a
 * duplicate capture racing a cancel) must not interleave and double-capture or
 * revive a terminal intent. All PaymentsRepository intent-mutation methods
 * MUST derive it identically.
 */
export function paymentIntentAdvisoryLockKey(
  tenantId: string,
  intentId: string,
): string {
  return `payment-intent:${tenantId}:${intentId}`;
}

/**
 * Serializes payment mutations that project onto the SAME order, across
 * DIFFERENT intents. The per-intent lock cannot cover this: two intents for
 * one order, capturing concurrently, hold different intent locks and would
 * both resolve the order while it is still UNPAID and each write a capture.
 * Every payment path that authorizes/captures against a resolved order takes
 * this lock (after the intent lock) before the paid-order check, so only one
 * capture can pay a given order. Lock order is always intent → order, so no
 * path can deadlock. MUST be derived identically by every call site.
 */
export function orderPaymentAdvisoryLockKey(
  tenantId: string,
  orderId: string,
): string {
  return `order-payment:${tenantId}:${orderId}`;
}

/**
 * Serializes provider-event ingestion per (tenant, provider, providerEventId):
 * the ingest path decides from a read-then-write ("have I seen this event?"),
 * so two concurrent deliveries of the SAME provider event must not both insert
 * before either sees the other. Any code path that ingests a provider event
 * MUST take this lock first.
 */
export function paymentEventAdvisoryLockKey(
  tenantId: string,
  provider: string,
  providerEventId: string,
): string {
  return `payment-event:${tenantId}:${provider}:${providerEventId}`;
}
