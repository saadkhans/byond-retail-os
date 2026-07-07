import { UnauthorizedException } from '@nestjs/common';
import { AuditAction, User, UserStatus, UserType } from '@prisma/client';
import { AuditLogService } from '../common/audit/audit-log.service';
import { AuthRepository } from './auth.repository';
import { AuthService } from './auth.service';
import { PasswordHasher } from './password-hasher';
import { AuthTokenService } from './token.service';

describe('AuthService', () => {
  const user = {
    id: 'user-1',
    tenantId: 'tenant-a',
    userType: UserType.TENANT,
    email: 'jane@tenant-a.example',
    firstName: 'Jane',
    lastName: 'Doe',
    status: UserStatus.ACTIVE,
    passwordHash: '$2b$12$fakefakefakefakefakefakefakefakefakefakefakefake',
    lastLoginAt: null,
    createdAt: new Date('2026-07-01T00:00:00Z'),
    updatedAt: new Date('2026-07-01T00:00:00Z'),
  } as User;

  let repository: {
    findByEmail: jest.Mock;
    findActiveById: jest.Mock;
    markLoggedIn: jest.Mock;
  };
  let auditLog: { record: jest.Mock };
  let hasher: {
    hash: jest.Mock;
    verify: jest.Mock;
    equalizeTiming: jest.Mock;
  };
  let tokens: { issueAccessToken: jest.Mock; verifyAccessToken: jest.Mock };
  let service: AuthService;

  beforeEach(() => {
    repository = {
      findByEmail: jest.fn().mockResolvedValue(user),
      findActiveById: jest.fn().mockResolvedValue(user),
      markLoggedIn: jest.fn().mockResolvedValue(user),
    };
    auditLog = { record: jest.fn().mockResolvedValue(undefined) };
    hasher = {
      hash: jest.fn(),
      verify: jest.fn().mockResolvedValue(true),
      equalizeTiming: jest.fn().mockResolvedValue(undefined),
    };
    tokens = {
      issueAccessToken: jest.fn().mockResolvedValue('signed.jwt.token'),
      verifyAccessToken: jest.fn(),
    };
    service = new AuthService(
      repository as unknown as AuthRepository,
      auditLog as unknown as AuditLogService,
      hasher as unknown as PasswordHasher,
      tokens as unknown as AuthTokenService,
    );
  });

  describe('login', () => {
    it('returns a token and a safe user on success', async () => {
      const result = await service.login('Jane@Tenant-A.example', 'pw-ok');

      expect(repository.findByEmail).toHaveBeenCalledWith(
        'jane@tenant-a.example',
      );
      expect(hasher.verify).toHaveBeenCalledWith('pw-ok', user.passwordHash);
      expect(result.accessToken).toBe('signed.jwt.token');
      expect(tokens.issueAccessToken).toHaveBeenCalledWith({
        sub: user.id,
        email: user.email,
        userType: user.userType,
        tenantId: user.tenantId,
      });
      // The response must never carry the credential hash.
      expect(
        (result.user as unknown as Record<string, unknown>).passwordHash,
      ).toBeUndefined();
    });

    it('records lastLoginAt and the LOGIN audit atomically via the repository', async () => {
      await service.login(user.email, 'pw-ok');

      // One repository call carrying the audit builder — the repository
      // commits both in a single transaction.
      expect(repository.markLoggedIn).toHaveBeenCalledWith(
        user.id,
        expect.any(Function),
      );
      const buildAuditEntry = repository.markLoggedIn.mock.calls[0][1] as (
        loggedIn: User,
      ) => Record<string, unknown>;
      expect(buildAuditEntry(user)).toEqual(
        expect.objectContaining({
          action: AuditAction.LOGIN,
          actorId: user.id,
          actorEmail: user.email,
          tenantId: user.tenantId,
        }),
      );
      // The service itself writes no separate success audit.
      expect(auditLog.record).not.toHaveBeenCalled();
    });

    it('returns the POST-login user state (updated lastLoginAt), not the pre-login row', async () => {
      const loginTime = new Date('2026-07-06T12:00:00Z');
      repository.markLoggedIn.mockResolvedValue({
        ...user,
        lastLoginAt: loginTime,
      });

      const result = await service.login(user.email, 'pw-ok');

      expect(result.user.lastLoginAt).toEqual(loginTime);
    });

    it('issues the token only after the atomic login mutation succeeds', async () => {
      repository.markLoggedIn.mockRejectedValue(new Error('audit write failed'));

      await expect(service.login(user.email, 'pw-ok')).rejects.toThrow(
        'audit write failed',
      );
      expect(tokens.issueAccessToken).not.toHaveBeenCalled();
    });

    it('rejects generically when the account was suspended between lookup and the login transaction', async () => {
      // Credential check passed, but the in-transaction recheck failed
      // (user or tenant suspended meanwhile) — repository returns null.
      repository.markLoggedIn.mockResolvedValue(null);

      await expect(service.login(user.email, 'pw-ok')).rejects.toThrow(
        'Invalid credentials',
      );
      expect(tokens.issueAccessToken).not.toHaveBeenCalled();
      expect(auditLog.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: AuditAction.ACCESS_DENIED }),
      );
    });

    it('rejects unknown emails with the same generic 401 and audits the failure', async () => {
      repository.findByEmail.mockResolvedValue(null);

      await expect(
        service.login('nobody@example.com', 'whatever-pw'),
      ).rejects.toThrow(new UnauthorizedException('Invalid credentials'));
      expect(auditLog.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.ACCESS_DENIED,
          actorEmail: 'nobody@example.com',
        }),
      );
    });

    it('equalizes timing on the unknown-email path via the adapter', async () => {
      repository.findByEmail.mockResolvedValue(null);

      await service.login('nobody@example.com', 'whatever-pw').catch(() => undefined);

      // The adapter owns the equalization work — the service never touches
      // algorithm-specific hashes or costs.
      expect(hasher.equalizeTiming).toHaveBeenCalledTimes(1);
      expect(hasher.equalizeTiming).toHaveBeenCalledWith('whatever-pw');
      expect(hasher.verify).not.toHaveBeenCalled();
      expect(hasher.hash).not.toHaveBeenCalled();
    });

    it('rejects wrong passwords with the same generic 401', async () => {
      hasher.verify.mockResolvedValue(false);

      await expect(service.login(user.email, 'wrong-pw')).rejects.toThrow(
        'Invalid credentials',
      );
      expect(tokens.issueAccessToken).not.toHaveBeenCalled();
      expect(repository.markLoggedIn).not.toHaveBeenCalled();
    });

    it('rejects users without a local credential, with adapter equalization', async () => {
      repository.findByEmail.mockResolvedValue({ ...user, passwordHash: null });

      await expect(service.login(user.email, 'any-pw-123')).rejects.toThrow(
        'Invalid credentials',
      );
      // Never verifies against a real hash (there is none) — but still does
      // the adapter's dummy work so the path is timing-indistinguishable.
      expect(hasher.equalizeTiming).toHaveBeenCalledWith('any-pw-123');
      expect(hasher.verify).not.toHaveBeenCalled();
    });

    it('rejects non-active users with adapter equalization', async () => {
      repository.findByEmail.mockResolvedValue({
        ...user,
        status: UserStatus.SUSPENDED,
      });

      await expect(service.login(user.email, 'pw-ok')).rejects.toThrow(
        'Invalid credentials',
      );
      expect(hasher.equalizeTiming).toHaveBeenCalledWith('pw-ok');
    });

    it('wrong password verifies against the REAL hash exactly once, still generic', async () => {
      hasher.verify.mockResolvedValue(false);

      await expect(service.login(user.email, 'wrong-pw')).rejects.toThrow(
        'Invalid credentials',
      );
      expect(hasher.verify).toHaveBeenCalledTimes(1);
      expect(hasher.verify).toHaveBeenCalledWith('wrong-pw', user.passwordHash);
    });

    it('the failed-login outcome stays generic regardless of equalization internals', async () => {
      // The adapter contract says equalizeTiming never throws; the service
      // result is the same generic 401 either way.
      repository.findByEmail.mockResolvedValue(null);

      await expect(
        service.login('nobody@example.com', 'whatever-pw'),
      ).rejects.toThrow('Invalid credentials');
    });

    it('never passes the password to the audit log', async () => {
      hasher.verify.mockResolvedValue(false);
      await service.login(user.email, 'super-secret-pw').catch(() => undefined);

      for (const call of auditLog.record.mock.calls) {
        expect(JSON.stringify(call)).not.toContain('super-secret-pw');
      }
    });
  });

  describe('logout', () => {
    it('audits the logout with the acting user', async () => {
      const result = await service.logout({
        userId: user.id,
        email: user.email,
        userType: user.userType,
        tenantId: user.tenantId,
        permissions: [],
        requestId: 'req-1',
      });

      expect(result).toEqual({ loggedOut: true });
      expect(auditLog.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.LOGOUT,
          actorId: user.id,
          requestId: 'req-1',
        }),
      );
    });
  });

  describe('me', () => {
    it('returns the safe profile of the current user', async () => {
      const profile = await service.me({
        userId: user.id,
        email: user.email,
        userType: user.userType,
        tenantId: user.tenantId,
        permissions: [],
        requestId: 'req-1',
      });

      expect(profile.id).toBe(user.id);
      expect(
        (profile as unknown as Record<string, unknown>).passwordHash,
      ).toBeUndefined();
    });

    it('fails when the user no longer resolves as active', async () => {
      repository.findActiveById.mockResolvedValue(null);

      await expect(
        service.me({
          userId: 'gone',
          email: 'gone@example.com',
          userType: UserType.TENANT,
          tenantId: 'tenant-a',
          permissions: [],
          requestId: 'req-1',
        }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });
});
