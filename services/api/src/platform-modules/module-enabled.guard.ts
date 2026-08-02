import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuditAction } from '@prisma/client';
import { REQUIRED_MODULE_KEY } from '../auth/decorators/access-policy.decorators';
import { RequestContext, RequestWithContext } from '../auth/request-context';
import { AuditLogService } from '../common/audit/audit-log.service';
import { PlatformModulesService } from './platform-modules.service';

/**
 * Global module-enablement guard (runs after AuthGuard/PermissionsGuard).
 * When a route (or its controller) is annotated with @RequireModule(code),
 * the caller's tenant must have that module ENABLED — RBAC permissions alone
 * are not enough. Fails closed, audits every denial, and answers with a 403.
 *
 * Without the metadata the guard is a no-op, so unannotated routes are
 * unaffected.
 */
@Injectable()
export class ModuleEnabledGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly platformModules: PlatformModulesService,
    private readonly auditLog: AuditLogService,
  ) {}

  async canActivate(executionContext: ExecutionContext): Promise<boolean> {
    const moduleCode = this.reflector.getAllAndOverride<string>(
      REQUIRED_MODULE_KEY,
      [executionContext.getHandler(), executionContext.getClass()],
    );
    if (!moduleCode) {
      return true;
    }

    const request = executionContext
      .switchToHttp()
      .getRequest<RequestWithContext>();
    const context = request.context;
    if (!context) {
      // Fail closed: a module gate without authentication is impossible.
      throw new UnauthorizedException('Authentication required');
    }

    // Module enablement is a per-tenant concept; a request without a
    // RESOLVED tenant context can never satisfy it. Tenant users always
    // carry their own tenant; platform users carry the seeded platform
    // sandbox tenant when it exists (resolved server-side by the auth
    // guard) and are denied here otherwise — fail closed, never wildcard.
    if (!context.tenantId) {
      return this.deny(
        context,
        request,
        `Module "${moduleCode}" requires a tenant context`,
      );
    }

    const enabled = await this.platformModules.isEnabledForTenant(
      context.tenantId,
      moduleCode,
    );
    if (!enabled) {
      return this.deny(
        context,
        request,
        `Module "${moduleCode}" is not enabled for this tenant`,
      );
    }
    return true;
  }

  private async deny(
    context: RequestContext,
    request: RequestWithContext,
    reason: string,
  ): Promise<never> {
    // Detail goes to the audit log; the HTTP response stays generic.
    await this.auditLog.record({
      tenantId: context.tenantId,
      actorId: context.userId,
      actorEmail: context.email,
      action: AuditAction.ACCESS_DENIED,
      entityType: 'Endpoint',
      entityId: `${request.method} ${request.path}`,
      reason,
      requestId: context.requestId,
    });
    throw new ForbiddenException('Module not enabled for this tenant');
  }
}
