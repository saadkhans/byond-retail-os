import { Injectable } from '@nestjs/common';
import { ModuleStatus, TenantModule } from '@prisma/client';
import {
  AuditEntry,
  AuditLogService,
} from '../common/audit/audit-log.service';
import { PrismaService } from '../prisma/prisma.service';
import { TenantScopedRepository } from '../prisma/tenant-scoped.repository';

@Injectable()
export class TenantModulesRepository extends TenantScopedRepository {
  constructor(
    prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {
    super(prisma);
  }

  findMany(tenantId: string): Promise<TenantModule[]> {
    return this.prisma.tenantModule.findMany({
      where: this.scope(tenantId),
    });
  }

  setStatus(
    tenantId: string,
    moduleId: string,
    status: ModuleStatus,
    buildAuditEntry: (tenantModule: TenantModule) => AuditEntry,
  ): Promise<TenantModule> {
    const scopedTenantId = this.requireTenantId(tenantId);
    const now = new Date();
    const statusTimestamps =
      status === ModuleStatus.ENABLED
        ? { enabledAt: now }
        : { disabledAt: now };
    return this.prisma.$transaction(async (tx) => {
      const tenantModule = await tx.tenantModule.upsert({
        where: {
          tenantId_moduleId: { tenantId: scopedTenantId, moduleId },
        },
        update: { status, ...statusTimestamps },
        create: {
          tenantId: scopedTenantId,
          moduleId,
          status,
          ...statusTimestamps,
        },
      });
      await this.auditLog.record(buildAuditEntry(tenantModule), tx);
      return tenantModule;
    });
  }
}
