import { Injectable } from '@nestjs/common';
import { ModuleStatus, TenantModule } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TenantScopedRepository } from '../prisma/tenant-scoped.repository';

@Injectable()
export class TenantModulesRepository extends TenantScopedRepository {
  constructor(prisma: PrismaService) {
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
  ): Promise<TenantModule> {
    const scopedTenantId = this.requireTenantId(tenantId);
    const now = new Date();
    const statusTimestamps =
      status === ModuleStatus.ENABLED
        ? { enabledAt: now }
        : { disabledAt: now };
    return this.prisma.tenantModule.upsert({
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
  }
}
