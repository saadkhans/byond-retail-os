import { PrismaContextSignalProvider } from './context-fusion-inventory';

/**
 * Phase 22/23 — the planogram is its OWN fusion signal class
 * (fusion-weighting.ts). The context provider is inventory only: a rack
 * SKU is never boosted here (that would count the planogram twice), and
 * the zone detail records whether the candidate set was planogram-scoped.
 */
describe('PrismaContextSignalProvider — planogram is not a context prior (Phase 23)', () => {
  const products = [
    { id: 'p-water', sku: 'WATER', categoryId: null, status: 'ACTIVE' },
    { id: 'p-can', sku: 'CAN', categoryId: null, status: 'ACTIVE' },
    { id: 'p-retired', sku: 'OLD', categoryId: null, status: 'DISCONTINUED' },
  ];
  function build(hasInventory: boolean, stock: { productId: string; quantity: number }[] = []) {
    const prisma = {
      product: { findMany: jest.fn(async () => products) },
      inventoryLevel: {
        findFirst: jest.fn(async () => (hasInventory ? { id: 'inv-1' } : null)),
        findMany: jest.fn(async () => stock),
      },
    };
    return new PrismaContextSignalProvider(prisma as never);
  }

  it('a bound rack changes only the zone detail — rack SKUs keep the inventory score', async () => {
    const provider = build(false);
    const signals = await provider.contextFor(
      'tenant-1',
      {
        locationId: 'store-1',
        unitId: null,
        deviceId: null,
        shelfZoneId: 'zone-r2c1',
        planogramRackCode: 'SHELF-2X2',
        planogramProductIds: ['p-water', 'p-retired'],
      },
      ['p-water', 'p-can', 'p-retired'],
    );
    const bySku = new Map(signals.map((row) => [row.sku, row]));
    expect(bySku.get('WATER')?.score).toBe(0.5);
    expect(bySku.get('WATER')?.detail).not.toContain('planogram:rack');
    expect(bySku.get('WATER')?.detail).toContain('zone:zone-r2c1(planogram-scoped)');
    expect(bySku.get('CAN')?.score).toBe(0.5);
    expect(bySku.get('OLD')?.score).toBe(0.1);
  });

  it('in-stock products still get the inventory boost regardless of the rack', async () => {
    const provider = build(true, [{ productId: 'p-water', quantity: 4 }]);
    const [water] = await provider.contextFor(
      'tenant-1',
      {
        locationId: 'store-1',
        unitId: null,
        deviceId: null,
        shelfZoneId: null,
        planogramRackCode: 'R1',
        planogramProductIds: ['p-water'],
      },
      ['p-water'],
    );
    expect(water.score).toBe(0.8);
    expect(water.detail).toContain('in-stock(4)');
  });

  it('without a bound rack the zone hook still reads no-planogram-data (unchanged)', async () => {
    const provider = build(false);
    const [water] = await provider.contextFor(
      'tenant-1',
      { locationId: 'store-1', unitId: null, deviceId: null, shelfZoneId: 'zone-r1c1' },
      ['p-water'],
    );
    expect(water.score).toBe(0.5);
    expect(water.detail).toContain('zone:zone-r1c1(no-planogram-data)');
  });
});
