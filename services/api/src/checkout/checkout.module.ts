import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
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
  imports: [InventoryModule, PricingModule],
  controllers: [CheckoutSessionsController],
  providers: [CheckoutSessionsService, CheckoutSessionsRepository],
})
export class CheckoutModule {}
