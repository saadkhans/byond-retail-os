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
  ],
})
export class PaymentsModule {}
