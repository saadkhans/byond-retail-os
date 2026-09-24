import { Module } from '@nestjs/common';
import { LINE_PRICING_PORT } from '../checkout/line-pricing.port';
import { PlatformModulesModule } from '../platform-modules/platform-modules.module';
import { PriceActivationHub } from './price-activation.hub';
import { PriceResolutionService } from './price-resolution.service';
import { PriceBooksController, PricesController } from './pricing.controller';
import { PricingRepository } from './pricing.repository';
import { PricingService } from './pricing.service';

/**
 * Pricing owns the price domain and exposes two things to the rest of the
 * system: LINE_PRICING_PORT, the resolver checkout uses to snapshot a price
 * onto a basket line, and PriceActivationHub, which downstream modules
 * subscribe to so they learn when shopper-visible prices change. Nothing
 * outside this module touches price tables.
 */
@Module({
  imports: [PlatformModulesModule],
  controllers: [PriceBooksController, PricesController],
  providers: [
    PricingService,
    PricingRepository,
    PriceResolutionService,
    PriceActivationHub,
    { provide: LINE_PRICING_PORT, useExisting: PriceResolutionService },
  ],
  exports: [PriceResolutionService, PriceActivationHub, LINE_PRICING_PORT],
})
export class PricingModule {}
