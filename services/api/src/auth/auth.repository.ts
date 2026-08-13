import { Injectable, Logger } from '@nestjs/common';
import { TenantStatus, User, UserStatus, UserType } from '@prisma/client';
import {
  AuditEntry,
  AuditLogService,
} from '../common/audit/audit-log.service';
import { PrismaService } from '../prisma/prisma.service';
import { PLATFORM_SANDBOX_TENANT_SLUG } from '../tenants/platform-sandbox';
import { SAFE_USER_SELECT, SafeDbUser } from '../users/users.repository';

/**
 * Thrown inside the login transaction when eligibility fails AFTER the
 * lastLoginAt write — the throw forces Prisma to roll that write back.
 * markLoggedIn maps it to null, which the caller answers with the generic
 * 401. Never leaves this module.
 */
class LoginIneligibleError extends Error {}

/**
 * PLATFORM-SCOPED repository, deliberately: authentication happens BEFORE a
 * tenant context exists, so the email lookup is global (email is globally
 * unique). The password-login lookup (findByEmail) is the ONLY query allowed
 * to load passwordHash; token authentication (findActiveById) and the login
 * write-back (markLoggedIn) use SAFE_USER_SELECT, so credential hashes are
 * never materialized on ordinary API requests.
 *
 * Tenant-status rule: a tenant user only authenticates while their tenant is
 * ACTIVE — an ACTIVE user inside a PENDING/SUSPENDED/ARCHIVED tenant fails
 * closed. Platform users have no tenant and are exempt by design.
 */
