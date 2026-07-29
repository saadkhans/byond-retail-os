import { RetailUnitStatus, RetailUnitType } from '@prisma/client';
import { AuditLogService } from '../common/audit/audit-log.service';
import { PrismaService } from '../prisma/prisma.service';
import { UnitsRepository } from './units.repository';

describe('UnitsRepository (reparenting guard)', () => {
  const auditLog = { record: jest.fn().mockResolvedValue(undefined) };
  const buildAuditEntry = jest.fn().mockReturnValue({ action: 'AUDIT' });

  const before = {
    id: 'unit-1',
    tenantId: 'tenant-a',
    locationId: 'loc-a1',
    code: 'FRIDGE-001',
    name: 'Entrance Smart Fridge',
    type: RetailUnitType.SMART_FRIDGE,
    status: RetailUnitStatus.ACTIVE,
    placement: null,
  };

  function buildRepository(tx: Record<string, unknown>) {
    const prisma = {
      $transaction: (callback: (client: unknown) => unknown) => callback(tx),
    } as unknown as PrismaService;
    return new UnitsRepository(
      prisma,
      auditLog as unknown as AuditLogService,
    );
  }

  function buildTx(assetCount: number) {
    const order: string[] = [];
    const tx = {
      $queryRaw: jest.fn(() => {
        order.push('lock');
        return Promise.resolve([1]);
      }),
      retailUnit: {
        findFirst: jest.fn(() => {
          order.push('read');
          return Promise.resolve(before);
        }),
        update: jest
          .fn()
          .mockImplementation(({ data }) =>
            Promise.resolve({ ...before, ...data }),
          ),
      },
      videoAsset: {
        count: jest.fn(() => {
          order.push('asset-count');
          return Promise.resolve(assetCount);
        }),
      },
    };
    return { tx, order };
  }

  beforeEach(() => {
    auditLog.record.mockClear();
    buildAuditEntry.mockClear();
  });

  it('blocks a store move while live video assets reference the unit (no write)', async () => {
    const { tx, order } = buildTx(2);
    const result = await buildRepository(tx).update(
      'tenant-a',
      'unit-1',
      { locationId: 'loc-b9' },
      buildAuditEntry,
    );
    expect(result).toEqual({ rejection: 'has-video-assets', assetCount: 2 });
    // The count runs under the unit advisory lock — the SAME lock
    // VideoAssetsRepository.createAsset() holds through its insert — so a
    // concurrent upload cannot land between the count and the write.
    expect(order).toEqual(['lock', 'read', 'asset-count']);
    expect(tx.retailUnit.update).not.toHaveBeenCalled();
    expect(auditLog.record).not.toHaveBeenCalled();
  });

  it('counts blocking assets tenant-scoped and deletedAt-null-filtered', async () => {
    const { tx } = buildTx(1);
    await buildRepository(tx).update(
      'tenant-a',
      'unit-1',
      { locationId: 'loc-b9' },
      buildAuditEntry,
    );
    // Soft-deleted assets must NOT block: the filter excludes them at the
    // query, and the count never crosses tenants.
    expect(tx.videoAsset.count).toHaveBeenCalledWith({
      where: { unitId: 'unit-1', tenantId: 'tenant-a', deletedAt: null },
    });
  });

  it('proceeds with a store move when only soft-deleted assets remain (count 0)', async () => {
    const { tx } = buildTx(0);
    const result = await buildRepository(tx).update(
      'tenant-a',
      'unit-1',
      { locationId: 'loc-b9' },
      buildAuditEntry,
    );
    expect(result).toEqual(expect.objectContaining({ locationId: 'loc-b9' }));
    expect(tx.retailUnit.update).toHaveBeenCalled();
    expect(auditLog.record).toHaveBeenCalledWith(expect.any(Object), tx);
  });

  it('an unchanged locationId proceeds without consulting video assets', async () => {
    const { tx } = buildTx(5);
    const result = await buildRepository(tx).update(
      'tenant-a',
      'unit-1',
      { locationId: 'loc-a1', name: 'Renamed Fridge' },
      buildAuditEntry,
    );
    expect(tx.videoAsset.count).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({ name: 'Renamed Fridge' }),
    );
    expect(tx.retailUnit.update).toHaveBeenCalled();
  });

  it('a non-location update proceeds without consulting video assets', async () => {
    const { tx } = buildTx(5);
    await buildRepository(tx).update(
      'tenant-a',
      'unit-1',
      { name: 'Renamed Fridge' },
      buildAuditEntry,
    );
    expect(tx.videoAsset.count).not.toHaveBeenCalled();
    expect(tx.retailUnit.update).toHaveBeenCalled();
  });
});
