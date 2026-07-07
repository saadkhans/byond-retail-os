import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuditAction, UserType } from '@prisma/client';
import { AuditLogService } from '../../common/audit/audit-log.service';
import {
  IS_PUBLIC_KEY,
  PLATFORM_ONLY_KEY,
  REQUIRED_PERMISSIONS_KEY,
  TENANT_ONLY_KEY,
} from '../decorators/access-policy.decorators';
import { RequestContext, RequestWithContext } from '../request-context';

/**
 * Global authorization guard (runs after AuthGuard). Enforces
 * @PlatformOnly / @TenantOnly / @RequirePermissions metadata, fails closed,
 * audits every denial, and answers with a detail-free 403.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auditLog: AuditLogService,
  ) {}

  async canActivate(executionContext: ExecutionContext): Promise<boolean> {
    const targets = [
      executionContext.getHandler(),
      executionContext.getClass(),
    ] as const;
    const isPublic = this.reflector.getAllAndOverride<boolean>(
      IS_PUBLIC_KEY,
      [...targets],
    );
    if (isPublic) {
      return true;
    }

    const request = executionContext
      .switchToHttp()
      .getRequest<RequestWithContext>();
    const context = request.context;
    if (!context) {
      // Fail closed: authorization without authentication is impossible.
      throw new UnauthorizedException('Authentication required');
    }

    const platformOnly = this.reflector.getAllAndOverride<boolean>(
      PLATFORM_ONLY_KEY,
      [...targets],
    );
    if (platformOnly && context.userType !== UserType.PLATFORM) {
      return this.deny(context, request, 'Platform-only endpoint');
    }

    const tenantOnly = this.reflector.getAllAndOverride<boolean>(
      TENANT_ONLY_KEY,
      [...targets],
    );
    if (
      tenantOnly &&
      (context.userType !== UserType.TENANT || !context.tenantId)
    ) {
      return this.deny(context, request, 'Tenant-only endpoint');
    }

    const required =
      this.reflector.getAllAndOverride<string[]>(REQUIRED_PERMISSIONS_KEY, [
        ...targets,
      ]) ?? [];
    const granted = new Set(context.permissions);
    const missing = required.filter((permission) => !granted.has(permission));
    if (missing.length > 0) {
      return this.deny(
        context,
        request,
        `Missing permission(s): ${missing.join(', ')}`,
      );
    }

    return true;
  }

  private async deny(
    context: RequestContext,
    request: RequestWithContext,
    reason: string,
  ): Promise<never> {
    // The specific reason goes to the audit log only; the HTTP response
    // stays generic so it cannot be used to map the permission model.
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
    throw new ForbiddenException('Insufficient permissions');
  }
}
