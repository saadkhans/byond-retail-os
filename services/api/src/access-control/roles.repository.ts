import { Injectable } from '@nestjs/common';
import { Role, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TenantScopedRepository } from '../prisma/tenant-scoped.repository';

@Injectable()
export class RolesRepository extends TenantScopedRepository {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  create(
    tenantId: string,
    data: { name: string; description?: string },
  ): Promise<Role> {
    return this.prisma.role.create({
      data: {
        ...data,
        tenantId: this.requireTenantId(tenantId),
        isSystem: false,
      },
    });
  }

  findById(tenantId: string, id: string): Promise<Role | null> {
    return this.prisma.role.findFirst({ where: this.scope(tenantId, { id }) });
  }

  findMany(tenantId: string): Promise<Role[]> {
    return this.prisma.role.findMany({ where: this.scope(tenantId) });
  }

  /**
   * Assign a tenant role to a user. tenantId is denormalized onto UserRole
   * (invariant: it must equal the role's tenantId — enforced by the service
   * looking the role up through this scoped repository first).
   */
  assignToUser(
    tenantId: string,
    data: { userId: string; roleId: string; assignedById?: string },
  ): Promise<UserRole> {
    return this.prisma.userRole.create({
      data: { ...data, tenantId: this.requireTenantId(tenantId) },
    });
  }
}
