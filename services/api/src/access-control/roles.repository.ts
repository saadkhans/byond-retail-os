import { Injectable } from '@nestjs/common';
import { Role, UserRole } from '@prisma/client';
import {
  AuditEntry,
  AuditLogService,
} from '../common/audit/audit-log.service';
import { TenantIsolationViolationError } from '../common/errors/domain.errors';
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
   * Assign a tenant role to a user. tenantId is denormalized onto UserRole.
   *
   * The tenancy invariant is enforced HERE, inside the transaction — not just
   * by service-level prechecks. Every referenced row (target user, role, and
   * the assigning actor when supplied) must carry the scoped tenantId, or the
   * whole transaction fails closed. Platform users (tenantId NULL) and rows
   * from other tenants can therefore never be committed into a tenant's
   * UserRole, no matter which internal caller reaches this method.
   */
  assignToUser(
    tenantId: string,
    data: { userId: string; roleId: string; assignedById?: string },
    buildAuditEntry: (userRole: UserRole) => AuditEntry,
  ): Promise<UserRole> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      const [user, role] = await Promise.all([
        tx.user.findFirst({
          where: { id: data.userId, tenantId: scopedTenantId },
          select: { id: true },
        }),
        tx.role.findFirst({
          where: { id: data.roleId, tenantId: scopedTenantId },
          select: { id: true },
        }),
      ]);
      if (!user) {
        throw new TenantIsolationViolationError(
          `user "${data.userId}" does not belong to tenant "${scopedTenantId}"`,
        );
      }
      if (!role) {
        throw new TenantIsolationViolationError(
          `role "${data.roleId}" does not belong to tenant "${scopedTenantId}"`,
        );
      }
      if (data.assignedById !== undefined) {
        const actor = await tx.user.findFirst({
          where: { id: data.assignedById, tenantId: scopedTenantId },
          select: { id: true },
        });
        if (!actor) {
          throw new TenantIsolationViolationError(
            `assigning user "${data.assignedById}" does not belong to tenant "${scopedTenantId}"`,
          );
        }
      }

      const userRole = await tx.userRole.create({
        data: { ...data, tenantId: scopedTenantId },
      });
      await this.auditLog.record(buildAuditEntry(userRole), tx);
      return userRole;
    });
  }
}
