import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CandidateFusion,
  CandidateSignal,
  ContextInput,
  ContextSignalProvider,
  FusedCandidate,
  InventoryValidation,
  InventoryValidator,
} from '../ports';

/**
 * Contextual priors (requirement 9): store inventory presence and
 * availability, unit/camera binding, product category concentration, and
 * the shelf-zone hook. Scores are PRIORS in [0,1] — they nudge fusion,
 * they never identify on their own. A store with no inventory rows (lab
 * mode) contributes a flat neutral prior rather than pretending to know.
 */
@Injectable()
export class PrismaContextSignalProvider implements ContextSignalProvider {
  readonly adapterKey = 'store-context';
  readonly version = '1.0.0';

  constructor(private readonly prisma: PrismaService) {}

  checkReady(): Promise<boolean> {
    return Promise.resolve(true);
  }

  async contextFor(
    tenantId: string,
    context: ContextInput,
    productIds: string[],
  ): Promise<CandidateSignal[]> {
    if (productIds.length === 0) {
      return [];
    }
    const products = await this.prisma.product.findMany({
      where: { tenantId, id: { in: productIds } },
      select: { id: true, sku: true, categoryId: true, status: true },
    });
    const stock = context.locationId
      ? await this.prisma.inventoryLevel.findMany({
          where: { tenantId, locationId: context.locationId },
          select: { productId: true, quantity: true },
        })
      : [];
    const stockByProduct = new Map(stock.map((row) => [row.productId, row.quantity]));
    const storeHasInventory = stock.length > 0;
    return products.map((product) => {
      let score = 0.5; // neutral prior
      const details: string[] = [];
      if (product.status !== 'ACTIVE') {
        score = 0.1;
        details.push('inactive-product');
      } else if (storeHasInventory) {
        const quantity = stockByProduct.get(product.id);
        if (quantity === undefined) {
          score = 0.2;
          details.push('not-stocked-at-store');
        } else if (quantity <= 0) {
          score = 0.35;
          details.push('out-of-stock');
        } else {
          score = 0.8;
          details.push(`in-stock(${quantity})`);
        }
      } else {
        details.push('store-has-no-inventory-data');
      }
      if (context.unitId) {
        details.push(`unit:${context.unitId.slice(0, 8)}`);
      }
      if (context.shelfZoneId) {
        // Planogram slot hook: no planogram data exists yet, so the zone is
        // recorded as evidence without moving the score.
        details.push(`zone:${context.shelfZoneId}(no-planogram-data)`);
      }
      return {
        productId: product.id,
        sku: product.sku,
        score,
        detail: details.join(','),
      };
    });
  }
}

/**
 * Fusion weights — configuration, not calibration. Chosen so the SIGNAL
 * CLASSES can reach the default auto threshold (0.42) in the combinations
 * the policy intends: a catalog-matched barcode plus any support clears
 * it; STRONG agreement of both visual signals with a plausible context
 * clears it narrowly; any single mediocre signal cannot.
 */
export const FUSION_WEIGHTS = {
  barcode: 0.35,
  classical: 0.22,
  retrieval: 0.22,
  ocr: 0.13,
  context: 0.08,
} as const;

/**
 * Weighted-sum candidate fusion (requirement 10): every individual signal
 * retained verbatim on each candidate; top 10 kept; score margin recorded.
 * The fused value is EXPLICITLY UNCALIBRATED — a ranking score, not a
 * probability (the UI labels it "fused score").
 */
@Injectable()
export class WeightedCandidateFusion implements CandidateFusion {
  readonly adapterKey = 'weighted-sum';
  readonly version = '2.0.0';

  checkReady(): Promise<boolean> {
    return Promise.resolve(true);
  }

