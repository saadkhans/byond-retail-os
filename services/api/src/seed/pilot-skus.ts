import { ProductStatus, TenantStatus } from '@prisma/client';
import { encodeRgbPng } from '../pickup-fusion/adapters/text-signals';
import { RgbImage } from '../pickup-detection/analysis/product-matcher';
import { PLATFORM_SANDBOX_TENANT_SLUG } from '../tenants/platform-sandbox';

/**
 * Phase 12 — pilot SKU seed (dev/demo ONLY).
 *
 * Provisions a small multi-SKU pilot assortment in the platform-sandbox
 * tenant so the shadow pipeline can be exercised against more than one
 * water bottle: ~7 demo products, each with >= 5 SYNTHETIC reference
 * images GENERATED at seed time (distinct color/stripe pattern per SKU,
 * deterministic bytes). No media file is ever committed to the repo, and
 * no real customer imagery is involved anywhere.
 *
 * Gated by SEED_PILOT_SKUS === 'true' — a seed-script-only environment
 * flag, deliberately NOT declared in src/config/env.validation.ts: the
 * running API never reads it (the validator would strip it), only
 * prisma/seed.ts does, exactly like SEED_PLATFORM_ADMIN.
 *
 * Reference images flow through the SAME screened upload path as the
 * admin UI (ReferenceImagesService.upload): filename/byte/pixel screens,
 * decode verification, and checksum dedup all apply, which also makes a
 * re-run a no-op (same deterministic bytes → same checksum → replay).
 */

export const PILOT_SKU_SEED_FLAG = 'SEED_PILOT_SKUS';

export interface PilotSkuDefinition {
  sku: string;
  name: string;
  /** Base RGB fill — visually distinct per SKU so classical matching and
   *  embeddings can genuinely separate the pilot assortment. */
  base: [number, number, number];
  /** Stripe RGB — the second color of the SKU's banding pattern. */
  stripe: [number, number, number];
}

/** The pilot assortment. WATER-BOTTLE-500ML matches the existing sandbox
 *  product (upsert reuses it — never a duplicate). */
export const PILOT_SKUS: readonly PilotSkuDefinition[] = [
  { sku: 'WATER-BOTTLE-500ML', name: 'Drinking Water Bottle 500ml', base: [70, 130, 200], stripe: [235, 245, 255] },
  { sku: 'COLA-CAN-330ML', name: 'Cola Can 330ml', base: [180, 30, 40], stripe: [90, 10, 15] },
  { sku: 'SODA-BLUE-330ML', name: 'Blue Soda Can 330ml', base: [30, 60, 180], stripe: [200, 215, 250] },
  { sku: 'JUICE-ORANGE-1L', name: 'Orange Juice Carton 1L', base: [235, 140, 30], stripe: [250, 210, 120] },
  { sku: 'CHIPS-RED-150G', name: 'Red Chips Bag 150g', base: [200, 60, 30], stripe: [245, 200, 60] },
  { sku: 'CHOC-BAR-45G', name: 'Chocolate Bar 45g', base: [90, 55, 30], stripe: [180, 130, 70] },
  { sku: 'YOGURT-CUP-125G', name: 'Yogurt Cup 125g', base: [240, 240, 235], stripe: [140, 190, 230] },
];

/** Reference images generated per SKU — one above the library's readiness
 *  minimum (PICKUP_MIN_REFERENCE_IMAGES = 5) so a deleted image does not
 *  immediately degrade the SKU. */
export const PILOT_REFERENCES_PER_SKU = 6;

export function shouldSeedPilotSkus(env: {
  SEED_PILOT_SKUS?: string;
}): { seed: true } | { seed: false; reason: string } {
  if (env.SEED_PILOT_SKUS === 'true') {
    return { seed: true };
  }
  return {
    seed: false,
    reason:
      env.SEED_PILOT_SKUS === undefined
        ? `${PILOT_SKU_SEED_FLAG} is not set`
        : `${PILOT_SKU_SEED_FLAG} is '${env.SEED_PILOT_SKUS}', not 'true'`,
  };
}

/**
 * Deterministic synthetic reference render: base fill, horizontal stripe
 * banding whose period is keyed to the SKU index, and a variant-shifted
 * vertical highlight so the >= 5 images of one SKU differ from each other
 * without any randomness (same bytes every run → checksum dedup).
 */
