import { PaymentStatus } from '@prisma/client';
import {
  AUTHORIZABLE_STATUSES,
  CAPTURABLE_STATUSES,
  PAYMENT_STATUS_TRANSITIONS,
  canTransition,
  isTerminalPaymentStatus,
} from './payment-state-machine';

describe('payment state machine', () => {
  it('marks exactly the success/failure terminals as terminal', () => {
    const terminals = Object.values(PaymentStatus).filter(
      isTerminalPaymentStatus,
    );
    expect(new Set(terminals)).toEqual(
      new Set([
        PaymentStatus.CAPTURED,
        PaymentStatus.FAILED,
        PaymentStatus.CANCELLED,
        PaymentStatus.VOIDED,
        PaymentStatus.EXPIRED,
      ]),
    );
  });

  it('never lists a transition out of a terminal state', () => {
    for (const status of Object.values(PaymentStatus)) {
      if (isTerminalPaymentStatus(status)) {
        expect(PAYMENT_STATUS_TRANSITIONS[status]).toEqual([]);
      }
    }
  });

  it('allows authorize only from pre-auth states', () => {
    expect(AUTHORIZABLE_STATUSES).toEqual([
      PaymentStatus.CREATED,
      PaymentStatus.REQUIRES_AUTHORIZATION,
    ]);
    // CAPTURED can never be re-authorized.
    expect(canTransition(PaymentStatus.CAPTURED, PaymentStatus.AUTHORIZED)).toBe(
      false,
    );
  });

  it('allows capture only from authorized/capture-pending states', () => {
    expect(CAPTURABLE_STATUSES).toEqual([
      PaymentStatus.AUTHORIZED,
      PaymentStatus.CAPTURE_PENDING,
    ]);
    // A brand-new CREATED intent cannot jump straight to CAPTURED.
    expect(canTransition(PaymentStatus.CREATED, PaymentStatus.CAPTURED)).toBe(
      false,
    );
  });

  it('permits the happy path CREATED → AUTHORIZED → CAPTURED', () => {
    expect(
      canTransition(PaymentStatus.CREATED, PaymentStatus.AUTHORIZED),
    ).toBe(true);
    expect(
      canTransition(PaymentStatus.AUTHORIZED, PaymentStatus.CAPTURED),
    ).toBe(true);
  });

  it('permits void only from AUTHORIZED', () => {
    expect(canTransition(PaymentStatus.AUTHORIZED, PaymentStatus.VOIDED)).toBe(
      true,
    );
    expect(canTransition(PaymentStatus.CREATED, PaymentStatus.VOIDED)).toBe(
      false,
    );
  });
});
