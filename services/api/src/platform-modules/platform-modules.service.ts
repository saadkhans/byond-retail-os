import { Injectable, NotFoundException } from '@nestjs/common';
import {
  AuditAction,
  ModuleStatus,
  PlatformModule,
  TenantModule,
} from '@prisma/client';
import {
  AuditLogService,
  SYSTEM_ACTOR_EMAIL,
} from '../common/audit/audit-log.service';
import { PlatformModulesRepository } from './platform-modules.repository';
import { TenantModulesRepository } from './tenant-modules.repository';

@Injectable()
export class PlatformModulesService {
  constructor(
    private readonly platformModulesRepository: PlatformModulesRepository,
    private readonly tenantModulesRepository: TenantModulesRepository,
    private readonly auditLog: AuditLogService,
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
    if (!module || !module.isActive) {
      throw new NotFoundException(`Platform module "${moduleCode}" not found`);
    }

    const tenantModule = await this.tenantModulesRepository.setStatus(
      tenantId,
      module.id,
      status,
    );

    await this.auditLog.record({
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
    });

    return tenantModule;
  }
}
