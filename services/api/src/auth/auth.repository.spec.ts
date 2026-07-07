import { TenantStatus, UserStatus, UserType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SAFE_USER_SELECT } from '../users/users.repository';
import { AuthRepository } from './auth.repository';

describe('AuthRepository (tenant-status enforcement)', () => {
  const tenantUser = {
    id: 'user-1',
    tenantId: 'tenant-a',
    userType: UserType.TENANT,
    email: 'jane@tenant-a.example',
    status: UserStatus.ACTIVE,
  };
  const platformUser = {
    id: 'admin-1',
    tenantId: null,
    userType: UserType.PLATFORM,
    email: 'admin@byond.local',
    status: UserStatus.ACTIVE,
  };

  let prisma: {
    user: {
      findFirst: jest.Mock;
      findUnique: jest.Mock;
      updateMany: jest.Mock;
    };
    $transaction: jest.Mock;
    $queryRaw: jest.Mock;
  };
  let auditLog: { record: jest.Mock };
  let repository: AuthRepository;

  beforeEach(() => {
    prisma = {
      user: {
        findFirst: jest.fn(),
        findUnique: jest.fn().mockResolvedValue(tenantUser),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest.fn(async (callback: (tx: unknown) => unknown) =>
        callback(prisma),
      ),
      // Tenant row lock inside markLoggedIn — ACTIVE by default.
      $queryRaw: jest
        .fn()
        .mockResolvedValue([{ status: TenantStatus.ACTIVE }]),
    };
    auditLog = { record: jest.fn().mockResolvedValue(undefined) };
    repository = new AuthRepository(
      prisma as unknown as PrismaService,
      auditLog as never,
    );
  });

  it('resolves an ACTIVE user inside an ACTIVE tenant', async () => {
    prisma.user.findFirst.mockResolvedValue({
      ...tenantUser,
      tenant: { status: TenantStatus.ACTIVE },
    });

    const result = await repository.findActiveById('user-1');

    expect(result).toEqual(expect.objectContaining({ id: 'user-1' }));
    // The joined relation is stripped from the returned record.
    expect(
      (result as unknown as Record<string, unknown>).tenant,
    ).toBeUndefined();
    expect(prisma.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'user-1', status: UserStatus.ACTIVE },
      }),
    );
  });

  it('token authentication never selects the credential hash', async () => {
    prisma.user.findFirst.mockResolvedValue({
      ...tenantUser,
      tenant: { status: TenantStatus.ACTIVE },
    });

    await repository.findActiveById('user-1');

    const query = prisma.user.findFirst.mock.calls[0][0] as {
      select?: Record<string, unknown>;
    };
    expect(query.select).toEqual({
      ...SAFE_USER_SELECT,
      tenant: { select: { status: true } },
    });
    expect(query.select).not.toHaveProperty('passwordHash');
  });

  it.each([
    TenantStatus.PENDING,
    TenantStatus.SUSPENDED,
    TenantStatus.ARCHIVED,
  ])('rejects an ACTIVE user whose tenant is %s', async (status) => {
    prisma.user.findFirst.mockResolvedValue({
      ...tenantUser,
      tenant: { status },
    });

    await expect(repository.findActiveById('user-1')).resolves.toBeNull();
    await expect(
      repository.findByEmail('jane@tenant-a.example'),
    ).resolves.toBeNull();
  });

  it('fails closed when a tenant user has no tenant row at all', async () => {
    prisma.user.findFirst.mockResolvedValue({ ...tenantUser, tenant: null });
    await expect(repository.findActiveById('user-1')).resolves.toBeNull();
  });

  it('platform users authenticate without any tenant requirement', async () => {
    prisma.user.findFirst.mockResolvedValue({ ...platformUser, tenant: null });

    await expect(repository.findActiveById('admin-1')).resolves.toEqual(
      expect.objectContaining({ id: 'admin-1' }),
    );
  });

  it('returns null when the user itself is missing', async () => {
    prisma.user.findFirst.mockResolvedValue(null);
    await expect(repository.findActiveById('ghost')).resolves.toBeNull();
  });

  describe('markLoggedIn (write-bound active check + atomic audit)', () => {
    const buildAuditEntry = jest.fn().mockReturnValue({
      tenantId: 'tenant-a',
      actorEmail: 'jane@tenant-a.example',
      action: 'LOGIN',
      entityType: 'Auth',
    });

    beforeEach(() => buildAuditEntry.mockClear());

    it('binds the ACTIVE user/tenant condition to the WRITE itself', async () => {
      const result = await repository.markLoggedIn('user-1', buildAuditEntry);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      // Conditional updateMany: the predicate is evaluated at write time —
      // no separate read that a concurrent suspension could invalidate.
      expect(prisma.user.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'user-1',
          status: UserStatus.ACTIVE,
          OR: [
            { userType: UserType.PLATFORM, tenantId: null },
            {
              userType: UserType.TENANT,
              tenant: { status: TenantStatus.ACTIVE },
            },
          ],
        },
        data: { lastLoginAt: expect.any(Date) },
      });
      // Audit written through the SAME transaction client.
      expect(auditLog.record).toHaveBeenCalledWith(
        buildAuditEntry.mock.results[0].value,
        prisma,
      );
      expect(result).toEqual(expect.objectContaining({ id: 'user-1' }));
    });

    it('locks the tenant row (FOR SHARE) before recording a tenant login', async () => {
      await repository.markLoggedIn('user-1', buildAuditEntry);

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      const sql = (
        prisma.$queryRaw.mock.calls[0][0] as ReadonlyArray<string>
      ).join('?');
      expect(sql).toContain('FROM "Tenant"');
      expect(sql).toContain('FOR SHARE');
    });

    it('rolls the login back when the tenant is suspended at lock time', async () => {
      prisma.$queryRaw.mockResolvedValue([
        { status: TenantStatus.SUSPENDED },
      ]);

      await expect(
        repository.markLoggedIn('user-1', buildAuditEntry),
      ).resolves.toBeNull();
      // The throw escaped the $transaction callback — with a real database
      // Prisma rolls the lastLoginAt update back; no audit row is written.
      expect(auditLog.record).not.toHaveBeenCalled();
    });

    it('rolls the login back when the tenant row is missing at lock time', async () => {
      prisma.$queryRaw.mockResolvedValue([]);

      await expect(
        repository.markLoggedIn('user-1', buildAuditEntry),
      ).resolves.toBeNull();
      expect(auditLog.record).not.toHaveBeenCalled();
    });

    it('platform users take no tenant lock', async () => {
      prisma.user.findUnique.mockResolvedValue(platformUser);

      const result = await repository.markLoggedIn(
        'admin-1',
        buildAuditEntry,
      );

      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      expect(result).toEqual(expect.objectContaining({ id: 'admin-1' }));
    });

    it('rejects when the conditional write matches nothing (user/tenant suspended meanwhile)', async () => {
      prisma.user.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        repository.markLoggedIn('user-1', buildAuditEntry),
      ).resolves.toBeNull();
      // Nothing was written, nothing gets audited, no row is re-read.
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(auditLog.record).not.toHaveBeenCalled();
    });

    it('fails closed if the row vanishes between the conditional write and the re-read', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(
        repository.markLoggedIn('user-1', buildAuditEntry),
      ).resolves.toBeNull();
      expect(auditLog.record).not.toHaveBeenCalled();
    });

    it('re-reads the user with the safe select — never the credential hash', async () => {
      await repository.markLoggedIn('user-1', buildAuditEntry);

      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        select: SAFE_USER_SELECT,
      });
    });

    it('a failing audit write rolls the lastLoginAt update back with it', async () => {
      const auditBoom = new Error('audit insert failed');
      auditLog.record.mockRejectedValue(auditBoom);

      await expect(
        repository.markLoggedIn('user-1', buildAuditEntry),
      ).rejects.toBe(auditBoom);
      // The error escaped the $transaction callback — with a real database
      // Prisma rolls back the user update, so lastLoginAt can never be
      // committed without its audit trail.
    });
  });
});
