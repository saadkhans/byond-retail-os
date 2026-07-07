import { Injectable } from '@nestjs/common';
import { Permission } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * PLATFORM-SCOPED repository: the permission catalog is global, seeded from
 * code (permission.catalog.ts), and read-only at runtime by design.
 */
@Injectable()
export class PermissionsRepository {
  constructor(private readonly prisma: PrismaService) {}

  findAll(): Promise<Permission[]> {
    return this.prisma.permission.findMany({ orderBy: { code: 'asc' } });
  }

  findByCode(code: string): Promise<Permission | null> {
    return this.prisma.permission.findUnique({ where: { code } });
  }

  /**
   * Effective permission codes for a user, resolved through UserRole →
   * RolePermission → Permission. Scope is explicit and structural, enforced
   * on BOTH sides of the join:
   * - tenant users: UserRole rows carrying their own tenantId AND whose
   *   joined Role also belongs to that tenant
   * - platform users: UserRole rows with tenantId NULL AND system roles
   *   (role.tenantId NULL) only
   * Even an inconsistent UserRole row (denormalized tenantId matching, but
   * pointing at a platform role or another tenant's role) grants nothing.
   */
  async findEffectivePermissionCodes(
    userId: string,
    tenantId: string | null,
  ): Promise<string[]> {
    const userRoles = await this.prisma.userRole.findMany({
      where: { userId, tenantId, role: { tenantId } },
      select: {
        role: {
          select: {
            rolePermissions: {
              select: { permission: { select: { code: true } } },
            },
          },
        },
      },
    });
    const codes = new Set<string>();
    for (const userRole of userRoles) {
      for (const rolePermission of userRole.role.rolePermissions) {
        codes.add(rolePermission.permission.code);
      }
    }
    return [...codes];
  }
}
