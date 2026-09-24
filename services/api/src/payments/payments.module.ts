import { Module } from '@nestjs/common';
import { PaymentEventsController } from './payment-events.controller';
import { PaymentEventsRepository } from './payment-events.repository';
import { PaymentEventsService } from './payment-events.service';
import { PaymentsController } from './payments.controller';
import { PaymentsRepository } from './payments.repository';
import { PaymentsService } from './payments.service';
import { ReconciliationController } from './reconciliation.controller';
import { ReconciliationRepository } from './reconciliation.repository';
import { ReconciliationService } from './reconciliation.service';
import { REFUND_GATEWAY } from './ports/refund-gateway.port';
import { SimulatedRefundGateway } from './ports/simulated-refund.gateway';

/**
 * Phase 6 — provider-neutral payment abstraction & reconciliation foundation.
 *
 * NO live gateway, NO provider SDK, NO raw card data. Payment authorization and
 * capture are SIMULATED through the internal state machine; the order
 * paymentStatus projection lives in PaymentsRepository (a captured intent is
 * the ONLY path that marks an order PAID). AuditLogService and PrismaService
 * come from their global/shared modules.
 */
@Module({
  controllers: [
    PaymentsController,
    PaymentEventsController,
    ReconciliationController,
  ],
  providers: [
    PaymentsService,
    PaymentsRepository,
    PaymentEventsService,
    PaymentEventsRepository,
    ReconciliationService,
    ReconciliationRepository,
    // Phase 27 — the refund-gateway port is bound to the SIMULATED adapter.
    // Swapping in a real gateway is a one-line change HERE and nowhere else;
    // PaymentsService only ever sees the interface.
    { provide: REFUND_GATEWAY, useClass: SimulatedRefundGateway },
  ],
  // Phase 26: store-flow settlement drives the SAME provider-neutral intent
  // state machine an operator drives by hand. No second payment path.
  exports: [PaymentsService],
})
export class PaymentsModule {}
