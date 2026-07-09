import { AuditLogService } from '../common/audit/audit-log.service';
import { PrismaService } from '../prisma/prisma.service';
import { CategoriesRepository } from './categories.repository';

describe('CategoriesRepository.update (in-transaction move validation)', () => {
  const auditLog = { record: jest.fn().mockResolvedValue(undefined) };
  const buildAuditEntry = jest.fn().mockReturnValue({
    tenantId: 'tenant-a',
    actorEmail: 'jane@tenant-a.example',
    action: 'UPDATE',
    entityType: 'ProductCategory',
  });

  // Small in-tenant tree used to resolve both the `before` lookup and the
  // ancestor walk. cat-2 is a child of cat-1.
  const tree: Record<string, { id: string; parentId: string | null }> = {
    'cat-1': { id: 'cat-1', parentId: null },
    'cat-2': { id: 'cat-2', parentId: 'cat-1' },
  };

  function buildTx() {
    return {
      $queryRaw: jest.fn().mockResolvedValue([1]),
      productCategory: {
        findFirst: jest.fn(({ where }: { where: { id: string } }) =>
          Promise.resolve(tree[where.id] ?? null),
        ),
        update: jest
          .fn()
          .mockImplementation(({ where, data }) =>
            Promise.resolve({ id: where.id, ...data }),
          ),
      },
    };
  }

  function buildRepository(tx: ReturnType<typeof buildTx>) {
    const prisma = {
      $transaction: (callback: (client: unknown) => unknown) => callback(tx),
    } as unknown as PrismaService;
    return new CategoriesRepository(
      prisma,
      auditLog as unknown as AuditLogService,
    );
  }

  beforeEach(() => {
    auditLog.record.mockClear();
  });

  it('takes the per-tenant advisory lock before validating a move', async () => {
    const tx = buildTx();
    const repository = buildRepository(tx);
    await repository.update(
      'tenant-a',
      'cat-2',
      { parentId: 'cat-1' },
      buildAuditEntry,
    );
    expect(tx.$queryRaw).toHaveBeenCalled();
  });

  it('rejects a move that would place a category under its own descendant', async () => {
    const tx = buildTx();
    const repository = buildRepository(tx);
    // Move cat-1 under cat-2, but cat-2 is already a child of cat-1 → cycle.
    await expect(
      repository.update(
        'tenant-a',
        'cat-1',
        { parentId: 'cat-2' },
        buildAuditEntry,
      ),
    ).resolves.toBe('cycle-detected');
    expect(tx.productCategory.update).not.toHaveBeenCalled();
    expect(auditLog.record).not.toHaveBeenCalled();
  });

  it('rejects a category set as its own parent', async () => {
    const tx = buildTx();
    const repository = buildRepository(tx);
    await expect(
      repository.update(
        'tenant-a',
        'cat-1',
        { parentId: 'cat-1' },
        buildAuditEntry,
      ),
    ).resolves.toBe('cycle-detected');
    expect(tx.productCategory.update).not.toHaveBeenCalled();
  });

  it('commits a valid move (no cycle)', async () => {
    const tx = buildTx();
    const repository = buildRepository(tx);
    const result = await repository.update(
      'tenant-a',
      'cat-2',
      { parentId: 'cat-1' },
      buildAuditEntry,
    );
    expect(tx.productCategory.update).toHaveBeenCalled();
    expect(auditLog.record).toHaveBeenCalledWith(expect.any(Object), tx);
    expect(result).toEqual(expect.objectContaining({ parentId: 'cat-1' }));
  });

  it('takes the per-category lock but skips the tree walk when the parent is not changing', async () => {
    const tx = buildTx();
    const repository = buildRepository(tx);
    await repository.update(
      'tenant-a',
      'cat-1',
      { name: 'Renamed' },
      buildAuditEntry,
    );
    // The per-category lock is taken for EVERY update (serializes with
    // delete()), but with no parent change there is no tree lock and no
    // ancestor walk — only the single `before` lookup.
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.productCategory.findFirst).toHaveBeenCalledTimes(1);
    expect(tx.productCategory.update).toHaveBeenCalled();
  });

  it('404-signals (null) when the category is not in this tenant', async () => {
    const tx = buildTx();
    const repository = buildRepository(tx);
    await expect(
      repository.update(
        'tenant-a',
        'cat-missing',
        { name: 'X' },
        buildAuditEntry,
      ),
    ).resolves.toBeNull();
    expect(tx.productCategory.update).not.toHaveBeenCalled();
  });
});

describe('CategoriesRepository.delete (update/delete serialization)', () => {
  const auditLog = { record: jest.fn().mockResolvedValue(undefined) };

  function buildRepository(tx: Record<string, unknown>) {
    const prisma = {
      $transaction: (callback: (client: unknown) => unknown) => callback(tx),
    } as unknown as PrismaService;
    return new CategoriesRepository(
      prisma,
      auditLog as unknown as AuditLogService,
    );
  }

  beforeEach(() => {
    auditLog.record.mockClear();
  });

  it('takes the per-category advisory lock BEFORE snapshotting the row', async () => {
    const existing = { id: 'cat-1', tenantId: 'tenant-a', name: 'Beverages' };
    const order: string[] = [];
    const tx = {
      $queryRaw: jest.fn(() => {
        order.push('lock');
        return Promise.resolve([1]);
      }),
      productCategory: {
        findFirst: jest.fn(() => {
          order.push('read');
          return Promise.resolve(existing);
        }),
        delete: jest.fn().mockResolvedValue(existing),
      },
    };
    const buildAuditEntry = jest.fn().mockReturnValue({ action: 'DELETE' });
    await buildRepository(tx).delete('tenant-a', 'cat-1', buildAuditEntry);

    // The lock is the SAME per-category lock update() takes, so a concurrent
    // PATCH cannot commit between this snapshot read and the delete, keeping
    // the audit `before` snapshot authoritative.
    expect(order).toEqual(['lock', 'read']);
    expect(buildAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'cat-1', name: 'Beverages' }),
    );
    expect(tx.productCategory.delete).toHaveBeenCalled();
    expect(auditLog.record).toHaveBeenCalledWith(expect.any(Object), tx);
  });

  it('404-signals (null) without deleting when not in this tenant', async () => {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([1]),
      productCategory: {
        findFirst: jest.fn().mockResolvedValue(null),
        delete: jest.fn(),
      },
    };
    const buildAuditEntry = jest.fn();
    await expect(
      buildRepository(tx).delete('tenant-a', 'cat-x', buildAuditEntry),
    ).resolves.toBeNull();
    expect(tx.productCategory.delete).not.toHaveBeenCalled();
  });
});