export function renderPilotReferencePng(
  skuIndex: number,
  variant: number,
  definition: PilotSkuDefinition,
): Buffer {
  const size = 96;
  const rgb = Buffer.alloc(size * size * 3);
  const stripePeriod = 8 + (skuIndex % 5) * 4;
  const highlightColumn = ((variant * 17) % size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const striped = y % stripePeriod < Math.floor(stripePeriod / 2);
      const [r, g, b] = striped ? definition.stripe : definition.base;
      // Variant highlight: a soft vertical band, 12px wide, slightly
      // brightening whatever it crosses.
      const inHighlight = Math.abs(x - highlightColumn) < 6;
      const lift = inHighlight ? 24 : 0;
      const offset = (y * size + x) * 3;
      rgb[offset] = Math.min(255, r + lift);
      rgb[offset + 1] = Math.min(255, g + lift);
      rgb[offset + 2] = Math.min(255, b + lift);
    }
  }
  const image: RgbImage = { width: size, height: size, rgb };
  return encodeRgbPng(image);
}

/** Narrow structural clients (same testing pattern as the other seeders). */
export interface PilotSkuSeedClient {
  tenant: {
    findFirst(args: {
      where: {
        slug: string;
        status: TenantStatus;
        isPlatformSandbox: boolean;
      };
      select: { id: true };
    }): Promise<{ id: string } | null>;
  };
  product: {
    upsert(args: {
      where: { tenantId_sku: { tenantId: string; sku: string } };
      update: Record<string, never>;
      create: {
        tenantId: string;
        sku: string;
        name: string;
        status: ProductStatus;
      };
      select: { id: true; sku: true };
    }): Promise<{ id: string; sku: string }>;
  };
}

/** The screened reference-image funnel — satisfied by
 *  ReferenceImagesService.upload, stubbed in tests. */
export interface PilotReferenceUploader {
  upload(
    tenantId: string,
    productId: string,
    file: { buffer: Buffer; mimetype: string; originalname: string },
  ): Promise<unknown>;
}

export async function seedPilotSkus(
  db: PilotSkuSeedClient,
  uploader: PilotReferenceUploader,
): Promise<{ tenantId: string; products: number; referenceUploads: number }> {
  // VERIFIED sandbox identity only (Phase 10 marker) — never the slug
  // alone, and never a customer tenant: pilot demo data must not land in
  // real tenant catalogs.
  const sandbox = await db.tenant.findFirst({
    where: {
      slug: PLATFORM_SANDBOX_TENANT_SLUG,
      status: TenantStatus.ACTIVE,
      isPlatformSandbox: true,
    },
    select: { id: true },
  });
  if (!sandbox) {
    throw new Error(
      'Pilot SKU seed requires the VERIFIED platform-sandbox tenant ' +
        '(seed the platform admin + sandbox first); refusing to seed ' +
        'demo products anywhere else.',
    );
  }
  let referenceUploads = 0;
  for (const [index, definition] of PILOT_SKUS.entries()) {
    // Idempotent by (tenantId, sku): an existing product (e.g. the
    // original water bottle) is REUSED untouched — update is empty by
    // design so a reseed never rewrites operator catalog state.
    const product = await db.product.upsert({
      where: {
        tenantId_sku: { tenantId: sandbox.id, sku: definition.sku },
      },
      update: {},
      create: {
        tenantId: sandbox.id,
        sku: definition.sku,
        name: definition.name,
        status: ProductStatus.ACTIVE,
      },
      select: { id: true, sku: true },
    });
    for (let variant = 0; variant < PILOT_REFERENCES_PER_SKU; variant += 1) {
      const buffer = renderPilotReferencePng(index, variant, definition);
      // Deterministic bytes + the upload path's checksum dedup make this
      // loop a replay on re-runs — no duplicate rows, no orphan bytes.
      await uploader.upload(sandbox.id, product.id, {
        buffer,
        mimetype: 'image/png',
        originalname: `pilot-${definition.sku.toLowerCase()}-v${variant}.png`,
      });
      referenceUploads += 1;
    }
  }
  return {
    tenantId: sandbox.id,
    products: PILOT_SKUS.length,
    referenceUploads,
  };
}

// NOTE: inventory levels are deliberately NOT seeded here. The seeders
// module has no movement-ledger path today, and inventory is only ever
// written through the InventoryMovement ledger (AGENTS.md) — a direct
// InventoryLevel write from a seed script would violate that invariant.
// Operators stock the pilot SKUs through the existing inventory flows.
