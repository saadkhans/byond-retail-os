import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PlanogramService } from './planogram.service';

const TENANT = 'tenant-1';
const OTHER_TENANT = 'tenant-2';

type Row = Record<string, unknown>;

/** In-memory prisma stub over the two planogram tables plus read-only
 *  location/product fixtures. */
function buildHarness(options: {
  locations?: { id: string; tenantId: string }[];
  products?: { id: string; tenantId: string; sku: string }[];
} = {}) {
  let seq = 0;
  const nextId = (prefix: string) => `${prefix}-${(seq += 1)}`;
  const racks: Row[] = [];
  const cells: Row[] = [];
  const locations = options.locations ?? [{ id: 'store-1', tenantId: TENANT }];
  const products = options.products ?? [
    { id: 'prod-a', tenantId: TENANT, sku: 'SKU-A' },
    { id: 'prod-b', tenantId: TENANT, sku: 'SKU-B' },
  ];

  const whereMatch = (row: Row, where: Row): boolean =>
    Object.entries(where).every(([key, cond]) => {
      if (cond !== null && typeof cond === 'object' && 'in' in (cond as object)) {
        return ((cond as { in: unknown[] }).in ?? []).includes(row[key]);
      }
      return row[key] === cond;
    });

  const txQueryRaw = jest.fn(async () => []);
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const prisma: any = {
    location: {
      findFirst: jest.fn(async (args: { where: Row }) => {
        const row = locations.find((l) => whereMatch(l as never, args.where));
        return row ? { id: row.id } : null;
      }),
    },
    product: {
      findMany: jest.fn(async (args: { where: Row }) =>
        products
          .filter((p) => whereMatch(p as never, args.where))
          .map((p) => ({ id: p.id, sku: p.sku })),
      ),
    },
    planogramRack: {
      findFirst: jest.fn(async (args: { where: Row }) => {
        const hits = racks
          .filter((r) => whereMatch(r, args.where))
          .sort((a, b) => (b.version as number) - (a.version as number));
        return hits[0] ?? null;
      }),
      findMany: jest.fn(async (args: { where: Row }) =>
        racks.filter((r) => whereMatch(r, args.where)),
      ),
      create: jest.fn(async (args: { data: Row }) => {
        const row = {
          id: nextId('rack'),
          status: 'ACTIVE',
          activeFrom: new Date('2026-09-03T09:00:00Z'),
          activeTo: null,
          name: null,
          createdAt: new Date('2026-09-03T09:00:00Z'),
          ...args.data,
        };
        racks.push(row);
        return row;
      }),
      updateMany: jest.fn(async (args: { where: Row; data: Row }) => {
        const hits = racks.filter((r) => whereMatch(r, args.where));
        for (const row of hits) {
          Object.assign(row, args.data);
        }
        return { count: hits.length };
      }),
    },
    planogramCellAssignment: {
      createMany: jest.fn(async (args: { data: Row[] }) => {
        for (const data of args.data) {
          cells.push({ id: nextId('cell'), ...data });
        }
        return { count: args.data.length };
      }),
      findMany: jest.fn(async (args: { where: Row }) =>
        cells.filter((c) => whereMatch(c, args.where)),
      ),
    },
  };
  prisma.$transaction = jest.fn(
    async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ ...prisma, $queryRaw: txQueryRaw }),
  );
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const service = new PlanogramService(prisma as unknown as PrismaService);
  return { service, prisma, racks, cells, txQueryRaw };
}

const BASE_INPUT = {
  locationId: 'store-1',
  rackCode: 'r1',
  rows: 4,
  columns: 4,
  cells: [
    { rowIndex: 1, columnIndex: 2, productId: 'prod-a' }, // B3
    { rowIndex: 1, columnIndex: 3, productId: 'prod-b' }, // B4
  ],
};

