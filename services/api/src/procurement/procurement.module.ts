import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { PlatformModulesModule } from '../platform-modules/platform-modules.module';
import { SimulatedSupplierAdapter } from './adapters/simulated-supplier.adapter';
import {
  GoodsReceiptsController,
  PurchaseOrdersController,
  SupplierProductsController,
  SuppliersController,
} from './procurement.controller';
import { ProcurementRepository } from './procurement.repository';
import { ProcurementService } from './procurement.service';
import { SUPPLIER_INTEGRATION_PORT } from './supplier-integration.port';

/**
 * Procurement owns suppliers, purchase orders and goods receipts.
 *
 * It depends on InventoryModule for exactly one thing:
 * `InventoryRepository.applyMovement`, the same entry point checkout
 * completion uses. Receiving therefore reaches stock through the append-only
 * ledger and nowhere else — this module never writes an InventoryLevel.
 *
 * The supplier integration is bound behind a port, so swapping the simulated
 * adapter for a real EDI or portal client is a provider change here and
 * nothing else.
 */
@Module({
  imports: [PlatformModulesModule, InventoryModule],
  controllers: [
    SuppliersController,
    SupplierProductsController,
    PurchaseOrdersController,
    GoodsReceiptsController,
  ],
  providers: [
    ProcurementService,
    ProcurementRepository,
    SimulatedSupplierAdapter,
    {
      provide: SUPPLIER_INTEGRATION_PORT,
      useExisting: SimulatedSupplierAdapter,
    },
  ],
  exports: [ProcurementService],
})
export class ProcurementModule {}
