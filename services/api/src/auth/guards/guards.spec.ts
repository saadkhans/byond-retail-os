import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserStatus, UserType } from '@prisma/client';
import { PermissionsRepository } from '../../access-control/permissions.repository';
import { AuditLogService } from '../../common/audit/audit-log.service';
import { AuthRepository } from '../auth.repository';
import {
  IS_PUBLIC_KEY,
  PLATFORM_ONLY_KEY,
  REQUIRED_PERMISSIONS_KEY,
  TENANT_ONLY_KEY,
} from '../decorators/access-policy.decorators';
import { RequestContext, RequestWithContext } from '../request-context';
import { AuthTokenService } from '../token.service';
import { AuthGuard } from './auth.guard';
import { PermissionsGuard } from './permissions.guard';

function executionContextFor(
  request: Partial<RequestWithContext>,
  metadata: Record<string, unknown> = {},
): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => ({ metadata }),
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
  permissions: ['user:read'],
  requestId: 'req-1',
};

const platformContext: RequestContext = {
  ...tenantContext,
  userId: 'admin-1',
  email: 'admin@byond.local',
  userType: UserType.PLATFORM,
  tenantId: null,
  permissions: ['tenant:manage', 'tenant:read'],
};

describe('AuthGuard', () => {
  const activeUser = {
    id: 'user-1',
    email: 'jane@tenant-a.example',
    userType: UserType.TENANT,
    tenantId: 'tenant-a',
    status: UserStatus.ACTIVE,
  };

  let authRepository: {
    findActiveById: jest.Mock;
    findPlatformSandboxTenantId: jest.Mock;
  };
  let permissionsRepository: { findEffectivePermissionCodes: jest.Mock };
  let tokens: { verifyAccessToken: jest.Mock; issueAccessToken: jest.Mock };

  function buildGuard(metadata: Record<string, unknown> = {}): AuthGuard {
    return new AuthGuard(
      reflectorFor(metadata),
      authRepository as unknown as AuthRepository,
      permissionsRepository as unknown as PermissionsRepository,
      tokens as unknown as AuthTokenService,
    );
  }

  beforeEach(() => {
    authRepository = {
      findActiveById: jest.fn().mockResolvedValue(activeUser),
      // No sandbox seeded unless a test says otherwise — fail closed.
      findPlatformSandboxTenantId: jest.fn().mockResolvedValue(null),
    };
    permissionsRepository = {
      findEffectivePermissionCodes: jest.fn().mockResolvedValue(['user:read']),
    };
    tokens = {
      verifyAccessToken: jest.fn().mockResolvedValue({ sub: 'user-1' }),
      issueAccessToken: jest.fn(),
    };
  });

  it('lets @Public routes through without a token', async () => {
    const guard = buildGuard({ [IS_PUBLIC_KEY]: true });
    await expect(
      guard.canActivate(executionContextFor({ headers: {} })),
    ).resolves.toBe(true);
  });

  it('rejects requests without an Authorization header', async () => {
    const guard = buildGuard();
    await expect(
      guard.canActivate(executionContextFor({ headers: {} })),
    ).rejects.toThrow('Authentication required');
  });

  it('rejects malformed and invalid tokens with a generic message', async () => {
    tokens.verifyAccessToken.mockRejectedValue(new Error('bad signature'));
    const guard = buildGuard();

    await expect(
      guard.canActivate(
        executionContextFor({ headers: { authorization: 'Bearer nope' } }),
      ),
    ).rejects.toThrow('Invalid or expired token');
  });

  it('rejects tokens of users that are no longer active', async () => {
    authRepository.findActiveById.mockResolvedValue(null);
    const guard = buildGuard();

    await expect(
      guard.canActivate(
        executionContextFor({ headers: { authorization: 'Bearer x.y.z' } }),
      ),
    ).rejects.toThrow('Invalid or expired token');
  });

  it('builds the request context from the DATABASE record, not token claims', async () => {
    // Token claims say tenant-b; the database record says tenant-a. The
    // database wins — a stale or tampered claim cannot move tenants.
    tokens.verifyAccessToken.mockResolvedValue({
      sub: 'user-1',
      tenantId: 'tenant-b',
      userType: UserType.PLATFORM,
    });
    const request: Partial<RequestWithContext> = {
      headers: { authorization: 'Bearer x.y.z' },
      requestId: 'req-42',
    };
    const guard = buildGuard();

    await expect(
      guard.canActivate(executionContextFor(request)),
    ).resolves.toBe(true);
    expect(request.context).toEqual(
      expect.objectContaining({
        userId: 'user-1',
        tenantId: 'tenant-a',
        userType: UserType.TENANT,
        permissions: ['user:read'],
        requestId: 'req-42',
      }),
    );
  });

  it('tenant users NEVER resolve the platform sandbox tenant', async () => {
    // Tenant isolation: a tenant user's context comes from their own
    // database record only — the sandbox lookup must not even run.
    const request: Partial<RequestWithContext> = {
      headers: { authorization: 'Bearer x.y.z' },
    };
    const guard = buildGuard();

    await expect(
      guard.canActivate(executionContextFor(request)),
    ).resolves.toBe(true);
    expect(authRepository.findPlatformSandboxTenantId).not.toHaveBeenCalled();
    expect(request.context?.tenantId).toBe('tenant-a');
  });

  it('platform users resolve the seeded sandbox tenant as their context', async () => {
    authRepository.findActiveById.mockResolvedValue({
      ...activeUser,
      id: 'admin-1',
      userType: UserType.PLATFORM,
      tenantId: null,
    });
    authRepository.findPlatformSandboxTenantId.mockResolvedValue('sandbox-1');
    tokens.verifyAccessToken.mockResolvedValue({ sub: 'admin-1' });
    const request: Partial<RequestWithContext> = {
      headers: { authorization: 'Bearer x.y.z' },
    };
    const guard = buildGuard();

    await expect(
      guard.canActivate(executionContextFor(request)),
    ).resolves.toBe(true);
    expect(request.context).toEqual(
      expect.objectContaining({
        userType: UserType.PLATFORM,
        tenantId: 'sandbox-1',
      }),
    );
    // Permissions stay resolved against the PLATFORM binding (tenantId
    // null), not the sandbox — the sandbox never widens grants.
    expect(
      permissionsRepository.findEffectivePermissionCodes,
    ).toHaveBeenCalledWith('admin-1', null);
  });

  it('platform users keep a NULL tenant context when no sandbox is seeded', async () => {
    authRepository.findActiveById.mockResolvedValue({
      ...activeUser,
      id: 'admin-1',
      userType: UserType.PLATFORM,
      tenantId: null,
    });
    tokens.verifyAccessToken.mockResolvedValue({ sub: 'admin-1' });
    const request: Partial<RequestWithContext> = {
      headers: { authorization: 'Bearer x.y.z' },
    };
    const guard = buildGuard();

    await expect(
      guard.canActivate(executionContextFor(request)),
    ).resolves.toBe(true);
    // Downstream tenant-scoped guards fail closed on this null.
    expect(request.context?.tenantId).toBeNull();
  });
});

