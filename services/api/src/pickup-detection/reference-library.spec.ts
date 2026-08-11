import { PickupDetectionConfig } from './pickup-detection.config';
import { PickupReferenceLibrary } from './reference-library';

/**
 * Store-scoping contract for readyProductIds: a store with NO inventory
 * rows matches NOTHING by default — an empty/new production store must
 * never produce a matched pickup for a product it does not stock (the
 * fusion path treats the same absence as NOT_STOCKED). The tenant-wide
 * fallback exists ONLY behind the explicit PICKUP_LAB_MODE flag.
 */

const TENANT = 'tenant-1';
const STORE = 'loc-1';

function buildLibrary(
  options: {
    /** productId → reference-image count returned by the groupBy. */
    imageCounts?: Record<string, number>;
    stockedProductIds?: string[];
    labMode?: boolean;
  } = {},
) {
  const counts = options.imageCounts ?? { 'p-ready-a': 5, 'p-ready-b': 7 };
  const prisma = {
    productReferenceImage: {
      groupBy: jest.fn(async () =>
        Object.entries(counts).map(([productId, count]) => ({
          productId,
          _count: { _all: count },
        })),
      ),
    },
    inventoryLevel: {
      findMany: jest.fn(async () =>
        (options.stockedProductIds ?? []).map((productId) => ({ productId })),
      ),
    },
  };
  const config = {
    labMode: options.labMode ?? false,
  } as PickupDetectionConfig;
  const library = new PickupReferenceLibrary(
    prisma as never,
    { internalPathFor: jest.fn() } as never,
    { decodeReferenceImage: jest.fn() } as never,
    config,
  );
  return { library, prisma };
}

describe('PickupReferenceLibrary.readyProductIds store scoping', () => {
  it('returns NO candidates for a store with zero inventory rows (default)', async () => {
    const { library, prisma } = buildLibrary({ stockedProductIds: [] });
    await expect(library.readyProductIds(TENANT, STORE)).resolves.toEqual([]);
    // The stock lookup stays tenant- AND store-scoped.
    expect(prisma.inventoryLevel.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: TENANT, locationId: STORE },
      }),
    );
  });

  it('restores the tenant-wide fallback only under PICKUP_LAB_MODE', async () => {
    const { library } = buildLibrary({
      stockedProductIds: [],
      labMode: true,
    });
    await expect(library.readyProductIds(TENANT, STORE)).resolves.toEqual([
      'p-ready-a',
      'p-ready-b',
    ]);
  });

  it('intersects readiness with the stocked SKUs when the store has stock', async () => {
    const { library } = buildLibrary({
      stockedProductIds: ['p-ready-b', 'p-unrelated'],
    });
    await expect(library.readyProductIds(TENANT, STORE)).resolves.toEqual([
      'p-ready-b',
    ]);
  });

  it('stays tenant-wide when no store is selected (locationId null)', async () => {
    const { library, prisma } = buildLibrary();
    await expect(library.readyProductIds(TENANT, null)).resolves.toEqual([
      'p-ready-a',
      'p-ready-b',
    ]);
    expect(prisma.inventoryLevel.findMany).not.toHaveBeenCalled();
  });

  it('never surfaces products below the inference-ready floor', async () => {
    const { library } = buildLibrary({
      imageCounts: { 'p-ready-a': 5, 'p-thin': 2 },
      stockedProductIds: ['p-ready-a', 'p-thin'],
    });
    await expect(library.readyProductIds(TENANT, STORE)).resolves.toEqual([
      'p-ready-a',
    ]);
  });

  it('skips the stock lookup entirely when nothing is inference-ready', async () => {
    const { library, prisma } = buildLibrary({
      imageCounts: { 'p-thin': 1 },
      labMode: true,
    });
    await expect(library.readyProductIds(TENANT, STORE)).resolves.toEqual([]);
    expect(prisma.inventoryLevel.findMany).not.toHaveBeenCalled();
  });
});
