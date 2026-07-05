import { Injectable } from '@nestjs/common';
import { Role, UserRole } from '@prisma/client';
import {
  AuditEntry,
  AuditLogService,
} from '../common/audit/audit-log.service';
import { PrismaService } from '../prisma/prisma.service';
import { TenantScopedRepository } from '../prisma/tenant-scoped.repository';

@Injectable()
export class RolesRepository extends TenantScopedRepository {
  constructor(
    prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {
    super(prisma);
  }

  create(
    tenantId: string,
    data: { name: string; description?: string },
    buildAuditEntry: (role: Role) => AuditEntry,
  ): Promise<Role> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      const role = await tx.role.create({
        data: { ...data, tenantId: scopedTenantId, isSystem: false },
      });
      await this.auditLog.record(buildAuditEntry(role), tx);
      return role;
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
   * (invariant: it must equal the role's AND the user's tenantId — the
   * service verifies both through tenant-scoped lookups before calling this).
   */
  assignToUser(
    tenantId: string,
    data: { userId: string; roleId: string; assignedById?: string },
    buildAuditEntry: (userRole: UserRole) => AuditEntry,
  ): Promise<UserRole> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      const userRole = await tx.userRole.create({
        data: { ...data, tenantId: scopedTenantId },
      });
      await this.auditLog.record(buildAuditEntry(userRole), tx);
      return userRole;
    });
  }
}
