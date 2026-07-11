import { AuditLogService } from '../common/audit/audit-log.service';
import { PrismaService } from '../prisma/prisma.service';
import { BrandsRepository } from './brands.repository';

describe('BrandsRepository (update/delete serialization)', () => {
  const auditLog = { record: jest.fn().mockResolvedValue(undefined) };
  const buildAuditEntry = jest.fn().mockReturnValue({ action: 'AUDIT' });

  function buildRepository(tx: Record<string, unknown>) {
    const prisma = {
      $transaction: (callback: (client: unknown) => unknown) => callback(tx),
    } as unknown as PrismaService;
    return new BrandsRepository(
      prisma,
      auditLog as unknown as AuditLogService,
    );
  }

  beforeEach(() => {
    auditLog.record.mockClear();
  });

  it('update takes the per-brand advisory lock BEFORE reading the row', async () => {
    const before = { id: 'brand-1', tenantId: 'tenant-a', name: 'Acme' };
    const order: string[] = [];
    const tx = {
      $queryRaw: jest.fn(() => {
        order.push('lock');
        return Promise.resolve([1]);
      }),
      brand: {
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
    };
    await buildRepository(tx).update(
      'tenant-a',
      'brand-1',
      { name: 'Acme Foods' },
      buildAuditEntry,
    );
    // Lock precedes the snapshot read, so a concurrent delete cannot interleave.
    expect(order).toEqual(['lock', 'read']);
    expect(tx.brand.update).toHaveBeenCalled();
  });

  it('delete takes the SAME per-brand lock BEFORE snapshotting the row', async () => {
    const existing = { id: 'brand-1', tenantId: 'tenant-a', name: 'Acme' };
    const order: string[] = [];
    const tx = {
      $queryRaw: jest.fn(() => {
        order.push('lock');
        return Promise.resolve([1]);
      }),
      brand: {
        findFirst: jest.fn(() => {
          order.push('read');
          return Promise.resolve(existing);
        }),
        delete: jest.fn().mockResolvedValue(existing),
      },
    };
    await buildRepository(tx).delete('tenant-a', 'brand-1', buildAuditEntry);

    // Same lock ordering as update() → the DELETE audit `before` snapshot can
    // never become stale relative to the row removed.
    expect(order).toEqual(['lock', 'read']);
    expect(buildAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'brand-1', name: 'Acme' }),
    );
    expect(tx.brand.delete).toHaveBeenCalled();
    expect(auditLog.record).toHaveBeenCalledWith(expect.any(Object), tx);
  });

  it('delete 404-signals (null) without deleting when not in this tenant', async () => {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([1]),
      brand: {
        findFirst: jest.fn().mockResolvedValue(null),
        delete: jest.fn(),
      },
    };
    await expect(
      buildRepository(tx).delete('tenant-a', 'brand-x', buildAuditEntry),
    ).resolves.toBeNull();
    expect(tx.brand.delete).not.toHaveBeenCalled();
  });
});
