import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserType } from '@prisma/client';
import { PermissionsRepository } from '../../access-control/permissions.repository';
import { AuthRepository } from '../auth.repository';
import { IS_PUBLIC_KEY } from '../decorators/access-policy.decorators';
import { RequestWithContext } from '../request-context';
import {
  AUTH_TOKEN_SERVICE,
  AuthTokenService,
} from '../token.service';

/**
 * Global authentication guard. Every route requires a valid bearer token
 * unless explicitly marked @Public(). On success it builds the request
 * context from the DATABASE user record (fresh status + tenant), not from
 * token claims alone — a stale token cannot resurrect a suspended user or
 * carry an outdated tenant binding.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authRepository: AuthRepository,
    private readonly permissionsRepository: PermissionsRepository,
    @Inject(AUTH_TOKEN_SERVICE) private readonly tokens: AuthTokenService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithContext>();
    const token = this.extractBearerToken(request.headers.authorization);
    if (!token) {
      throw new UnauthorizedException('Authentication required');
    }

    let userId: string;
    try {
      const claims = await this.tokens.verifyAccessToken(token);
      userId = claims.sub;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }

    const user = await this.authRepository.findActiveById(userId);
    if (!user) {
      // Deleted, suspended, or deactivated since the token was issued.
      throw new UnauthorizedException('Invalid or expired token');
    }

    // Permissions are resolved against the user's OWN tenant binding (null
    // for platform users — platform role grants), deliberately BEFORE any
    // sandbox resolution below: operating in the sandbox never widens what
    // a platform user is permitted to do.
    const permissions =
      await this.permissionsRepository.findEffectivePermissionCodes(
        user.id,
        user.tenantId,
      );

    // Platform users carry no tenant of their own. For tenant-scoped work
    // they resolve — server-side, from a fixed slug, never from client
    // input — to the seeded PLATFORM SANDBOX tenant (ACTIVE only). Without
    // a seeded sandbox the context keeps tenantId null and every
    // tenant-scoped guard keeps failing closed exactly as before.
    const tenantId =
      user.userType === UserType.PLATFORM
        ? await this.authRepository.findPlatformSandboxTenantId()
        : user.tenantId;

    request.context = {
      userId: user.id,
      email: user.email,
      userType: user.userType,
      tenantId,
      permissions,
      requestId: request.requestId ?? 'unknown',
    };
    return true;
  }

  private extractBearerToken(header: string | undefined): string | null {
    if (!header) {
      return null;
    }
    const [scheme, token] = header.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      return null;
    }
    return token;
  }
}
