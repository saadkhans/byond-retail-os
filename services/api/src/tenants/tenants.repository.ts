import { Injectable } from '@nestjs/common';
import { ModuleStatus, Tenant } from '@prisma/client';
import {
  AuditEntry,
  AuditLogService,
} from '../common/audit/audit-log.service';
import { DefaultModulesMissingError } from '../common/errors/domain.errors';
import { PrismaService } from '../prisma/prisma.service';

/**
 * PLATFORM-SCOPED repository: Tenant is the tenancy root, so this is one of
 * the few repositories that intentionally does not extend
 * TenantScopedRepository. Do not copy this pattern for tenant-owned entities.
 */
@Injectable()
export class TenantsRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  /**
   * Creates the tenant, its default modules, and the audit row in ONE
   * transaction: either everything commits or nothing does. Fails when any
   * required default module is missing or inactive — a tenant must never be
   * silently created with a subset of its default modules.
   */
  createWithDefaultModules(
    data: { name: string; slug: string },
    defaultModuleCodes: readonly string[],
    buildAuditEntry: (tenant: Tenant) => AuditEntry,
  ): Promise<Tenant> {
    return this.prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({ data });

      const modules = await tx.platformModule.findMany({
        where: { code: { in: [...defaultModuleCodes] }, isActive: true },
      });
      if (modules.length !== defaultModuleCodes.length) {
        const found = new Set(modules.map((module) => module.code));
        const missing = defaultModuleCodes.filter((code) => !found.has(code));
        throw new DefaultModulesMissingError(missing);
      }

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

      await this.auditLog.record(buildAuditEntry(tenant), tx);
      return tenant;
    });
  }

  findById(id: string): Promise<Tenant | null> {
    return this.prisma.tenant.findUnique({ where: { id } });
  }
}
