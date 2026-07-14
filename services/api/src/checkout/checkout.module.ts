import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { CheckoutSessionsController } from './checkout-sessions.controller';
import { CheckoutSessionsRepository } from './checkout-sessions.repository';
import { CheckoutSessionsService } from './checkout-sessions.service';

@Module({
  // InventoryModule provides InventoryRepository.applyMovement, which
  // completion uses to consume stock inside its own transaction — the SALE
  // path reuses the exact conditional-decrement ledger code as manual
  // adjustments rather than reimplementing it.
  imports: [InventoryModule],
  controllers: [CheckoutSessionsController],
  providers: [CheckoutSessionsService, CheckoutSessionsRepository],
})
export class CheckoutModule {}
