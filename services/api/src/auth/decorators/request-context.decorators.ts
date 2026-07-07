import {
  createParamDecorator,
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { RequestContext, RequestWithContext } from '../request-context';

function contextFromExecution(ctx: ExecutionContext): RequestContext {
  const request = ctx.switchToHttp().getRequest<RequestWithContext>();
  if (!request.context) {
    // Fail closed: a handler asked for identity on a route the auth guard
    // never populated (e.g. mistakenly marked @Public).
    throw new UnauthorizedException('Authentication required');
  }
  return request.context;
}

/** Injects the authenticated request context (user id, email, type, ...). */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): RequestContext =>
    contextFromExecution(ctx),
);

/**
 * Injects the tenant id resolved from the AUTHENTICATED USER — never from
 * the request payload. Fails closed when the caller has no tenant context.
 */
export const CurrentTenantId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const context = contextFromExecution(ctx);
    if (!context.tenantId) {
      throw new ForbiddenException('A tenant context is required');
    }
    return context.tenantId;
  },
);