  fuse(
    inputs: {
      classical: CandidateSignal[];
      retrieval: CandidateSignal[];
      barcode: CandidateSignal[];
      ocr: CandidateSignal[];
      context: CandidateSignal[];
    },
    products: Map<string, { sku: string; name: string }>,
  ): FusedCandidate[] {
    const bySource: [keyof typeof FUSION_WEIGHTS, CandidateSignal[]][] = [
      ['barcode', inputs.barcode],
      ['classical', inputs.classical],
      ['retrieval', inputs.retrieval],
      ['ocr', inputs.ocr],
      ['context', inputs.context],
    ];
    const accumulator = new Map<
      string,
      {
        bestBySource: Map<keyof typeof FUSION_WEIGHTS, number>;
        signals: FusedCandidate['signals'];
      }
    >();
    for (const [source, signals] of bySource) {
      for (const signal of signals) {
        const entry = accumulator.get(signal.productId) ?? {
          bestBySource: new Map<keyof typeof FUSION_WEIGHTS, number>(),
          signals: [] as FusedCandidate['signals'],
        };
        // Each source counts ONCE per candidate: duplicate rows from the
        // same source (e.g. the same barcode decoded on both crop and peak
        // frames) keep the max score rather than stacking the weight, so no
        // single signal class can clear the auto threshold by repetition.
        entry.bestBySource.set(
          source,
          Math.max(entry.bestBySource.get(source) ?? 0, signal.score),
        );
        entry.signals.push({
          source,
          score: signal.score,
          ...(signal.detail ? { detail: signal.detail } : {}),
        });
        accumulator.set(signal.productId, entry);
      }
    }
    const ranked = [...accumulator.entries()]
      .map(([productId, entry]) => {
        let weighted = 0;
        for (const [source, score] of entry.bestBySource) {
          weighted += FUSION_WEIGHTS[source] * score;
        }
        return {
          productId,
          sku: products.get(productId)?.sku ?? productId,
          productName: products.get(productId)?.name ?? productId,
          fusedScore: Math.round(weighted * 10_000) / 10_000,
          signals: entry.signals,
        };
      })
      .sort((a, b) => b.fusedScore - a.fusedScore)
      .slice(0, 10);
    return ranked.map((candidate, index) => ({
      ...candidate,
      rank: index + 1,
      scoreMargin:
        Math.round(
          (candidate.fusedScore - (ranked[index + 1]?.fusedScore ?? 0)) * 10_000,
        ) / 10_000,
    }));
  }
}

/** Inventory VALIDATES the proposal (requirement 1/13) — read-only. */
@Injectable()
export class PrismaInventoryValidator implements InventoryValidator {
  readonly adapterKey = 'inventory-read';
  readonly version = '1.0.0';

  constructor(private readonly prisma: PrismaService) {}

  checkReady(): Promise<boolean> {
    return Promise.resolve(true);
  }

  async validate(
    tenantId: string,
    locationId: string | null,
    productIds: string[],
  ): Promise<InventoryValidation[]> {
    const products = await this.prisma.product.findMany({
      where: { tenantId, id: { in: productIds } },
      select: { id: true, sku: true },
    });
    if (!locationId) {
      return products.map((product) => ({
        productId: product.id,
        sku: product.sku,
        stockedAtStore: false,
        onHandQuantity: null,
        verdict: 'NO_STORE_CONTEXT' as const,
      }));
    }
    const stock = await this.prisma.inventoryLevel.findMany({
      where: { tenantId, locationId, productId: { in: productIds } },
      select: { productId: true, quantity: true },
    });
    const byProduct = new Map(stock.map((row) => [row.productId, row.quantity]));
    return products.map((product) => {
      const quantity = byProduct.get(product.id);
      return {
        productId: product.id,
        sku: product.sku,
        stockedAtStore: quantity !== undefined,
        onHandQuantity: quantity ?? null,
        verdict:
          quantity === undefined
            ? ('NOT_STOCKED' as const)
            : quantity <= 0
              ? ('OUT_OF_STOCK' as const)
              : ('PLAUSIBLE' as const),
      };
    });
  }
}
