import { Module } from '@nestjs/common';
import { CheckoutModule } from '../checkout/checkout.module';
import { JourneyModule } from '../journey/journey.module';
import { PaymentsModule } from '../payments/payments.module';
import { PlatformModulesModule } from '../platform-modules/platform-modules.module';
import { VisionModule } from '../vision/vision.module';
import { StoreFlowController } from './store-flow.controller';
import { StoreFlowRepository } from './store-flow.repository';
import { StoreFlowService } from './store-flow.service';

/**
 * Phase 26 — the store flow.
 *
 * This module is deliberately the ONLY place where the observation stream and
 * the commerce stack meet. It imports the public services of both sides and
 * owns no basket, order, ledger or payment logic of its own:
 *
 *   JourneyModule  — reads and appends the append-only observation stream.
 *   CheckoutModule — opens a session on entry, completes it on exit (which is
 *                    what writes the SALE movements and creates the order).
 *   VisionModule   — the single ingest and review contract that can change a
 *                    basket; auto-application goes through the SAME review
 *                    path a human uses.
 *   PaymentsModule — the provider-neutral intent state machine.
 *
 * The shadow-mode guard tests in journey/, pickup-fusion/, camera/ and the
 * rest are unchanged and still pass, because none of those directories gained
 * a commerce write. The bridge is here instead.
 */
@Module({
  imports: [
    PlatformModulesModule,
    JourneyModule,
    CheckoutModule,
    VisionModule,
    PaymentsModule,
  ],
  controllers: [StoreFlowController],
  providers: [StoreFlowService, StoreFlowRepository],
  exports: [StoreFlowService],
})
export class StoreFlowModule {}
