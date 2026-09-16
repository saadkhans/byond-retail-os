import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  LinePricingPort,
  LinePricingQuery,
  ResolvedLinePrice,
} from '../checkout/line-pricing.port';
import { PlatformModulesService } from '../platform-modules/platform-modules.service';
import { PRICING_MODULE_CODE } from './pricing.constants';
import { PricingRepository } from './pricing.repository';
import { ResolvedPrice, selectPrice } from './pricing.logic';

/**
 * Answers "what does this product cost?" for everyone: the resolve endpoint,
 * and checkout through {@link LinePricingPort}.
 *
 * The module gate lives HERE rather than in checkout. A tenant that has not
 * enabled pricing gets null, which every caller already handles as "unpriced",
 * so enabling or disabling the module can never fail a basket mutation.
 */
@Injectable()
export class PriceResolutionService implements LinePricingPort {
  constructor(
    private readonly repository: PricingRepository,
    private readonly platformModules: PlatformModulesService,
  ) {}

  /**
   * Resolves one product's price. `at` defaults to now; passing a past
   * instant answers historically, because superseded versions keep their
   * closed effective windows.
   */
  async resolve(
    tenantId: string,
    productId: string,
    at: Date = new Date(),
    locationId?: string | null,
  ): Promise<ResolvedPrice | null> {
    const byProduct = await this.repository.findPriceCandidates(
      tenantId,
      [productId],
      at,
      locationId,
    );
    return selectPrice(byProduct.get(productId) ?? [], at, locationId);
  }

  /** Batch form — one query for a whole basket rather than one per line. */
  async resolveMany(
    tenantId: string,
    productIds: readonly string[],
    at: Date = new Date(),
    locationId?: string | null,
    client?: Prisma.TransactionClient,
  ): Promise<Map<string, ResolvedPrice>> {
    const byProduct = await this.repository.findPriceCandidates(
      tenantId,
      productIds,
      at,
      locationId,
      client,
    );
    const resolved = new Map<string, ResolvedPrice>();
    for (const productId of productIds) {
      const price = selectPrice(
        byProduct.get(productId) ?? [],
        at,
        locationId,
      );
      if (price) {
        resolved.set(productId, price);
      }
    }
    return resolved;
  }

  async resolveForLine(
    client: Prisma.TransactionClient,
    query: LinePricingQuery,
  ): Promise<ResolvedLinePrice | null> {
    const enabled = await this.platformModules.isEnabledForTenant(
      query.tenantId,
      PRICING_MODULE_CODE,
    );
    if (!enabled) {
      return null;
    }
    const byProduct = await this.repository.findPriceCandidates(
      query.tenantId,
      [query.productId],
      query.at,
      query.locationId,
      client,
    );
    return selectPrice(
      byProduct.get(query.productId) ?? [],
      query.at,
      query.locationId,
    );
  }
}
