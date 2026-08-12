import {
  FUSION_WEIGHTS,
  PrismaContextSignalProvider,
  WeightedCandidateFusion,
} from './context-fusion-inventory';
import { PrismaService } from '../../prisma/prisma.service';
import { CandidateSignal } from '../ports';

function signal(sku: string, score: number, detail?: string): CandidateSignal {
  return { productId: `p-${sku}`, sku, score, ...(detail ? { detail } : {}) };
}

const PRODUCT_META = new Map(
  ['A', 'B'].map((sku) => [`p-${sku}`, { sku, name: `Product ${sku}` }]),
);

describe('PrismaContextSignalProvider', () => {
  const TENANT = 't-1';
  const STORE = 'loc-1';

  function makePrisma(overrides: {
    products?: { id: string; sku: string; categoryId: string | null; status: string }[];
    probeRow?: { id: string } | null;
    stockRows?: { productId: string; quantity: number }[];
  }) {
    return {
      product: {
        findMany: jest.fn().mockResolvedValue(
          overrides.products ?? [
            { id: 'p-A', sku: 'A', categoryId: null, status: 'ACTIVE' },
          ],
        ),
      },
      inventoryLevel: {
        findFirst: jest.fn().mockResolvedValue(overrides.probeRow ?? null),
        findMany: jest.fn().mockResolvedValue(overrides.stockRows ?? []),
      },
    };
  }

  it('reads inventory as an existence probe plus an IN-filtered candidate read, never the whole store', async () => {
    const prisma = makePrisma({
      probeRow: { id: 'inv-1' },
      stockRows: [{ productId: 'p-A', quantity: 3 }],
    });
    const provider = new PrismaContextSignalProvider(prisma as unknown as PrismaService);
    const signals = await provider.contextFor(
      TENANT,
      { locationId: STORE, unitId: null, deviceId: null, shelfZoneId: null },
      ['p-A', 'p-B'],
    );
    expect(prisma.inventoryLevel.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.inventoryLevel.findFirst).toHaveBeenCalledWith({
      where: { tenantId: TENANT, locationId: STORE },
      select: { id: true },
    });
    expect(prisma.inventoryLevel.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.inventoryLevel.findMany).toHaveBeenCalledWith({
      where: {
        tenantId: TENANT,
        locationId: STORE,
        productId: { in: ['p-A', 'p-B'] },
      },
      select: { productId: true, quantity: true },
    });
    expect(signals).toEqual([
      { productId: 'p-A', sku: 'A', score: 0.8, detail: 'in-stock(3)' },
    ]);
  });

  it('keeps out-of-stock and not-stocked priors when the store has inventory rows', async () => {
    const prisma = makePrisma({
      products: [
        { id: 'p-A', sku: 'A', categoryId: null, status: 'ACTIVE' },
        { id: 'p-B', sku: 'B', categoryId: null, status: 'ACTIVE' },
      ],
      // Probe hits a row for some OTHER product: the store is not in lab
      // mode, so an absent candidate row means not-stocked, not neutral.
      probeRow: { id: 'inv-other' },
      stockRows: [{ productId: 'p-A', quantity: 0 }],
    });
    const provider = new PrismaContextSignalProvider(prisma as unknown as PrismaService);
    const signals = await provider.contextFor(
      TENANT,
      { locationId: STORE, unitId: null, deviceId: null, shelfZoneId: null },
      ['p-A', 'p-B'],
    );
    expect(signals).toEqual([
      { productId: 'p-A', sku: 'A', score: 0.35, detail: 'out-of-stock' },
      { productId: 'p-B', sku: 'B', score: 0.2, detail: 'not-stocked-at-store' },
    ]);
  });

  it('stays neutral when the probe finds no inventory at the store (lab mode)', async () => {
    const prisma = makePrisma({ probeRow: null, stockRows: [] });
    const provider = new PrismaContextSignalProvider(prisma as unknown as PrismaService);
    const signals = await provider.contextFor(
      TENANT,
      { locationId: STORE, unitId: null, deviceId: null, shelfZoneId: null },
      ['p-A'],
    );
    expect(signals).toEqual([
      { productId: 'p-A', sku: 'A', score: 0.5, detail: 'store-has-no-inventory-data' },
    ]);
  });

  it('skips inventory reads entirely without a store context', async () => {
    const prisma = makePrisma({});
    const provider = new PrismaContextSignalProvider(prisma as unknown as PrismaService);
    const signals = await provider.contextFor(
      TENANT,
      { locationId: null, unitId: null, deviceId: null, shelfZoneId: null },
      ['p-A'],
    );
    expect(prisma.inventoryLevel.findFirst).not.toHaveBeenCalled();
    expect(prisma.inventoryLevel.findMany).not.toHaveBeenCalled();
    expect(signals).toEqual([
      { productId: 'p-A', sku: 'A', score: 0.5, detail: 'store-has-no-inventory-data' },
    ]);
  });
});

describe('WeightedCandidateFusion', () => {
  it('counts each signal source once per candidate: duplicate barcode rows contribute the max, not the sum', () => {
    // Two registered barcode reads of the SAME product (crop frame + peak
    // frame). Summing would yield 2 x 0.35 = 0.70 from one signal class —
    // enough to clear the 0.42 auto threshold alone. The max rule keeps it
    // at 0.35.
    const fused = new WeightedCandidateFusion().fuse(
      {
        barcode: [signal('A', 1, 'crop-frame'), signal('A', 1, 'peak-frame')],
        classical: [],
        retrieval: [],
        ocr: [],
        context: [],
      },
      PRODUCT_META,
    );
    expect(fused).toHaveLength(1);
    expect(fused[0].fusedScore).toBe(FUSION_WEIGHTS.barcode);
    // Both rows are still retained verbatim as evidence.
    expect(fused[0].signals).toHaveLength(2);
    expect(fused[0].signals.map((s) => s.detail)).toEqual([
      'crop-frame',
      'peak-frame',
    ]);
  });

  it('keeps the max score when duplicate rows from one source differ', () => {
    const fused = new WeightedCandidateFusion().fuse(
      {
        barcode: [],
        classical: [signal('A', 0.4), signal('A', 0.9)],
        retrieval: [],
        ocr: [],
        context: [],
      },
      PRODUCT_META,
    );
    expect(fused[0].fusedScore).toBe(
      Math.round(FUSION_WEIGHTS.classical * 0.9 * 10_000) / 10_000,
    );
  });

  it('still sums across DISTINCT sources for the same candidate', () => {
    const fused = new WeightedCandidateFusion().fuse(
      {
        barcode: [signal('A', 1)],
        classical: [signal('A', 0.5)],
        retrieval: [],
        ocr: [],
        context: [signal('A', 0.5), signal('B', 0.5)],
      },
      PRODUCT_META,
    );
    const expected =
      FUSION_WEIGHTS.barcode * 1 +
      FUSION_WEIGHTS.classical * 0.5 +
      FUSION_WEIGHTS.context * 0.5;
    expect(fused[0].sku).toBe('A');
    expect(fused[0].fusedScore).toBe(Math.round(expected * 10_000) / 10_000);
  });
});
