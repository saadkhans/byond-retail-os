import { StoreFlowAutonomyLevel } from '@prisma/client';

/**
 * Phase 26 — store flow constants.
 *
 * Everything a store-flow row can say about WHY something happened comes from
 * this file. Pipeline output and reviewer prose never reach a reason code.
 */

/** Controlled vocabulary for `StoreFlowProjection.reasonCode`. */
export const PROJECTION_REASON = {
  /** The observation is not a product movement (entry, exit, shelf touch). */
  NOT_A_PRODUCT_OBSERVATION: 'NOT_A_PRODUCT_OBSERVATION',
  /** Autonomy is SHADOW: the store observes and changes nothing. */
  SHADOW_MODE: 'SHADOW_MODE',
  /** The pipeline itself asked for a human (REVIEW_REQUIRED observation). */
  PIPELINE_FLAGGED_REVIEW: 'PIPELINE_FLAGGED_REVIEW',
  /** The observation carries no catalog product to act on. */
  UNKNOWN_PRODUCT: 'UNKNOWN_PRODUCT',
  /** Autonomy is PROPOSE: a vision event was created for a human to approve. */
  PROPOSED_FOR_REVIEW: 'PROPOSED_FOR_REVIEW',
  /** Autonomy is AUTO_APPLY and every gate passed. */
  AUTO_APPLIED: 'AUTO_APPLIED',
  /** Below the policy's confidence threshold. */
  BELOW_CONFIDENCE_THRESHOLD: 'BELOW_CONFIDENCE_THRESHOLD',
  /** The observation carries no score at all, so it cannot clear a threshold. */
  NO_CONFIDENCE_RECORDED: 'NO_CONFIDENCE_RECORDED',
  /** Inventory validation said this movement is not plausible at this store. */
  INVENTORY_IMPLAUSIBLE: 'INVENTORY_IMPLAUSIBLE',
  /** A human rejected the observation through the unified queue. */
  REJECTED_BY_REVIEWER: 'REJECTED_BY_REVIEWER',
  /** A human approved the observation through the unified queue. */
  APPROVED_BY_REVIEWER: 'APPROVED_BY_REVIEWER',
  /** A human replaced the product or quantity through the unified queue. */
  CORRECTED_BY_REVIEWER: 'CORRECTED_BY_REVIEWER',
} as const;

export type ProjectionReason =
  (typeof PROJECTION_REASON)[keyof typeof PROJECTION_REASON];

/** Controlled vocabulary for why a settlement attempt did not produce money. */
export const SETTLEMENT_BLOCK_REASON = {
  AWAITING_EVENT_REVIEW: 'AWAITING_EVENT_REVIEW',
  EMPTY_BASKET: 'EMPTY_BASKET',
  NO_ORDER_TOTAL: 'NO_ORDER_TOTAL',
  SETTLEMENT_DISABLED: 'SETTLEMENT_DISABLED',
  /**
   * Phase 27. The order already carries a payment intent that ended in a
   * TERMINAL non-captured state (CANCELLED / FAILED / VOIDED / EXPIRED).
   * Nothing about a terminal intent may change again, so re-authorising it is
   * illegal — and quietly minting a SECOND intent would take money for an
   * attempt a human deliberately cancelled. The exit therefore stops with the
   * order created and unpaid, and says why, instead of throwing.
   */
  PAYMENT_TERMINAL: 'PAYMENT_TERMINAL',
} as const;

export type SettlementBlockReason =
  (typeof SETTLEMENT_BLOCK_REASON)[keyof typeof SETTLEMENT_BLOCK_REASON];

/**
 * The policy a tenant gets before anyone configures one. SHADOW means the
 * store observes and changes nothing, which is exactly what every phase
 * before 26 did — so this release is inert until an operator opts in.
 */
export const DEFAULT_STORE_FLOW_POLICY = {
  autonomyLevel: StoreFlowAutonomyLevel.SHADOW,
  autoApplyMinConfidence: 0.7,
  requireInventoryValidation: true,
  settleOnExit: false,
} as const;

/**
 * Entry credentials are short-TTL by requirement (SECURITY.md). Thirty
 * seconds is long enough to walk a token from a screen to a scanner and short
 * enough that a leaked one is worthless; fifteen minutes is the ceiling an
 * operator may request.
 */
export const ENTRY_TOKEN_DEFAULT_TTL_SECONDS = 120;
export const ENTRY_TOKEN_MIN_TTL_SECONDS = 30;
export const ENTRY_TOKEN_MAX_TTL_SECONDS = 900;

/** Bytes of entropy in an entry secret before base64url encoding. */
export const ENTRY_TOKEN_SECRET_BYTES = 32;

/** Page bound for the unified review queue, mirroring the journey queue. */
export const STORE_FLOW_QUEUE_MAX_ITEMS = 100;

/**
 * Idempotency key prefixes. Every downstream call the bridge makes is keyed
 * off a stable identifier (the token, the journey, the observation), so a
 * replayed request re-reads the original row instead of creating a second
 * session, order, vision event or payment.
 *
 * The shapes are deliberately free of the characters the checkout and vision
 * idempotency screens reject, and they avoid the reserved namespace the
 * inference conversion path owns.
 */
export const IDEMPOTENCY = {
  entrySession: (tokenId: string) => `store-flow-entry-${tokenId}`,
  exitOrder: (journeyId: string) => `store-flow-exit-${journeyId}`,
  visionEvent: (journeyEventId: string) => `store-flow-obs-${journeyEventId}`,
  paymentIntent: (orderId: string) => `store-flow-pay-${orderId}`,
  paymentAuthorize: (orderId: string) => `store-flow-auth-${orderId}`,
  paymentCapture: (orderId: string) => `store-flow-cap-${orderId}`,
} as const;
