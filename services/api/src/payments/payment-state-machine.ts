import { PaymentStatus } from '@prisma/client';

/**
 * The payment intent lifecycle state machine.
 *
 * CREATED and REQUIRES_AUTHORIZATION are pre-auth; AUTHORIZED holds funds
 * (simulated); CAPTURE_PENDING/CAPTURED move money (simulated). CAPTURED is
 * the ONLY success terminal state, and it is the ONLY state that may flip a
 * linked order to PAID. FAILED, CANCELLED, VOIDED, and EXPIRED are the
 * terminal non-success states — nothing about a terminal intent may change
 * again (an empty transition list == terminal).
 *
 * Reconciliation is tracked separately on PaymentReconciliationRecord and does
 * NOT appear in this financial lifecycle.
 */
export const PAYMENT_STATUS_TRANSITIONS: Readonly<
  Record<PaymentStatus, readonly PaymentStatus[]>
> = {
  [PaymentStatus.CREATED]: [
    PaymentStatus.REQUIRES_AUTHORIZATION,
    PaymentStatus.AUTHORIZED,
    PaymentStatus.CANCELLED,
    PaymentStatus.FAILED,
    PaymentStatus.EXPIRED,
  ],
  [PaymentStatus.REQUIRES_AUTHORIZATION]: [
    PaymentStatus.AUTHORIZED,
    PaymentStatus.CANCELLED,
    PaymentStatus.FAILED,
    PaymentStatus.EXPIRED,
  ],
  [PaymentStatus.AUTHORIZED]: [
    PaymentStatus.CAPTURE_PENDING,
    PaymentStatus.CAPTURED,
    PaymentStatus.VOIDED,
    PaymentStatus.FAILED,
    PaymentStatus.EXPIRED,
  ],
  [PaymentStatus.CAPTURE_PENDING]: [
    PaymentStatus.CAPTURED,
    PaymentStatus.FAILED,
  ],
  [PaymentStatus.CAPTURED]: [],
  [PaymentStatus.FAILED]: [],
  [PaymentStatus.CANCELLED]: [],
  [PaymentStatus.VOIDED]: [],
  [PaymentStatus.EXPIRED]: [],
};

/** Statuses from which the simulated authorize action is legal. */
export const AUTHORIZABLE_STATUSES: readonly PaymentStatus[] = [
  PaymentStatus.CREATED,
  PaymentStatus.REQUIRES_AUTHORIZATION,
];

/** Statuses from which the simulated capture action is legal. */
export const CAPTURABLE_STATUSES: readonly PaymentStatus[] = [
  PaymentStatus.AUTHORIZED,
  PaymentStatus.CAPTURE_PENDING,
];

/** A terminal intent (COMPLETED financial lifecycle) can never change again. */
export function isTerminalPaymentStatus(status: PaymentStatus): boolean {
  return PAYMENT_STATUS_TRANSITIONS[status].length === 0;
}

/** Whether `target` is a legal next state from `current`. */
export function canTransition(
  current: PaymentStatus,
  target: PaymentStatus,
): boolean {
  return PAYMENT_STATUS_TRANSITIONS[current].includes(target);
}
