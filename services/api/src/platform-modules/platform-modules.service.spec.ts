import { NotFoundException } from '@nestjs/common';
import { AuditAction, TenantModule } from '@prisma/client';
import { AuditEntry } from '../common/audit/audit-log.service';
import { PlatformModulesRepository } from './platform-modules.repository';
import { PlatformModulesService } from './platform-modules.service';
import { TenantModulesRepository } from './tenant-modules.repository';

describe('PlatformModulesService', () => {
  const activeModule = { id: 'module-core', code: 'core', isActive: true };
  const inactiveModule = {
    id: 'module-inventory',
    code: 'inventory',
    isActive: false,
  };
  const tenantModule = {
    id: 'tenant-module-1',
    tenantId: 'tenant-a',
    moduleId: 'module-core',
    status: 'ENABLED',
  } as TenantModule;

  let platformModulesRepository: { findAll: jest.Mock; findByCode: jest.Mock };
  let tenantModulesRepository: { findMany: jest.Mock; setStatus: jest.Mock };
  let service: PlatformModulesService;

  beforeEach(() => {
    platformModulesRepository = {
      findAll: jest.fn().mockResolvedValue([activeModule, inactiveModule]),
      findByCode: jest.fn().mockResolvedValue(activeModule),
    };
    tenantModulesRepository = {
      findMany: jest.fn().mockResolvedValue([]),
      setStatus: jest.fn().mockResolvedValue(tenantModule),
    };
    service = new PlatformModulesService(
      platformModulesRepository as unknown as PlatformModulesRepository,
      tenantModulesRepository as unknown as TenantModulesRepository,
    );
  });

  it('enables an active module and audits through the repository transaction', async () => {
    const result = await service.enable('tenant-a', 'core');

    expect(tenantModulesRepository.setStatus).toHaveBeenCalledWith(
      'tenant-a',
      activeModule.id,
      'ENABLED',
      expect.any(Function),
    );
    const buildAuditEntry = tenantModulesRepository.setStatus.mock
      .calls[0][3] as (created: TenantModule) => AuditEntry;
    expect(buildAuditEntry(tenantModule)).toEqual(
      expect.objectContaining({
        tenantId: 'tenant-a',
        action: AuditAction.ENABLE,
        entityType: 'TenantModule',
        entityId: tenantModule.id,
      }),
    );
    expect(result).toBe(tenantModule);
  });

  it('refuses to enable an inactive (unimplemented) module', async () => {
    platformModulesRepository.findByCode.mockResolvedValue(inactiveModule);

    await expect(
      service.enable('tenant-a', 'inventory'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(tenantModulesRepository.setStatus).not.toHaveBeenCalled();
  });

  it('refuses to enable a module that does not exist', async () => {
    platformModulesRepository.findByCode.mockResolvedValue(null);

    await expect(service.enable('tenant-a', 'nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(tenantModulesRepository.setStatus).not.toHaveBeenCalled();
  });

  it('allows disabling an existing module even when it is inactive (cleanup path)', async () => {
    // A module retired to inactive while tenants still have it enabled must
    // remain disable-able.
    platformModulesRepository.findByCode.mockResolvedValue(inactiveModule);

    await service.disable('tenant-a', 'inventory');

    expect(tenantModulesRepository.setStatus).toHaveBeenCalledWith(
      'tenant-a',
      inactiveModule.id,
      'DISABLED',
      expect.any(Function),
    );
  });

  it('refuses to disable a module that does not exist in the catalog', async () => {
    platformModulesRepository.findByCode.mockResolvedValue(null);

    await expect(service.disable('tenant-a', 'nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(tenantModulesRepository.setStatus).not.toHaveBeenCalled();
  });

  it('disables with a DISABLE audit action', async () => {
    await service.disable('tenant-a', 'core');

    const buildAuditEntry = tenantModulesRepository.setStatus.mock
      .calls[0][3] as (created: TenantModule) => AuditEntry;
    expect(buildAuditEntry(tenantModule)).toEqual(
      expect.objectContaining({ action: AuditAction.DISABLE }),
    );
  });

  it('audits the authenticated actor, not the system placeholder, when provided', async () => {
    const actor = { id: 'user-9', email: 'ops@tenant-a.example' };
    await service.enable('tenant-a', 'core', actor);

    const buildAuditEntry = tenantModulesRepository.setStatus.mock
      .calls[0][3] as (created: TenantModule) => AuditEntry;
    expect(buildAuditEntry(tenantModule)).toEqual(
      expect.objectContaining({
        actorId: 'user-9',
        actorEmail: 'ops@tenant-a.example',
      }),
    );
  });

  it('falls back to the system actor only when no actor is supplied', async () => {
    await service.disable('tenant-a', 'core');

    const buildAuditEntry = tenantModulesRepository.setStatus.mock
      .calls[0][3] as (created: TenantModule) => AuditEntry;
    expect(buildAuditEntry(tenantModule)).toEqual(
      expect.objectContaining({
        actorId: null,
        actorEmail: 'system@byond.internal',
      }),
    );
  });
});
