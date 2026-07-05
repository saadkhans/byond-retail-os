import { Injectable } from '@nestjs/common';
import { User, UserType } from '@prisma/client';
import {
  AuditEntry,
  AuditLogService,
} from '../common/audit/audit-log.service';
import { PrismaService } from '../prisma/prisma.service';
import { TenantScopedRepository } from '../prisma/tenant-scoped.repository';

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
    buildAuditEntry: (user: User) => AuditEntry,
  ): Promise<User> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          ...data,
          tenantId: scopedTenantId,
          userType: UserType.TENANT,
        },
      });
      await this.auditLog.record(buildAuditEntry(user), tx);
      return user;
    });
  }

  findById(tenantId: string, id: string): Promise<User | null> {
    return this.prisma.user.findFirst({ where: this.scope(tenantId, { id }) });
  }

  findByEmail(tenantId: string, email: string): Promise<User | null> {
    return this.prisma.user.findFirst({
      where: this.scope(tenantId, { email }),
    });
  }

  findMany(tenantId: string): Promise<User[]> {
    return this.prisma.user.findMany({ where: this.scope(tenantId) });
  }
}
