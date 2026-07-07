import { PrismaService } from '../prisma/prisma.service';
import { PermissionsRepository } from './permissions.repository';

describe('PermissionsRepository.findEffectivePermissionCodes', () => {
  let prisma: { userRole: { findMany: jest.Mock } };
  let repository: PermissionsRepository;

  function grant(codes: string[]): { role: { rolePermissions: { permission: { code: string } }[] } } {
    return {
      role: {
        rolePermissions: codes.map((code) => ({ permission: { code } })),
      },
    };
  }

  beforeEach(() => {
    prisma = { userRole: { findMany: jest.fn().mockResolvedValue([]) } };
    repository = new PermissionsRepository(
      prisma as unknown as PrismaService,
    );
  });

  it('constrains BOTH the UserRole row and the joined role to the tenant', async () => {
    await repository.findEffectivePermissionCodes('user-1', 'tenant-a');

    expect(prisma.userRole.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: 'user-1',
          tenantId: 'tenant-a',
          role: { tenantId: 'tenant-a' },
        },
      }),
    );
  });

  it('platform scope constrains the role to system roles (tenantId null)', async () => {
    await repository.findEffectivePermissionCodes('admin-1', null);

    expect(prisma.userRole.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: 'admin-1',
          tenantId: null,
          role: { tenantId: null },
        },
      }),
    );
  });

  it('grants deduplicated codes from valid tenant roles', async () => {
    prisma.userRole.findMany.mockResolvedValue([
      grant(['user:read', 'user:manage']),
      grant(['user:read', 'location:read']),
    ]);

    const codes = await repository.findEffectivePermissionCodes(
      'user-1',
      'tenant-a',
    );
    expect(codes.sort()).toEqual([
      'location:read',
      'user:manage',
      'user:read',
    ]);
  });

  it('grants nothing when the scoped query matches no consistent rows', async () => {
    // An inconsistent UserRole (matching denormalized tenantId but pointing
    // at a platform role or another tenant's role) is excluded by the
    // role.tenantId constraint, so the query legitimately returns [].
    prisma.userRole.findMany.mockResolvedValue([]);

    await expect(
      repository.findEffectivePermissionCodes('user-1', 'tenant-a'),
    ).resolves.toEqual([]);
  });
});
