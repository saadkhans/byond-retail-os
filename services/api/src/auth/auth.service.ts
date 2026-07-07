import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { AuditAction } from '@prisma/client';
import { AuditLogService } from '../common/audit/audit-log.service';
import { AuthRepository } from './auth.repository';
import {
  AUTH_TOKEN_SERVICE,
  AuthTokenService,
} from './token.service';
import {
  PASSWORD_HASHER,
  PasswordHasher,
} from './password-hasher';
import { RequestContext } from './request-context';
import { SafeUser, toSafeUser } from './safe-user';

export interface LoginResult {
  accessToken: string;
  user: SafeUser;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly authRepository: AuthRepository,
    private readonly auditLog: AuditLogService,
    @Inject(PASSWORD_HASHER) private readonly passwordHasher: PasswordHasher,
    @Inject(AUTH_TOKEN_SERVICE) private readonly tokens: AuthTokenService,
  ) {}

  /**
   * All failure modes return the same generic 401 — no signal about whether
   * the email exists, has a credential, or is suspended. Failures are
   * audited (email only; never the password) as ACCESS_DENIED.
   */
  async login(
    email: string,
    password: string,
    requestId?: string,
  ): Promise<LoginResult> {
    const normalizedEmail = email.toLowerCase().trim();
    const user = await this.authRepository.findByEmail(normalizedEmail);

    const failLogin = async (reason: string): Promise<never> => {
      await this.auditLog.record({
        tenantId: user?.tenantId ?? null,
        actorId: null,
        actorEmail: normalizedEmail,
        action: AuditAction.ACCESS_DENIED,
        entityType: 'Auth',
        reason,
        requestId,
      });
      throw new UnauthorizedException('Invalid credentials');
    };

    if (!user || user.status !== 'ACTIVE' || !user.passwordHash) {
      // Adapter-owned equalization: the same hashing work a real
      // verification does, so response timing cannot reveal whether the
      // account exists or holds a local credential. Reasons stay coarse in
      // the audit log too — details would help credential probing.
      await this.passwordHasher.equalizeTiming(password);
      return failLogin('Login failed');
    }

    const passwordValid = await this.passwordHasher.verify(
      password,
      user.passwordHash,
    );
    if (!passwordValid) {
      return failLogin('Login failed');
    }

    // lastLoginAt + LOGIN audit commit atomically inside the repository
    // transaction; the token is issued only after that state change lands.
    // The UPDATED row is what the response serializes — clients reading
    // user.lastLoginAt from the login response get the post-login value.
    const loggedInUser = await this.authRepository.markLoggedIn(
      user.id,
      (updated) => ({
        tenantId: updated.tenantId,
        actorId: updated.id,
        actorEmail: updated.email,
        action: AuditAction.LOGIN,
        entityType: 'Auth',
        entityId: updated.id,
        reason: 'Login succeeded',
        requestId,
      }),
    );
    if (!loggedInUser) {
      // Suspended (user or tenant) between the credential check and the
      // login transaction: same generic 401 as every other failure.
      return failLogin('Login failed');
    }

    const accessToken = await this.tokens.issueAccessToken({
      sub: loggedInUser.id,
      email: loggedInUser.email,
      userType: loggedInUser.userType,
      tenantId: loggedInUser.tenantId,
    });
    return { accessToken, user: toSafeUser(loggedInUser) };
  }

  /**
   * Stateless-JWT placeholder: the token stays technically valid until it
   * expires (15m default). Real revocation (refresh-token rotation or a
   * denylist) is a documented later-phase extension of AuthTokenService.
   * The logout is still audited so sessions are traceable.
   */
  async logout(context: RequestContext): Promise<{ loggedOut: true }> {
    await this.auditLog.record({
      tenantId: context.tenantId,
      actorId: context.userId,
      actorEmail: context.email,
      action: AuditAction.LOGOUT,
      entityType: 'Auth',
      entityId: context.userId,
      reason: 'Logout requested',
      requestId: context.requestId,
    });
    return { loggedOut: true };
  }

  async me(context: RequestContext): Promise<SafeUser> {
    const user = await this.authRepository.findActiveById(context.userId);
    if (!user) {
      throw new UnauthorizedException('Invalid or expired token');
    }
    return toSafeUser(user);
  }
}
