import { Injectable } from '@nestjs/common';
import { PaymentProvider } from '@prisma/client';
import {
  RefundGateway,
  RefundGatewayRequest,
  RefundGatewayResult,
} from './refund-gateway.port';

/**
 * The built-in SIMULATED refund adapter — the only implementation of the
 * refund-gateway port in this release.
 *
 * It moves no real money. It is deterministic and total: the same request
 * always produces the same answer, which is what lets the settlement path be
 * replayed safely and what lets every test drive the whole refund flow without
 * a network. A real gateway arrives as a second class behind the same
 * interface; nothing outside this file changes when it does.
 *
 * It refuses providers it does not model instead of inventing a success: an
 * intent created against a future provider must not silently look refunded
 * because the simulator said yes.
 */
@Injectable()
export class SimulatedRefundGateway implements RefundGateway {
  readonly name = 'simulated';

  /** The providers this simulator is allowed to answer for. */
  private static readonly SUPPORTED: readonly string[] = [
    PaymentProvider.SIMULATED,
    PaymentProvider.MANUAL,
  ];

  execute(request: RefundGatewayRequest): Promise<RefundGatewayResult> {
    if (!SimulatedRefundGateway.SUPPORTED.includes(request.provider)) {
      return Promise.resolve({
        status: 'FAILED',
        failureReason:
          'No refund adapter is configured for this payment provider',
      });
    }
    // Deterministic, opaque, and derived only from our OWN identifier — it
    // carries no instrument, customer or amount information.
    return Promise.resolve({
      status: 'SUCCEEDED',
      providerRefundRef: `sim-refund-${request.refundId}`,
    });
  }
}
