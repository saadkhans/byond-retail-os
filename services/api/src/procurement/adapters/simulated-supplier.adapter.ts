import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  SupplierIntegrationPort,
  SupplierOrderRequest,
  SupplierSubmissionResult,
} from '../supplier-integration.port';

/**
 * The default supplier adapter: it acknowledges every well-formed order
 * without talking to anything.
 *
 * It exists so the purchase-order lifecycle is complete and testable with no
 * network, no credentials and no vendor account — the same reason the
 * inference and ESL domains ship simulated adapters. A real integration is a
 * new class behind `SupplierIntegrationPort` and a configuration value.
 *
 * The acknowledgement reference is a hash of our own order reference, so it is
 * deterministic (a replayed submission produces the same token, which makes it
 * safe to compare in tests) and carries nothing a supplier said in confidence.
 */
@Injectable()
export class SimulatedSupplierAdapter implements SupplierIntegrationPort {
  readonly providerCode = 'SIMULATED';

  submitOrder(
    request: SupplierOrderRequest,
  ): Promise<SupplierSubmissionResult> {
    // Validate the request the way a real supplier would: an order with no
    // lines, or a line with no quantity, is rejected rather than silently
    // acknowledged. Rejections are values, never exceptions.
    if (request.lines.length === 0) {
      return Promise.resolve({ status: 'REJECTED', failure: 'INVALID_ORDER' });
    }
    if (request.lines.some((line) => line.quantity <= 0)) {
      return Promise.resolve({ status: 'REJECTED', failure: 'INVALID_ORDER' });
    }
    const externalReference = `SIM-${createHash('sha256')
      .update(request.reference)
      .digest('hex')
      .slice(0, 16)
      .toUpperCase()}`;
    return Promise.resolve({
      status: 'ACCEPTED',
      externalReference,
      acknowledgedAt: new Date(),
    });
  }
}
