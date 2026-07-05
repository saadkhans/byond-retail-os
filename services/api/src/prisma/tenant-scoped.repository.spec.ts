import { TenantIdRequiredError } from '../common/errors/domain.errors';
import { UsersRepository } from '../users/users.repository';
import { PrismaService } from './prisma.service';
import { TenantScopedRepository } from './tenant-scoped.repository';

class TestRepository extends TenantScopedRepository {
  scopePublic<T extends object>(tenantId: string, where?: T) {
    return this.scope(tenantId, where);
  }
  requireTenantIdPublic(tenantId: string) {
    return this.requireTenantId(tenantId);
  }
}

describe('TenantScopedRepository (tenant isolation contract)', () => {
  const repo = new TestRepository({} as PrismaService);

  it('merges tenantId into every where clause', () => {
    expect(repo.scopePublic('tenant-a', { id: 'x' })).toEqual({
      id: 'x',
      tenantId: 'tenant-a',
    });
  });

  it('scopes even when no filter is given', () => {
    expect(repo.scopePublic('tenant-a')).toEqual({ tenantId: 'tenant-a' });
  });

  it('a caller-supplied tenantId in the filter can never win over the scope', () => {
    expect(
      repo.scopePublic('tenant-a', { tenantId: 'tenant-b', id: 'x' }),
    ).toEqual({ id: 'x', tenantId: 'tenant-a' });
  });

  it.each(['', '   '])(
    'throws instead of treating a blank tenantId (%j) as a wildcard',
    (blank) => {
      expect(() => repo.scopePublic(blank)).toThrow(TenantIdRequiredError);
    },
  );

  it('throws for non-string tenantId values', () => {
    expect(() =>
      repo.requireTenantIdPublic(undefined as unknown as string),
    ).toThrow(TenantIdRequiredError);
    expect(() =>
      repo.requireTenantIdPublic(null as unknown as string),
    ).toThrow(TenantIdRequiredError);
  });
});

describe('UsersRepository (cross-tenant isolation)', () => {
  let prisma: {
    user: {
      create: jest.Mock;
      findFirst: jest.Mock;
      findMany: jest.Mock;
    };
    $transaction: jest.Mock;
  };
  let auditLog: { record: jest.Mock };
  let repo: UsersRepository;

  beforeEach(() => {
    prisma = {
      user: {
        create: jest.fn().mockResolvedValue({ id: 'user-1' }),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      },
      $transaction: jest.fn(async (callback: (tx: unknown) => unknown) =>
        callback(prisma),
      ),
    };
    auditLog = { record: jest.fn().mockResolvedValue(undefined) };
    repo = new UsersRepository(
      prisma as unknown as PrismaService,
      auditLog as never,
    );
  });

  it('always injects tenantId and TENANT userType on create, and audits in-transaction', async () => {
    await repo.create(
      'tenant-a',
      {
        email: 'a@example.com',
        firstName: 'A',
        lastName: 'B',
      },
      () => ({
        tenantId: 'tenant-a',
        actorEmail: 'system@byond.internal',
        action: 'CREATE' as never,
        entityType: 'User',
      }),
    );

    expect(prisma.user.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: 'tenant-a',
        userType: 'TENANT',
      }),
    });
    expect(auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-a' }),
      prisma,
    );
  });

  it("tenant A's lookup of tenant B's record id is scoped to tenant A", async () => {
    await repo.findById('tenant-a', 'user-belonging-to-tenant-b');

    expect(prisma.user.findFirst).toHaveBeenCalledWith({
      where: { id: 'user-belonging-to-tenant-b', tenantId: 'tenant-a' },
    });
  });

  it('list queries are always tenant-filtered', async () => {
    await repo.findMany('tenant-a');

    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-a' },
    });
  });

  it('refuses to run any query without a tenantId', () => {
    // The guard throws synchronously — before any query is even constructed.
    expect(() => repo.findMany('')).toThrow(TenantIdRequiredError);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it('refuses to create without a tenantId, before opening a transaction', () => {
    expect(() =>
      repo.create(
        '',
        { email: 'a@example.com', firstName: 'A', lastName: 'B' },
        () => ({
          tenantId: null,
          actorEmail: 'system@byond.internal',
          action: 'CREATE' as never,
          entityType: 'User',
        }),
      ),
    ).toThrow(TenantIdRequiredError);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
