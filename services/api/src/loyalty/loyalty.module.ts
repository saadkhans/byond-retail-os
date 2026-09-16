import { Module } from '@nestjs/common';
import { LINE_PROMOTION_PORT } from '../checkout/line-promotion.port';
import { PlatformModulesModule } from '../platform-modules/platform-modules.module';
import { PricingModule } from '../pricing/pricing.module';
import { LoyaltyController } from './loyalty.controller';
import { LoyaltyRepository } from './loyalty.repository';
import { LoyaltyService } from './loyalty.service';
import { PromotionResolutionService } from './promotion-resolution.service';

/**
 * Loyalty and promotions.
 *
 * The dependency on pricing runs ONE way and is READ-ONLY: this module
 * imports PricingModule to ASK what a product costs, and pricing never learns
 * that promotions exist. There is no hub subscription here and no write path
 * back — a promotion composes on top of the price version in force and can
 * never change which version that is, let alone edit one.
 *
 * Checkout gets the discount through LINE_PROMOTION_PORT, a second optional
 * port alongside LINE_PRICING_PORT. Ordering is the invariant: pricing
 * resolves first and alone, promotions compose afterwards on the value it
 * returned.
 */
@Module({
  imports: [PlatformModulesModule, PricingModule],
  controllers: [LoyaltyController],
  providers: [
    LoyaltyService,
    LoyaltyRepository,
    PromotionResolutionService,
    { provide: LINE_PROMOTION_PORT, useExisting: PromotionResolutionService },
  ],
  exports: [PromotionResolutionService, LINE_PROMOTION_PORT],
})
export class LoyaltyModule {}
