import { Module } from '@nestjs/common';
import { EvidenceBundlesController } from './evidence-bundles.controller';
import { VisionEventsController } from './vision-events.controller';
import { VisionEventsRepository } from './vision-events.repository';
import { VisionEventsService } from './vision-events.service';

/**
 * Phase 7 — CV product recognition & virtual basket foundation. The module
 * owns the normalized event → evidence → candidate → review → basket flow;
 * it applies approved basket effects itself (under the same session/product
 * advisory locks as checkout) rather than importing CheckoutModule, so the
 * decision and its basket mutation share one transaction.
 */
@Module({
  controllers: [VisionEventsController, EvidenceBundlesController],
  providers: [VisionEventsService, VisionEventsRepository],
  // Exported for the Phase 9 inference module: converting a successful
  // inference result into a vision event goes through the SAME ingest
  // contract (never a parallel implementation).
  exports: [VisionEventsService],
})
export class VisionModule {}
