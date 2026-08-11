import { Injectable, Logger } from '@nestjs/common';
import { ProductStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LocalVideoStorageAdapter } from '../video-ingest/storage/local-video-storage.adapter';
import { PickupAnalysisFrameDecoder } from './analysis/analysis-frames';
import { ReferenceImage, RgbImage } from './analysis/product-matcher';
import { PICKUP_MIN_REFERENCE_IMAGES } from './reference-images.service';

/** Decoded-image cache cap — 200 x (96x96x3 bytes) ≈ 5.5 MiB. */
const DECODE_CACHE_MAX = 200;

export interface ReferenceLibraryLoad {
  references: ReferenceImage[];
  /** Distinct products carrying ANY reference image (ready or not). */
  productsWithImages: number;
  /** Distinct products meeting the inference-ready floor. */
  readyProducts: number;
}

/**
 * DB-backed per-SKU reference library for the pickup matcher — rows are
 * managed exclusively through the reference-image API (no operator-managed
 * directory exists any more). ONLY INFERENCE-READY products participate: a
 * product below PICKUP_MIN_REFERENCE_IMAGES (5) is invisible to matching,
 * so a claim can never rest on a one-photo appearance model.
 * Identification remains pixels-only.
 */
@Injectable()
export class PickupReferenceLibrary {
  private readonly logger = new Logger(PickupReferenceLibrary.name);

  /**
   * checksum → decoded pixels. CONTENT-ADDRESSED, so it can never go
   * stale-wrong: participation in a match is decided by the DB query on
   * EVERY load (a deleted image simply stops being queried; a new upload
   * has a new checksum and decodes fresh), and a checksum's pixels never
   * change. Re-run detection therefore always sees the latest library —
   * the cache only skips re-decoding bytes it has already seen.
   */
  private readonly decodeCache = new Map<string, RgbImage>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: LocalVideoStorageAdapter,
    private readonly decoder: PickupAnalysisFrameDecoder,
  ) {}

  async load(tenantId: string): Promise<ReferenceLibraryLoad> {
    // ACTIVE products only — the same rule bulk import enforces on entry.
    // A DRAFT/DISCONTINUED/ARCHIVED product keeps its stored images, but
    // they must not stay inference-ready: matching one would create a
    // reviewable pickup event for a product that left the catalog.
    const rows = await this.prisma.productReferenceImage.findMany({
      where: { tenantId, product: { status: ProductStatus.ACTIVE } },
      select: {
        checksumSha256: true,
        storageKey: true,
        product: { select: { id: true, sku: true } },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const byProduct = new Map<string, typeof rows>();
    for (const row of rows) {
      const list = byProduct.get(row.product.id) ?? [];
      list.push(row);
      byProduct.set(row.product.id, list);
    }
    const references: ReferenceImage[] = [];
    let readyProducts = 0;
    for (const [, productRows] of byProduct) {
      if (productRows.length < PICKUP_MIN_REFERENCE_IMAGES) {
        continue;
      }
      readyProducts += 1;
      for (const row of productRows) {
        const cached = this.decodeCache.get(row.checksumSha256);
        if (cached) {
          references.push({
            productId: row.product.id,
            sku: row.product.sku,
            image: cached,
          });
          continue;
        }
        try {
          const image = await this.decoder.decodeReferenceImage(
            this.storage.internalPathFor(row.storageKey),
          );
          if (this.decodeCache.size >= DECODE_CACHE_MAX) {
            const oldest = this.decodeCache.keys().next().value;
            if (oldest !== undefined) {
              this.decodeCache.delete(oldest);
            }
          }
          this.decodeCache.set(row.checksumSha256, image);
          references.push({
            productId: row.product.id,
            sku: row.product.sku,
            image,
          });
        } catch {
          this.logger.warn(
            `Skipped undecodable reference image for SKU ${row.product.sku}`,
          );
        }
      }
    }
    return {
      references,
      productsWithImages: byProduct.size,
      readyProducts,
    };
  }

  /**
   * Inference-ready product ids, optionally scoped to a store: when the
   * store stocks ANY products, readiness intersects with the stocked SKUs
   * (a store cannot claim a pickup of a product it does not carry); a
   * store with no stock rows at all (lab/dev) falls back to tenant-wide.
   */
  async readyProductIds(
    tenantId: string,
    locationId: string | null,
  ): Promise<string[]> {
    const grouped = await this.prisma.productReferenceImage.groupBy({
      by: ['productId'],
      // Same ACTIVE-only rule as load(): retired products never match.
      where: { tenantId, product: { status: ProductStatus.ACTIVE } },
      _count: { _all: true },
    });
    let ready = grouped
      .filter((g) => g._count._all >= PICKUP_MIN_REFERENCE_IMAGES)
      .map((g) => g.productId);
    if (locationId && ready.length > 0) {
      const stocked = await this.prisma.inventoryLevel.findMany({
        where: { tenantId, locationId },
        select: { productId: true },
      });
      if (stocked.length > 0) {
        const stockedIds = new Set(stocked.map((s) => s.productId));
        ready = ready.filter((id) => stockedIds.has(id));
      }
    }
    return ready;
  }
}
