import { Injectable } from '@nestjs/common';
import { User, UserType } from '@prisma/client';
import {
  AuditEntry,
  AuditLogService,
} from '../common/audit/audit-log.service';
import { PrismaService } from '../prisma/prisma.service';
import { TenantScopedRepository } from '../prisma/tenant-scoped.repository';

/**
 * Explicit select shape for every non-auth user query: all scalar fields
 * EXCEPT passwordHash. Only AuthRepository may load credential hashes;
 * selecting them here would put hashes one missed mapper or audit snapshot
 * away from exposure.
 */
export const SAFE_USER_SELECT = {
  id: true,
  tenantId: true,
  userType: true,
  email: true,
  firstName: true,
  lastName: true,
  status: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** A user row loaded WITHOUT its credential hash. */
export type SafeDbUser = Omit<User, 'passwordHash'>;

@Injectable()
export class UsersRepository extends TenantScopedRepository {
  constructor(
    prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {
    super(prisma);
  }

  create(
    tenantId: string,
    data: { email: string; firstName: string; lastName: string },
    buildAuditEntry: (user: SafeDbUser) => AuditEntry,
  ): Promise<SafeDbUser> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          ...data,
          tenantId: scopedTenantId,
          userType: UserType.TENANT,
        },
        select: SAFE_USER_SELECT,
      });
      await this.auditLog.record(buildAuditEntry(user), tx);
      return user;
    });
  }

  findById(tenantId: string, id: string): Promise<SafeDbUser | null> {
    return this.prisma.user.findFirst({
      where: this.scope(tenantId, { id }),
      select: SAFE_USER_SELECT,
    });
  }

  findByEmail(tenantId: string, email: string): Promise<SafeDbUser | null> {
    return this.prisma.user.findFirst({
      where: this.scope(tenantId, { email }),
      select: SAFE_USER_SELECT,
    });
  }

  findMany(tenantId: string): Promise<SafeDbUser[]> {
    return this.prisma.user.findMany({
      where: this.scope(tenantId),
      select: SAFE_USER_SELECT,
    });
  }
}