@Injectable()
export class AuthRepository {
  private readonly logger = new Logger(AuthRepository.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  /** Password-login lookup — the only reader of passwordHash. */
  async findByEmail(email: string): Promise<User | null> {
    const user = await this.prisma.user.findFirst({
      where: { email },
      include: { tenant: { select: { status: true } } },
    });
    return this.usableAuthUser(user);
  }

  /**
   * Used by the auth guard on every request: only ACTIVE users resolve.
   * Bearer-token checks need identity, status, and tenant data only — the
   * credential hash is never selected here.
   */
  async findActiveById(id: string): Promise<SafeDbUser | null> {
    const user = await this.prisma.user.findFirst({
      where: { id, status: UserStatus.ACTIVE },
      select: { ...SAFE_USER_SELECT, tenant: { select: { status: true } } },
    });
    return this.usableAuthUser(user);
  }

  /**
   * Resolves the PLATFORM SANDBOX tenant — the ONE tenant platform users
   * operate in on tenant-scoped routes (see ../tenants/platform-sandbox).
   * Strictly server-side: a FIXED slug looked up in the database, never
   * client input — AND the row must carry the VERIFIED isPlatformSandbox
   * marker, which only the sandbox seeder ever sets. The slug alone is not
   * proof of identity: a customer tenant that acquired the (previously
   * unreserved) slug must never become every platform user's request
   * context. A missing, non-ACTIVE, or UNMARKED sandbox resolves to null,
   * which keeps every tenant-scoped guard failing closed for platform
   * users; an unmarked slug-squatter is additionally logged loudly as a
   * collision so operators see WHY resolution refuses.
   */
  async findPlatformSandboxTenantId(): Promise<string | null> {
    const tenant = await this.prisma.tenant.findFirst({
      where: {
        slug: PLATFORM_SANDBOX_TENANT_SLUG,
        status: TenantStatus.ACTIVE,
        isPlatformSandbox: true,
      },
      select: { id: true },
    });
    if (tenant) {
      return tenant.id;
    }
    // Collision detection (only on the miss path, so the happy path stays
    // one query): a tenant holding the reserved slug WITHOUT the verified
    // marker is a customer tenant, never the sandbox — refuse it and say so.
    const squatter = await this.prisma.tenant.findFirst({
      where: {
        slug: PLATFORM_SANDBOX_TENANT_SLUG,
        isPlatformSandbox: false,
      },
      select: { id: true },
    });
    if (squatter) {
      this.logger.error(
        `A tenant holds the reserved "${PLATFORM_SANDBOX_TENANT_SLUG}" slug ` +
          'without the verified sandbox marker — refusing to resolve it as ' +
          'the platform sandbox (platform users stay without tenant context ' +
          'until the collision is resolved)',
      );
    }
    return null;
  }

  /**
   * lastLoginAt update and the LOGIN audit row commit in ONE transaction —
   * a login can never be recorded on the user without its audit trail
   * (same atomic-audit pattern as every other audited mutation).
   *
   * The active state is RE-CHECKED inside the transaction: a user or tenant
   * suspended between the credential lookup and this call must not get a
   * lastLoginAt update, a LOGIN audit row, or (in the caller) a token.
   * Returns null in that case — the caller fails with the generic 401.
   */
  markLoggedIn(
    id: string,
    buildAuditEntry: (user: SafeDbUser) => AuditEntry,
  ): Promise<SafeDbUser | null> {
    return this.prisma
      .$transaction(async (tx) => {
        // The active-state condition is BOUND TO THE WRITE: a conditional
        // updateMany whose predicate re-evaluates at write time. A separate
        // read-then-write pair would not be re-checked under READ COMMITTED,
        // so a suspension landing between the two could still be overwritten.
        // count === 0 ⇒ the account (or its tenant) is no longer eligible.
        const updated = await tx.user.updateMany({
          where: {
            id,
            status: UserStatus.ACTIVE,
            OR: [
              { userType: UserType.PLATFORM, tenantId: null },
              {
                userType: UserType.TENANT,
                tenant: { status: TenantStatus.ACTIVE },
              },
            ],
          },
          data: { lastLoginAt: new Date() },
        });
        if (updated.count === 0) {
          return null;
        }
        const user = await tx.user.findUnique({
          where: { id },
          select: SAFE_USER_SELECT,
        });
        if (!user) {
          // Row vanished mid-transaction — roll the lastLoginAt write back.
          throw new LoginIneligibleError();
        }
        if (user.userType === UserType.TENANT) {
          // The updateMany predicate above only READS tenant status — it
          // locks the user row, not the tenant row, so a suspension
          // committing right after the predicate matched could land while
          // this transaction still records the login. FOR SHARE blocks that
          // writer and re-reads the committed row: a concurrent suspension
          // either happens-before (this login rolls back) or happens-after
          // (the suspension waits for this commit). FOR SHARE, not FOR
          // UPDATE, so concurrent logins in one tenant do not serialize.
          const tenantRows = await tx.$queryRaw<
            { status: TenantStatus }[]
          >`SELECT "status" FROM "Tenant" WHERE "id" = ${user.tenantId} FOR SHARE`;
          if (tenantRows[0]?.status !== TenantStatus.ACTIVE) {
            throw new LoginIneligibleError();
          }
        }
        await this.auditLog.record(buildAuditEntry(user), tx);
        return user;
      })
      .catch((error: unknown) => {
        if (error instanceof LoginIneligibleError) {
          return null;
        }
        throw error;
      });
  }

  /**
   * Single source of truth for "may this account authenticate right now":
   * tenant users need an ACTIVE tenant (no tenant row at all — which the
   * schema CHECK should prevent — fails closed too); platform users must
   * still be genuine platform users (no tenant binding).
   */
  private usableAuthUser<
    T extends Pick<User, 'userType' | 'tenantId'> & {
      tenant: { status: TenantStatus } | null;
    },
  >(user: T | null): Omit<T, 'tenant'> | null {
    if (!user) {
      return null;
    }
    if (
      user.userType === UserType.TENANT &&
      user.tenant?.status !== TenantStatus.ACTIVE
    ) {
      return null;
    }
    if (user.userType === UserType.PLATFORM && user.tenantId !== null) {
      return null;
    }
    const { tenant: _tenant, ...plainUser } = user;
    return plainUser;
  }
}
