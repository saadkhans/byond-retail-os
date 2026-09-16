import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { PaymentsModule } from '../payments/payments.module';
import { CycleCountRepository } from './cycle-count.repository';
import { CycleCountService } from './cycle-count.service';
import {
  CycleCountController,
  ReturnsController,
  ShrinkController,
} from './returns.controller';
import { ReturnsRepository } from './returns.repository';
import { ReturnsService } from './returns.service';
import { ShrinkRepository } from './shrink.repository';
import { ShrinkService } from './shrink.service';

/**
 * Phase 27 — the reverse flow: returns, refunds, reconciliation and shrink.
 *
 * Like the store flow before it, this module owns no stock and no money logic
 * of its own. It imports the two modules that do and orchestrates them:
 *
 *   InventoryModule — `InventoryRepository.applyMovement`, the SAME entry
 *                     point checkout completion uses to take stock away, used
 *                     here inside this module's own transactions to put stock
 *                     back (RETURN_IN), correct a count (CORRECTION_IN/OUT)
 *                     and write off a loss (SHRINK). There is no second way
 *                     for stock to change, in either direction.
 *   PaymentsModule  — the provider-neutral intent state machine, now with
 *                     refunds behind the owned refund-gateway port. This
 *                     module never touches a payment table.
 *
 * Everything the reverse flow adds is therefore a DECISION RECORD next to the
 * two existing sources of truth, never a replacement for either.
 */
@Module({
  imports: [InventoryModule, PaymentsModule],
  controllers: [ReturnsController, CycleCountController, ShrinkController],
  providers: [
    ReturnsService,
    ReturnsRepository,
    CycleCountService,
    CycleCountRepository,
    ShrinkService,
    ShrinkRepository,
  ],
  exports: [ReturnsService, CycleCountService, ShrinkService],
})
export class ReturnsModule {}
