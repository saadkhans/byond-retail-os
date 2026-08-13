import { DeviceStatus, DeviceType } from '@prisma/client';
import { AuditLogService } from '../common/audit/audit-log.service';
import { PrismaService } from '../prisma/prisma.service';
import { DevicesRepository } from './devices.repository';

describe('DevicesRepository (reparenting guard)', () => {
  const auditLog = { record: jest.fn().mockResolvedValue(undefined) };
  const buildAuditEntry = jest.fn().mockReturnValue({ action: 'AUDIT' });

  const before = {
    id: 'device-1',
    tenantId: 'tenant-a',
    unitId: 'unit-1',
    name: 'Shelf camera',
    type: DeviceType.CAMERA,
    status: DeviceStatus.ONLINE,
    serialNumber: 'SN-0001',
  };

  function buildRepository(tx: Record<string, unknown>) {
    const prisma = {
      $transaction: (callback: (client: unknown) => unknown) => callback(tx),
    } as unknown as PrismaService;
    return new DevicesRepository(
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
      device: {
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

  it('blocks a unit move while live video assets reference the device (no write)', async () => {
    const { tx, order } = buildTx(1);
    const result = await buildRepository(tx).update(
      'tenant-a',
      'device-1',
      { unitId: 'unit-2' },
      buildAuditEntry,
    );
    expect(result).toEqual({ rejection: 'has-video-assets', assetCount: 1 });
    // The count runs under the device advisory lock — the SAME lock
    // VideoAssetsRepository.createAsset() takes for every device-bound
    // upload and holds through its insert — so the device lock alone
    // serializes the check against concurrent uploads.
    expect(order).toEqual(['lock', 'read', 'asset-count']);
    expect(tx.device.update).not.toHaveBeenCalled();
    expect(auditLog.record).not.toHaveBeenCalled();
  });

  it('counts blocking assets tenant-scoped and deletedAt-null-filtered', async () => {
    const { tx } = buildTx(1);
    await buildRepository(tx).update(
      'tenant-a',
      'device-1',
      { unitId: 'unit-2' },
      buildAuditEntry,
    );
    // Soft-deleted assets must NOT block: the filter excludes them at the
    // query, and the count never crosses tenants.
    expect(tx.videoAsset.count).toHaveBeenCalledWith({
      where: { deviceId: 'device-1', tenantId: 'tenant-a', deletedAt: null },
    });
  });

  it('proceeds with a unit move when only soft-deleted assets remain (count 0)', async () => {
    const { tx } = buildTx(0);
    const result = await buildRepository(tx).update(
      'tenant-a',
      'device-1',
      { unitId: 'unit-2' },
      buildAuditEntry,
    );
    expect(result).toEqual(expect.objectContaining({ unitId: 'unit-2' }));
    expect(tx.device.update).toHaveBeenCalled();
    expect(auditLog.record).toHaveBeenCalledWith(expect.any(Object), tx);
  });

  it('an unchanged unitId proceeds without consulting video assets', async () => {
    const { tx } = buildTx(5);
    const result = await buildRepository(tx).update(
      'tenant-a',
      'device-1',
      { unitId: 'unit-1', name: 'Renamed camera' },
      buildAuditEntry,
    );
    expect(tx.videoAsset.count).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({ name: 'Renamed camera' }),
    );
    expect(tx.device.update).toHaveBeenCalled();
  });

  it('a non-unit update proceeds without consulting video assets', async () => {
    const { tx } = buildTx(5);
    await buildRepository(tx).update(
      'tenant-a',
      'device-1',
      { name: 'Renamed camera' },
      buildAuditEntry,
    );
    expect(tx.videoAsset.count).not.toHaveBeenCalled();
    expect(tx.device.update).toHaveBeenCalled();
  });
});
