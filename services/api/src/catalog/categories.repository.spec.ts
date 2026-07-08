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

  it('does not lock or walk when the parent is not changing', async () => {
    const tx = buildTx();
    const repository = buildRepository(tx);
    await repository.update(
      'tenant-a',
      'cat-1',
      { name: 'Renamed' },
      buildAuditEntry,
    );
    expect(tx.$queryRaw).not.toHaveBeenCalled();
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
