/**
 * Advisory-lock keys used to serialize operations that a single database row
 * lock cannot cover on its own.
 *
 * Every call site invokes the lock as
 * `tx.$queryRaw\`SELECT pg_advisory_xact_lock(hashtext(<key>))::text\``.
 * The `::text` cast is load-bearing: `pg_advisory_xact_lock` returns the
 * Postgres `void` type, which Prisma's `$queryRaw` refuses to deserialize
 * ("Failed to deserialize column of type 'void'"), turning every locked
 * transaction into a 500. Casting to text keeps the statement a no-result
 * side effect while staying on `$queryRaw` (which the repository specs
 * assert on).
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
 * Serializes review decisions on a vision event within a tenant: a decision
 * is a read-then-write of the event's status (plus the basket effect it
 * applies), so two concurrent reviewers must not both observe
 * PENDING_REVIEW and each apply the basket mutation. The (tenantId, eventId)
 * unique on VisionEventReview backstops the race at the database level.
 * Lock ordering: vision-event → checkout-session → product; no other path
 * takes the vision-event lock, so no cycle with checkout/inventory paths
 * (which take at most session → product in the same order) is possible.
 */
export function visionEventAdvisoryLockKey(
  tenantId: string,
  eventId: string,
): string {
  return `vision-event:${tenantId}:${eventId}`;
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
 * Serializes a reconciliation record's status updates within a tenant. The
 * update decides from a read-then-write (terminal check + audit before/after),
 * so two concurrent PATCHes must not interleave and record an audit transition
 * from a stale prior state. ReconciliationRepository.updateStatus MUST derive
 * it identically.
 */
export function reconciliationAdvisoryLockKey(
  tenantId: string,
  recordId: string,
): string {
  return `reconciliation:${tenantId}:${recordId}`;
}

/**
 * Serializes a video asset's audited status transitions against the
 * screening preview's final serve authorization within a tenant. A
 * screening decision is a read-then-write CAS on the asset's status, and
 * the preview serves quarantined frame BYTES that must never be
 * audited/served for an asset whose terminal decision already committed —
 * on POSIX, an extraction racing a rejection's media removal can even keep
 * reading an unlinked-while-open file. Both
 * `VideoAssetsRepository.transitionStatus()` (every decision CAS) and
 * `VideoAssetsRepository.authorizeScreeningPreviewServe()` (the re-read +
 * READ audit that gates the preview response) take
 * `pg_advisory_xact_lock(hashtext(key))` first, so a preview
 * authorization and a decision serialize: whichever commits second
 * observes the other. Both call sites MUST derive the key identically.
 */
export function videoAssetAdvisoryLockKey(
  tenantId: string,
  assetId: string,
): string {
  return `video-asset:${tenantId}:${assetId}`;
}

/**
 * Serializes a customer journey's event appends against its EXIT
 * reconciliation within a tenant. Both paths decide from a read-then-write
 * of the journey's OPEN status: without the lock, an append that passed the
 * open check can commit AFTER exit folded the basket and marked the journey
 * RECONCILED, leaving a "clean" closed journey with an unaccounted event.
 * Every JourneyService mutation (appendEvent, appendFromFusionRun via
 * appendEvent, exit) MUST take this lock inside its transaction before the
 * open-state check.
 */
export function journeyAdvisoryLockKey(
  tenantId: string,
  journeyId: string,
): string {
  return `journey:${tenantId}:${journeyId}`;
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

/**
 * Serializes Phase 16 test-protocol evidence mutations — scenario
 * insertion, result recording, and the COMPLETED transition's evidence
 * check — for the SAME protocol. Without it, a scenario inserted between
 * completion's evidence query and its terminal status write would leave
 * a COMPLETED protocol with a pending scenario (Codex P1).
 */
export function cvTestProtocolAdvisoryLockKey(
  tenantId: string,
  protocolId: string,
): string {
  return `cv-test-protocol:${tenantId}:${protocolId}`;
}

/**
 * Serializes Phase 17 calibration-profile activation per CAMERA SOURCE:
 * activation is a read-then-write over the WHOLE source (archive the
 * current ACTIVE profile, verify this profile's required zones, promote
 * it), so two concurrent activations of different profiles on the same
 * source must not interleave and leave two ACTIVE rows. The partial
 * unique index (one ACTIVE per source) backstops the race at the
 * database level. Keyed by source, not profile — profile-keyed locks
 * would not exclude each other.
 */
export function cameraCalibrationAdvisoryLockKey(
  tenantId: string,
  cameraSourceId: string,
): string {
  return `camera-calibration:${tenantId}:${cameraSourceId}`;
}

/**
 * Serializes the one-SKU bootstrap's per-clip FUSION_SHADOW import: the
 * first correction for a clip decides from a read-then-write ("has this
 * clip's latest fusion run been imported as a shadow journey event?")
 * before opening a journey and appending the event. Each bootstrap
 * import opens its OWN journey, so the journey-scoped dedup inside
 * appendEvent cannot see a concurrent import — without this lock two
 * operators' first reviews would both import, and Phase 18 would
 * collect the same footage twice under different source events.
 * OneSkuBootstrapService.reviewClip MUST hold this lock across its
 * check-then-import critical section.
 */
export function oneSkuBootstrapImportAdvisoryLockKey(
  tenantId: string,
  videoAssetId: string,
): string {
  return `one-sku-bootstrap-import:${tenantId}:${videoAssetId}`;
}

/**
 * Serializes Phase 19 planogram publication per (tenant, store, rack
 * code): publishing is a read-then-write (deactivate the current ACTIVE
 * version, create version+1), so two concurrent publishes of the same
 * rack must not both read the same predecessor and mint duplicate ACTIVE
 * versions. PlanogramService.publishRack MUST take this lock inside its
 * transaction before the active-version read.
 */
export function planogramRackAdvisoryLockKey(
  tenantId: string,
  locationId: string,
  rackCode: string,
): string {
  return `planogram-rack:${tenantId}:${locationId}:${rackCode}`;
}

/**
 * Serializes Phase 18 dataset-improvement-run mutations — candidate
 * refresh (delete+rebuild), split planning, status transitions, and the
 * export stamp — for the SAME run. Without it, a refresh racing a
 * plan-splits call could interleave the rebuild with split assignment
 * and leave candidates half-planned, or an export could stamp EXPORTED
 * over a candidate set that was being rebuilt.
 */
export function cvDatasetRunAdvisoryLockKey(
  tenantId: string,
  runId: string,
): string {
  return `cv-dataset-run:${tenantId}:${runId}`;
}
