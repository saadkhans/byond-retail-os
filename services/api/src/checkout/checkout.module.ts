import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { LoyaltyModule } from '../loyalty/loyalty.module';
import { PricingModule } from '../pricing/pricing.module';
import { CheckoutSessionsController } from './checkout-sessions.controller';
import { CheckoutSessionsRepository } from './checkout-sessions.repository';
import { CheckoutSessionsService } from './checkout-sessions.service';

@Module({
  // InventoryModule provides InventoryRepository.applyMovement, which
  // completion uses to consume stock inside its own transaction — the SALE
  // path reuses the exact conditional-decrement ledger code as manual
  // adjustments rather than reimplementing it.
  // PricingModule provides LINE_PRICING_PORT, the optional resolver that
  // snapshots a price onto each basket line. The dependency is one-way and
  // optional: without it (or with the pricing module disabled for the
  // tenant) lines stay unpriced and orders keep null totals.
  // LoyaltyModule provides LINE_PROMOTION_PORT, the SECOND optional resolver.
  // Two ports rather than one is the point: pricing answers "what does this
  // cost" and promotions compose on top of that answer, so a discount can
  // never reach inside price resolution or write a price version.
  imports: [InventoryModule, PricingModule, LoyaltyModule],
  controllers: [CheckoutSessionsController],
  providers: [CheckoutSessionsService, CheckoutSessionsRepository],
  // Phase 26: the store-flow bridge opens a session on shopper entry and
  // completes it on exit through the SAME service the manual route uses —
  // never a parallel implementation of basket or order rules.
  exports: [CheckoutSessionsService],
})
export class CheckoutModule {}
