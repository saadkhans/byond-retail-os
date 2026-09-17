import { Module } from '@nestjs/common';
import { ShopperThrottleGuard } from '../auth/guards/shopper-throttle.guard';
import { PlatformModulesModule } from '../platform-modules/platform-modules.module';
import { StoreFlowModule } from '../store-flow/store-flow.module';
import { ShopperController } from './shopper.controller';
import { ShopperRepository } from './shopper.repository';
import { ShopperService } from './shopper.service';

/**
 * Phase 35 — the shopper application's API surface.
 *
 * It imports the two things it is allowed to depend on and nothing else:
 *
 *   StoreFlowModule      — the Phase 26 loop. Entry, the basket, the exit and
 *                          the payment all happen there, through the same
 *                          audited, idempotent methods an operator drives.
 *   PlatformModulesModule — so the `store-flow` module gate that every
 *                          neighbouring route gets from @RequireModule is
 *                          applied here too, from inside the service.
 *
 * Notably absent: CheckoutModule, OrdersModule, PaymentsModule, VisionModule,
 * InventoryModule. A shopper-facing surface has no business holding a
 * reference to any of them, and boundary.spec.ts fails if one appears.
 *
 * ShopperThrottleGuard is a provider rather than a bare class so it is ONE
 * instance for the whole module: its sliding window is per-process state, and
 * a guard re-instantiated per request would count nothing.
 */
@Module({
  imports: [PlatformModulesModule, StoreFlowModule],
  controllers: [ShopperController],
  providers: [ShopperService, ShopperRepository, ShopperThrottleGuard],
})
export class ShopperModule {}
