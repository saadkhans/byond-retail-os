import { Injectable, NotFoundException } from '@nestjs/common';
import {
  AuditAction,
  ModuleStatus,
  PlatformModule,
  TenantModule,
} from '@prisma/client';
import { SYSTEM_ACTOR_EMAIL } from '../common/audit/audit-log.service';
import { PlatformModulesRepository } from './platform-modules.repository';
import { TenantModulesRepository } from './tenant-modules.repository';

@Injectable()
export class PlatformModulesService {
  constructor(
    private readonly platformModulesRepository: PlatformModulesRepository,
    private readonly tenantModulesRepository: TenantModulesRepository,
  ) {}

  listCatalog(): Promise<PlatformModule[]> {
    return this.platformModulesRepository.findAll();
  }

  listForTenant(tenantId: string): Promise<TenantModule[]> {
    return this.tenantModulesRepository.findMany(tenantId);
  }

  async enable(tenantId: string, moduleCode: string): Promise<TenantModule> {
    return this.setStatus(tenantId, moduleCode, ModuleStatus.ENABLED);
  }

  async disable(tenantId: string, moduleCode: string): Promise<TenantModule> {
    return this.setStatus(tenantId, moduleCode, ModuleStatus.DISABLED);
  }

  private async setStatus(
    tenantId: string,
    moduleCode: string,
    status: ModuleStatus,
  ): Promise<TenantModule> {
    const module = await this.platformModulesRepository.findByCode(moduleCode);
    // Inactive modules (unimplemented later-phase catalog entries) can never
    // be enabled for a tenant — same failure as a module that doesn't exist.
    if (!module || !module.isActive) {
      throw new NotFoundException(`Platform module "${moduleCode}" not found`);
    }

    return this.tenantModulesRepository.setStatus(
      tenantId,
      module.id,
      status,
      (tenantModule) => ({
        tenantId,
        actorEmail: SYSTEM_ACTOR_EMAIL,
        action:
          status === ModuleStatus.ENABLED
            ? AuditAction.ENABLE
            : AuditAction.DISABLE,
        entityType: 'TenantModule',
        entityId: tenantModule.id,
        after: tenantModule,
        reason: `Module "${moduleCode}" ${status.toLowerCase()} for tenant`,
      }),
    );
  }
}
