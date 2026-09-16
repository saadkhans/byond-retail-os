import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  LinePromotionPort,
  LinePromotionQuery,
  PromotedLinePrice,
} from '../checkout/line-promotion.port';
import { PlatformModulesService } from '../platform-modules/platform-modules.service';
import { PriceResolutionService } from '../pricing/price-resolution.service';
import { LOYALTY_MODULE_CODE } from './loyalty.constants';
import { PromotionOutcome, selectPromotion } from './loyalty.logic';
import { LoyaltyRepository } from './loyalty.repository';

/**
 * A fully explained price for one product at one instant: the price version
 * that produced the base, and the promotion version (if any) that reduced it.
 *
 * "Explainable" is the whole point. Every number below can be traced to a row
 * an operator can open: `priceBookVersionId` says which price was in force,
 * `promotion.promotionVersionId` says which discount applied, and
 * `unitPriceMinor` is arithmetic on the two — not an independent value
 * anybody had to store.
 */
export interface PriceQuote {
  productId: string;
  currencyCode: string;
  basePriceMinor: number;
  priceBookId: string;
  priceBookVersionId: string;
  promotion: PromotionOutcome | null;
  unitPriceMinor: number;
}

/**
 * Answers "what does this product cost this shopper?" by composing promotions
 * ON TOP of the price the pricing module resolved.
 *
 * THE ORDERING IS THE INVARIANT. Pricing runs first and alone: it picks the
 * price book version in force and returns an immutable answer. Only then does
 * this service ask whether a promotion reduces it. Nothing here can change
 * which version pricing picked, and nothing here writes to a price table —
 * the base price is an input value, not a row this module can reach.
 *
 * That is why a promotion cannot bypass price versioning even in principle:
 * there is no code path from a promotion to a price row, only from a price
 * value to a smaller price value.
 */
@Injectable()
export class PromotionResolutionService implements LinePromotionPort {
  constructor(
    private readonly repository: LoyaltyRepository,
    private readonly priceResolution: PriceResolutionService,
    private readonly platformModules: PlatformModulesService,
  ) {}

  /**
   * Checkout's hook. Runs inside the caller's transaction so the discount is
   * decided under the same locks that resolved the price and created the line.
   *
   * The module gate lives HERE rather than in checkout, exactly as the pricing
   * gate does: a tenant without loyalty gets null, which the caller already
   * handles as "no discount", so enabling or disabling the module can never
   * fail a basket mutation.
   */
  async resolveForLine(
    client: Prisma.TransactionClient,
    query: LinePromotionQuery,
  ): Promise<PromotedLinePrice | null> {
    const enabled = await this.platformModules.isEnabledForTenant(
      query.tenantId,
      LOYALTY_MODULE_CODE,
    );
    if (!enabled) {
      return null;
    }
    const outcome = await this.selectFor(
      query.tenantId,
      {
        productId: query.productId,
        basePriceMinor: query.base.unitPriceMinor,
        at: query.at,
        locationId: query.locationId,
        loyaltyAccountId: query.loyaltyAccountId,
      },
      client,
    );
    if (!outcome) {
      return null;
    }
    return {
      basePriceMinor: query.base.unitPriceMinor,
      discountMinor: outcome.discountMinor,
      unitPriceMinor: outcome.finalUnitPriceMinor,
      currencyCode: query.base.currencyCode,
      promotionId: outcome.promotionId,
      promotionVersionId: outcome.promotionVersionId,
    };
  }

  /**
   * The operator-facing form: resolve the price AND the promotion, and report
   * both halves. `at` in the past answers historically, because superseded
   * price versions and superseded promotion versions both keep their closed
   * effective windows.
   *
   * Returns null when no price resolves. A product with no price is UNPRICED,
   * never free, and a promotion can never conjure a price for it — a discount
   * on nothing is nothing.
   */
  async quote(
    tenantId: string,
    input: {
      productId: string;
      at: Date;
      locationId?: string | null;
      loyaltyAccountId?: string | null;
    },
  ): Promise<PriceQuote | null> {
    const base = await this.priceResolution.resolve(
      tenantId,
      input.productId,
      input.at,
      input.locationId,
    );
    if (!base) {
      return null;
    }
    const enabled = await this.platformModules.isEnabledForTenant(
      tenantId,
      LOYALTY_MODULE_CODE,
    );
    const promotion = enabled
      ? await this.selectFor(tenantId, {
          productId: input.productId,
          basePriceMinor: base.unitPriceMinor,
          at: input.at,
          locationId: input.locationId ?? null,
          loyaltyAccountId: input.loyaltyAccountId ?? null,
        })
      : null;
    return {
      productId: input.productId,
      currencyCode: base.currencyCode,
      basePriceMinor: base.unitPriceMinor,
      priceBookId: base.priceBookId,
      priceBookVersionId: base.priceBookVersionId,
      promotion,
      unitPriceMinor: promotion
        ? promotion.finalUnitPriceMinor
        : base.unitPriceMinor,
    };
  }

  private async selectFor(
    tenantId: string,
    input: {
      productId: string;
      basePriceMinor: number;
      at: Date;
      locationId: string | null;
      loyaltyAccountId: string | null;
    },
    client?: Prisma.TransactionClient,
  ): Promise<PromotionOutcome | null> {
    const memberPresent = input.loyaltyAccountId
      ? await this.repository.isActiveMember(
          tenantId,
          input.loyaltyAccountId,
          client,
        )
      : false;
    const candidates = await this.repository.findPromotionCandidates(
      tenantId,
      [input.productId],
      input.at,
      input.locationId,
      client,
    );
    return selectPromotion(candidates, {
      productId: input.productId,
      basePriceMinor: input.basePriceMinor,
      at: input.at,
      locationId: input.locationId,
      memberPresent,
    });
  }
}
