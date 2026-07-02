import { Injectable } from '@nestjs/common';
import { ModuleStatus, Tenant } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * PLATFORM-SCOPED repository: Tenant is the tenancy root, so this is one of
 * the few repositories that intentionally does not extend
 * TenantScopedRepository. Do not copy this pattern for tenant-owned entities.
 */
@Injectable()
export class TenantsRepository {
  constructor(private readonly prisma: PrismaService) {}

  createWithDefaultModules(
    data: { name: string; slug: string },
    defaultModuleCodes: readonly string[],
  ): Promise<Tenant> {
    return this.prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({ data });
      const modules = await tx.platformModule.findMany({
        where: { code: { in: [...defaultModuleCodes] }, isActive: true },
      });
      if (modules.length > 0) {
        await tx.tenantModule.createMany({
          data: modules.map((module) => ({
            tenantId: tenant.id,
            moduleId: module.id,
            status: ModuleStatus.ENABLED,
            enabledAt: new Date(),
          })),
        });
      }
      return tenant;
    });
  }

  findById(id: string): Promise<Tenant | null> {
    return this.prisma.tenant.findUnique({ where: { id } });
  }
}