describe('PermissionsGuard', () => {
  let auditLog: { record: jest.Mock };

  function buildGuard(metadata: Record<string, unknown>): PermissionsGuard {
    return new PermissionsGuard(
      reflectorFor(metadata),
      auditLog as unknown as AuditLogService,
    );
  }

  function requestWith(context: RequestContext): Partial<RequestWithContext> {
    return { context, method: 'GET', path: '/test' } as never;
  }

  beforeEach(() => {
    auditLog = { record: jest.fn().mockResolvedValue(undefined) };
  });

  it('fails closed when no context exists (401, not 403)', async () => {
    const guard = buildGuard({});
    await expect(
      guard.canActivate(executionContextFor({ headers: {} })),
    ).rejects.toThrow('Authentication required');
  });

  it('platform-only: rejects tenant users and audits the denial', async () => {
    const guard = buildGuard({ [PLATFORM_ONLY_KEY]: true });

    await expect(
      guard.canActivate(executionContextFor(requestWith(tenantContext))),
    ).rejects.toThrow('Insufficient permissions');
    expect(auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ACCESS_DENIED',
        actorId: tenantContext.userId,
        reason: 'Platform-only endpoint',
      }),
    );
  });

  it('platform-only: admits platform users', async () => {
    const guard = buildGuard({ [PLATFORM_ONLY_KEY]: true });
    await expect(
      guard.canActivate(executionContextFor(requestWith(platformContext))),
    ).resolves.toBe(true);
  });

  it('tenant-only: rejects platform users without a resolved tenant context', async () => {
    // platformContext has tenantId null (no sandbox seeded) — fail closed.
    const guard = buildGuard({ [TENANT_ONLY_KEY]: true });
    await expect(
      guard.canActivate(executionContextFor(requestWith(platformContext))),
    ).rejects.toThrow('Insufficient permissions');
  });

  it('tenant-only: admits platform users resolved to the sandbox tenant', async () => {
    const guard = buildGuard({ [TENANT_ONLY_KEY]: true });
    await expect(
      guard.canActivate(
        executionContextFor(
          requestWith({ ...platformContext, tenantId: 'sandbox-1' }),
        ),
      ),
    ).resolves.toBe(true);
  });

  it('tenant-only: admits tenant users with tenant context', async () => {
    const guard = buildGuard({ [TENANT_ONLY_KEY]: true });
    await expect(
      guard.canActivate(executionContextFor(requestWith(tenantContext))),
    ).resolves.toBe(true);
  });

  it('permissions: admits when every required permission is granted', async () => {
    const guard = buildGuard({ [REQUIRED_PERMISSIONS_KEY]: ['user:read'] });
    await expect(
      guard.canActivate(executionContextFor(requestWith(tenantContext))),
    ).resolves.toBe(true);
  });

  it('permissions: rejects on any missing permission and audits which one', async () => {
    const guard = buildGuard({
      [REQUIRED_PERMISSIONS_KEY]: ['user:read', 'user:manage'],
    });

    await expect(
      guard.canActivate(executionContextFor(requestWith(tenantContext))),
    ).rejects.toThrow('Insufficient permissions');
    expect(auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'Missing permission(s): user:manage',
      }),
    );
  });

  it('platform users do not implicitly gain tenant permissions', async () => {
    // platformContext has tenant:manage but not user:read — a tenant-data
    // permission it was never granted.
    const guard = buildGuard({ [REQUIRED_PERMISSIONS_KEY]: ['user:read'] });
    await expect(
      guard.canActivate(executionContextFor(requestWith(platformContext))),
    ).rejects.toThrow('Insufficient permissions');
  });
});
