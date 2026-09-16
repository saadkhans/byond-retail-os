import { Module } from '@nestjs/common';
import { LINE_PRICING_PORT } from '../checkout/line-pricing.port';
import { PlatformModulesModule } from '../platform-modules/platform-modules.module';
import { PriceResolutionService } from './price-resolution.service';
import { PriceBooksController, PricesController } from './pricing.controller';
import { PricingRepository } from './pricing.repository';
import { PricingService } from './pricing.service';

/**
 * Pricing owns the price domain and exposes exactly one thing to the rest of
 * the system: LINE_PRICING_PORT, the resolver checkout uses to snapshot a
 * price onto a basket line. Nothing outside this module touches price tables.
 */
@Module({
  imports: [PlatformModulesModule],
  controllers: [PriceBooksController, PricesController],
  providers: [
    PricingService,
    PricingRepository,
    PriceResolutionService,
    { provide: LINE_PRICING_PORT, useExisting: PriceResolutionService },
  ],
  exports: [PriceResolutionService, LINE_PRICING_PORT],
})
export class PricingModule {}
