import { Module } from '@nestjs/common';
import { PlatformModulesModule } from '../platform-modules/platform-modules.module';
import { ReportingController } from './reporting.controller';
import { ReportingRepository } from './reporting.repository';
import { ReportingService } from './reporting.service';

/**
 * Phase 30 — reporting and analytics.
 *
 * Note what this module does NOT import. It does not take InventoryModule,
 * OrdersModule, ReturnsModule or PricingModule, because it has nothing to ask
 * them to do: it never appends a movement, never completes an order, never
 * records a write-off. It reads their tables and adds up what is there.
 *
 * The one collaborator it does take is PlatformModulesService, and only to
 * REFUSE: a report over a module a tenant has disabled is denied, and the
 * CV-accuracy report checks the video-ingest module before it will include
 * video-backed observations.
 */
@Module({
  imports: [PlatformModulesModule],
  controllers: [ReportingController],
  providers: [ReportingService, ReportingRepository],
  exports: [ReportingService],
})
export class ReportingModule {}
