/**
 * Phase 27 — the reverse flow's controlled vocabulary.
 *
 * Every string the reverse flow uses to explain ITSELF lives here. Operator
 * prose never becomes a reference type, a reason code, or an idempotency key:
 * those are server-derived, which is what keeps the ledger and the audit log
 * machine-readable (and keeps operator free text confined to the screened
 * `reason`/`note` fields).
 */

/**
 * `InventoryMovement.referenceType` values this module stamps. The pair
 * (referenceType, referenceId) is how a ledger row explains its own cause, so
 * an auditor can walk from any stock change straight back to the decision
 * record that caused it.
 */
export const MOVEMENT_REFERENCE_TYPE = {
  /** A customer return or a cancellation reversal — referenceId = OrderReturn. */
  ORDER_RETURN: 'OrderReturn',
  /** A cycle-count variance — referenceId = CycleCount. */
  CYCLE_COUNT: 'CycleCount',
  /**
   * A CV-detected write-off — referenceId = VisionEvent. The observation, not
   * the ShrinkEvent row, is the cause: it is what the movement is evidence of,
   * and it already exists when the movement is appended.
   */
  SHRINK: 'VisionEvent',
} as const;

/** Bound on how many lines one return may carry, mirroring the queue bounds. */
export const MAX_RETURN_LINES = 200;

/** Bound on how many products one cycle count may carry. */
export const MAX_CYCLE_COUNT_LINES = 500;

/**
 * Idempotency keys this module derives for the payment calls it makes. Keyed
 * off the OrderReturn id, which is itself guarded by the caller's tenant-scoped
 * `reference` — so a replayed return request reaches the SAME refund key and
 * the shopper is never paid twice.
 */
export const IDEMPOTENCY = {
  returnRefund: (orderReturnId: string) => `return-refund-${orderReturnId}`,
} as const;
