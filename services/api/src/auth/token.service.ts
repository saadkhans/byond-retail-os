import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UserType } from '@prisma/client';

/**
 * Claims carried by a BYOND access token. tenantId comes from the user's
 * database record at issue time — never from client input.
 */
export interface AccessTokenClaims {
  /** User id. */
  sub: string;
  email: string;
  userType: UserType;
  tenantId: string | null;
}

/**
 * Adapter seam for token issuing/verification (adapter-first: a future move
 * to an external IdP, OIDC provider, or asymmetric keys replaces this
 * implementation, not its consumers).
 *
 * EXTENSION POINT — refresh tokens: this phase issues short-lived access
 * tokens only. Refresh-token rotation and server-side revocation belong in a
 * later phase; add issueRefreshToken/revoke methods here when they land.
 */
export interface AuthTokenService {
  issueAccessToken(claims: AccessTokenClaims): Promise<string>;
  verifyAccessToken(token: string): Promise<AccessTokenClaims>;
}

export const AUTH_TOKEN_SERVICE = Symbol('AUTH_TOKEN_SERVICE');

@Injectable()
export class JwtAuthTokenService implements AuthTokenService {
  constructor(@Inject(JwtService) private readonly jwt: JwtService) {}

  issueAccessToken(claims: AccessTokenClaims): Promise<string> {
    const { sub, ...rest } = claims;
    return this.jwt.signAsync({ ...rest, sub });
  }

  /**
   * Signature/exp/iat are enforced by verifyAsync; claim SHAPE is enforced
   * here. A validly signed token with a missing, empty, or non-string sub
   * must fail closed — Prisma treats undefined where-fields as absent, so an
   * unvalidated sub would turn the user lookup into "first matching row".
   */
  async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    const payload = await this.jwt.verifyAsync<Record<string, unknown>>(
      token,
    );
    return validateAccessTokenClaims(payload);
  }
}

export function validateAccessTokenClaims(payload: unknown): AccessTokenClaims {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('Malformed token payload');
  }
  const { sub, email, userType, tenantId } = payload as Record<
    string,
    unknown
  >;
  if (typeof sub !== 'string' || sub.trim() === '') {
    throw new Error('Token subject is missing or invalid');
  }
  if (typeof email !== 'string' || email === '') {
    throw new Error('Token email claim is missing or invalid');
  }
  if (userType !== UserType.PLATFORM && userType !== UserType.TENANT) {
    throw new Error('Token userType claim is missing or invalid');
  }
  if (tenantId !== null && tenantId !== undefined && typeof tenantId !== 'string') {
    throw new Error('Token tenantId claim is invalid');
  }
  return {
    sub,
    email,
    userType,
    tenantId: (tenantId as string | null | undefined) ?? null,
  };
}
