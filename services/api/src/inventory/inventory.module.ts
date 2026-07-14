import { Module } from '@nestjs/common';
import { InventoryController } from './inventory.controller';
import { InventoryRepository } from './inventory.repository';
import { InventoryService } from './inventory.service';

@Module({
  controllers: [InventoryController],
  providers: [InventoryService, InventoryRepository],
  // InventoryRepository is exported for checkout completion (Phase 5), which
  // applies SALE movements inside its own transaction via applyMovement().
  exports: [InventoryService, InventoryRepository],
})
export class InventoryModule {}
