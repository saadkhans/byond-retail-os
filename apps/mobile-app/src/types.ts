/**
 * The shopper view, exactly as `services/api/src/shopper/shopper.logic.ts`
 * returns it.
 *
 * These types are hand-mirrored rather than imported. `packages/shared` is an
 * empty placeholder on this branch, and inventing a cross-package dependency
 * for four interfaces would cost more than it saves — but the mirror is a
 * real obligation: if the API's view changes, this file changes with it.
 * Nothing wider than this ever crosses to the shopper.
 */

export type AutonomyLevel = 'SHADOW' | 'PROPOSE' | 'AUTO_APPLY';

export type JourneyStatus = 'OPEN' | 'EXITED' | 'RECONCILED' | 'REVIEW_REQUIRED';

export type SettlementStatus =
  | 'NOT_STARTED'
  | 'BLOCKED_ON_REVIEW'
  | 'ORDER_CREATED'
  | 'PAID'
  | 'FAILED';

export type OrderPaymentStatus =
  | 'UNPAID'
  | 'AUTHORIZED'
  | 'PAID'
  | 'PAYMENT_FAILED'
  | 'VOIDED'
  | 'REFUND_PENDING'
  | 'REFUNDED';

export interface BasketLine {
  id: string;
  sku: string;
  productName: string;
  quantity: number;
  unitPriceMinor: number | null;
  lineTotalMinor: number | null;
  currencyCode: string | null;
}

export interface Basket {
  lines: BasketLine[];
  totalMinor: number;
  currencyCode: string | null;
  hasUnpricedLine: boolean;
}

export interface Detection {
  autonomyLevel: AutonomyLevel;
  /** False under SHADOW: the store is watching, the basket stays empty. */
  active: boolean;
  settlesOnExit: boolean;
}

export interface Settlement {
  status: SettlementStatus;
  /** Phase 26's controlled vocabulary. Never shown raw to a shopper. */
  blockedBy: string | null;
  orderNumber: string | null;
  paidMinor: number | null;
  currencyCode: string | null;
  paymentStatus: OrderPaymentStatus | null;
}

export interface ShopperView {
  journeyId: string;
  journeyStatus: JourneyStatus;
  detection: Detection;
  basket: Basket;
  settlement: Settlement;
}
