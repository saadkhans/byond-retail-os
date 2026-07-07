import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
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

    const permissions =
      await this.permissionsRepository.findEffectivePermissionCodes(
        user.id,
        user.tenantId,
      );

    request.context = {
      userId: user.id,
      email: user.email,
      userType: user.userType,
      tenantId: user.tenantId,
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