describe('PlanogramService.publishRack', () => {
  it('publishes a rack with server-derived cell codes and SKU snapshots', async () => {
    const { service, txQueryRaw } = buildHarness();
    const view = await service.publishRack(TENANT, BASE_INPUT, 'user-1');
    expect(view.rackCode).toBe('R1'); // uppercased
    expect(view.version).toBe(1);
    expect(view.cells).toEqual([
      expect.objectContaining({ cellCode: 'B3', sku: 'SKU-A' }),
      expect.objectContaining({ cellCode: 'B4', sku: 'SKU-B' }),
    ]);
    // Publication runs under the per-rack advisory lock.
    expect(txQueryRaw).toHaveBeenCalledTimes(1);
  });

  it('version-bumps on re-publish and keeps the predecessor queryable', async () => {
    const { service, racks } = buildHarness();
    const first = await service.publishRack(TENANT, BASE_INPUT);
    const second = await service.publishRack(TENANT, BASE_INPUT);
    expect(second.version).toBe(2);
    expect(second.rackId).not.toBe(first.rackId);
    const predecessor = racks.find((row) => row.id === first.rackId);
    // Deactivated — NEVER deleted or rewritten (old evidence keeps its
    // version reference).
    expect(predecessor?.status).toBe('INACTIVE');
    expect(predecessor?.activeTo).not.toBeNull();
  });

  it('rejects a store outside the tenant', async () => {
    const { service } = buildHarness({
      locations: [{ id: 'store-1', tenantId: OTHER_TENANT }],
    });
    await expect(service.publishRack(TENANT, BASE_INPUT)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('rejects a product outside the tenant', async () => {
    const { service } = buildHarness({
      products: [{ id: 'prod-a', tenantId: OTHER_TENANT, sku: 'SKU-A' }],
    });
    await expect(
      service.publishRack(TENANT, {
        ...BASE_INPUT,
        cells: [{ rowIndex: 0, columnIndex: 0, productId: 'prod-a' }],
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it.each([
    ['out-of-grid cell', { cells: [{ rowIndex: 4, columnIndex: 0, productId: 'prod-a' }] }],
    ['bad rack code', { rackCode: 'bad code!' }],
    ['zero rows', { rows: 0 }],
  ])('rejects %s', async (_label, over) => {
    const { service } = buildHarness();
    await expect(
      service.publishRack(TENANT, { ...BASE_INPUT, ...over } as never),
    ).rejects.toThrow(BadRequestException);
  });
});

describe('PlanogramService.narrowCandidates', () => {
  it('narrows to the detected cell using the ACTIVE rack version', async () => {
    const { service } = buildHarness();
    await service.publishRack(TENANT, BASE_INPUT);
    const narrowed = await service.narrowCandidates(TENANT, {
      locationId: 'store-1',
      rackCode: 'R1',
      normalizedRackX: (2 + 0.5) / 4, // column 2 → B3
      normalizedRackY: (1 + 0.5) / 4,
    });
    expect(narrowed?.version).toBe(1);
    expect(narrowed?.cellSkus).toEqual(['SKU-A']);
    expect(narrowed?.adjacentSkus).toEqual(['SKU-B']);
  });

  it('returns null (PLANOGRAM_NOT_CONFIGURED upstream) when no ACTIVE rack exists', async () => {
    const { service } = buildHarness();
    const narrowed = await service.narrowCandidates(TENANT, {
      locationId: 'store-1',
      rackCode: 'R1',
      normalizedRackX: 0.5,
      normalizedRackY: 0.5,
    });
    expect(narrowed).toBeNull();
  });

  it('is tenant-isolated: tenant B cannot use tenant A racks', async () => {
    const { service } = buildHarness();
    await service.publishRack(TENANT, BASE_INPUT);
    const narrowed = await service.narrowCandidates(OTHER_TENANT, {
      locationId: 'store-1',
      rackCode: 'R1',
      normalizedRackX: 0.6,
      normalizedRackY: 0.4,
    });
    expect(narrowed).toBeNull();
  });
});

describe('PlanogramService.deactivateRack', () => {
  it('deactivates only within the tenant', async () => {
    const { service } = buildHarness();
    const view = await service.publishRack(TENANT, BASE_INPUT);
    await expect(
      service.deactivateRack(OTHER_TENANT, view.rackId),
    ).rejects.toThrow(NotFoundException);
    await service.deactivateRack(TENANT, view.rackId);
    expect(await service.listRacks(TENANT)).toHaveLength(0);
  });
});
