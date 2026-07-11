import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserType } from '@prisma/client';
import { REQUIRED_MODULE_KEY } from '../auth/decorators/access-policy.decorators';
import { RequestContext, RequestWithContext } from '../auth/request-context';
import { AuditLogService } from '../common/audit/audit-log.service';
import { ModuleEnabledGuard } from './module-enabled.guard';
import { PlatformModulesService } from './platform-modules.service';

function executionContextFor(
  request: Partial<RequestWithContext>,
): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

function reflectorFor(metadata: Record<string, unknown>): Reflector {
  return {
    getAllAndOverride: (key: string) => metadata[key],
  } as unknown as Reflector;
}

const tenantContext: RequestContext = {
  userId: 'user-1',
  email: 'jane@tenant-a.example',
  userType: UserType.TENANT,
  tenantId: 'tenant-a',
  permissions: ['catalog:read'],
  requestId: 'req-1',
};

describe('ModuleEnabledGuard', () => {
  let platformModules: { isEnabledForTenant: jest.Mock };
  let auditLog: { record: jest.Mock };

  function buildGuard(metadata: Record<string, unknown>): ModuleEnabledGuard {
    return new ModuleEnabledGuard(
      reflectorFor(metadata),
      platformModules as unknown as PlatformModulesService,
      auditLog as unknown as AuditLogService,
    );
  }

  function requestWith(context: RequestContext): Partial<RequestWithContext> {
    return { context, method: 'GET', path: '/catalog/products' } as never;
  }

  beforeEach(() => {
    platformModules = { isEnabledForTenant: jest.fn().mockResolvedValue(true) };
    auditLog = { record: jest.fn().mockResolvedValue(undefined) };
  });

  it('is a no-op for routes without @RequireModule metadata', async () => {
    const guard = buildGuard({});
    await expect(
      guard.canActivate(executionContextFor(requestWith(tenantContext))),
    ).resolves.toBe(true);
    expect(platformModules.isEnabledForTenant).not.toHaveBeenCalled();
  });

  it('admits when the module is enabled for the tenant', async () => {
    const guard = buildGuard({ [REQUIRED_MODULE_KEY]: 'inventory' });
    await expect(
      guard.canActivate(executionContextFor(requestWith(tenantContext))),
    ).resolves.toBe(true);
    expect(platformModules.isEnabledForTenant).toHaveBeenCalledWith(
      'tenant-a',
      'inventory',
    );
  });

  it('denies (403) and audits when the module is not enabled', async () => {
    platformModules.isEnabledForTenant.mockResolvedValue(false);
    const guard = buildGuard({ [REQUIRED_MODULE_KEY]: 'inventory' });
    await expect(
      guard.canActivate(executionContextFor(requestWith(tenantContext))),
    ).rejects.toThrow('Module not enabled');
    expect(auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ACCESS_DENIED',
        actorId: 'user-1',
        reason: 'Module "inventory" is not enabled for this tenant',
      }),
    );
  });

  it('fails closed (401) when there is no request context', async () => {
    const guard = buildGuard({ [REQUIRED_MODULE_KEY]: 'inventory' });
    await expect(
      guard.canActivate(executionContextFor({ method: 'GET', path: '/x' })),
    ).rejects.toThrow('Authentication required');
  });

  it('denies a request that has no tenant context', async () => {
    const guard = buildGuard({ [REQUIRED_MODULE_KEY]: 'inventory' });
    const platformish: RequestContext = {
      ...tenantContext,
      userType: UserType.PLATFORM,
      tenantId: null,
    };
    await expect(
      guard.canActivate(executionContextFor(requestWith(platformish))),
    ).rejects.toThrow('Module not enabled');
    expect(platformModules.isEnabledForTenant).not.toHaveBeenCalled();
  });
});
