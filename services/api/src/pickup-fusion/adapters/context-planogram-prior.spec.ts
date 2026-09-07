import { PrismaContextSignalProvider } from './context-fusion-inventory';

/**
 * Phase 22 — the planogram prior is a SOFT prior: a SKU assigned to the
 * clip's bound rack is scored like an in-stock product (0.8), never
 * higher, and only when the product is ACTIVE. Without a rack the
 * provider is byte-for-byte the pre-Phase-22 provider.
 */
describe('PrismaContextSignalProvider — planogram rack prior (Phase 22)', () => {
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

  it('rack SKUs get the in-stock-equivalent prior and a rack detail; others are unchanged', async () => {
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
    expect(bySku.get('WATER')?.score).toBe(0.8);
    expect(bySku.get('WATER')?.detail).toContain('planogram:rack(SHELF-2X2)');
    expect(bySku.get('WATER')?.detail).toContain('zone:zone-r2c1(planogram-scoped)');
    expect(bySku.get('CAN')?.score).toBe(0.5);
    expect(bySku.get('CAN')?.detail).not.toContain('planogram:rack');
    // Inactive products never gain from the planogram.
    expect(bySku.get('OLD')?.score).toBe(0.1);
    expect(bySku.get('OLD')?.detail).not.toContain('planogram:rack');
  });

  it('never exceeds the in-stock boost when the product is also in stock', async () => {
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
