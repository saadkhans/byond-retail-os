import { Injectable, NotFoundException } from '@nestjs/common';
import {
  AuditAction,
  ModuleStatus,
  PlatformModule,
  TenantModule,
} from '@prisma/client';
import {
  AuditActor,
  SYSTEM_ACTOR_EMAIL,
} from '../common/audit/audit-log.service';
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

  async enable(
    tenantId: string,
    moduleCode: string,
    actor?: AuditActor,
  ): Promise<TenantModule> {
    return this.setStatus(tenantId, moduleCode, ModuleStatus.ENABLED, actor);
  }

  async disable(
    tenantId: string,
    moduleCode: string,
    actor?: AuditActor,
  ): Promise<TenantModule> {
    return this.setStatus(tenantId, moduleCode, ModuleStatus.DISABLED, actor);
  }

  private async setStatus(
    tenantId: string,
    moduleCode: string,
    status: ModuleStatus,
    actor?: AuditActor,
  ): Promise<TenantModule> {
    const module = await this.platformModulesRepository.findByCode(moduleCode);
    if (!module) {
      throw new NotFoundException(`Platform module "${moduleCode}" not found`);
    }
    // Inactive modules (unimplemented later-phase catalog entries) can never
    // be ENABLED for a tenant. Disabling stays allowed for any existing
    // catalog module — if a module is retired to inactive while tenants still
    // have it enabled, cleanup must not be blocked.
    if (status === ModuleStatus.ENABLED && !module.isActive) {
      throw new NotFoundException(`Platform module "${moduleCode}" not found`);
    }

    return this.tenantModulesRepository.setStatus(
      tenantId,
      module.id,
      status,
      (tenantModule) => ({
        tenantId,
        actorId: actor?.id ?? null,
        actorEmail: actor?.email ?? SYSTEM_ACTOR_EMAIL,
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
