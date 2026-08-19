import { LocationsRepository } from './locations.repository';

/**
 * Codex P1 (Phase 15 round): destructive location writes must carry the
 * tenant IN the write predicate (id_tenantId composite key) — never rely
 * only on the prior tenant-scoped lookup.
 */
function buildHarness(existing: Record<string, unknown> | null) {
  const update = jest.fn(async (args: { where: unknown; data: unknown }) => ({
    ...(existing ?? {}),
    ...(args.data as Record<string, unknown>),
  }));
  const del = jest.fn(async () => existing);
  const tx = {
    $queryRaw: jest.fn(async () => []),
    location: {
      findFirst: jest.fn(async () => existing),
      update,
      delete: del,
    },
  };
  const prisma = {
    $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) =>
      fn(tx),
    ),
  };
  const audit = { record: jest.fn(async () => undefined) };
  const repository = new LocationsRepository(
    prisma as never,
    audit as never,
  );
  return { repository, tx, audit };
}

const LOCATION = { id: 'store-1', tenantId: 'tenant-a', name: 'Store 1' };
const auditEntry = () => ({}) as never;

describe('LocationsRepository destructive writes are tenant-scoped', () => {
  it('update writes through the id_tenantId composite key', async () => {
    const { repository, tx } = buildHarness(LOCATION);
    await repository.update(
      'tenant-a',
      'store-1',
      { name: 'Renamed' },
      auditEntry,
    );
    expect(tx.location.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id_tenantId: { id: 'store-1', tenantId: 'tenant-a' } },
      }),
    );
  });

  it('delete removes through the id_tenantId composite key', async () => {
    const { repository, tx } = buildHarness(LOCATION);
    await repository.delete('tenant-a', 'store-1', auditEntry);
    expect(tx.location.delete).toHaveBeenCalledWith({
      where: { id_tenantId: { id: 'store-1', tenantId: 'tenant-a' } },
    });
  });

  it('a foreign tenant finds nothing and never reaches the write', async () => {
    const { repository, tx } = buildHarness(null);
    const updated = await repository.update(
      'tenant-b',
      'store-1',
      { name: 'X' },
      auditEntry,
    );
    expect(updated).toBeNull();
    expect(tx.location.update).not.toHaveBeenCalled();
    const deleted = await repository.delete('tenant-b', 'store-1', auditEntry);
    expect(deleted).toBeNull();
    expect(tx.location.delete).not.toHaveBeenCalled();
  });
});
