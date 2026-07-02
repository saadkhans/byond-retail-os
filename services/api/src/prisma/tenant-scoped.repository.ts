import { TenantIdRequiredError } from '../common/errors/domain.errors';
import { PrismaService } from './prisma.service';

/**
 * Base class for all tenant-scoped repositories.
 *
 * Isolation contract (AGENTS.md): every public method of a subclass MUST take
 * `tenantId` as its first parameter and pass every `where`/`data` object
 * through `scope()` (or inject `requireTenantId()` explicitly). Callers can
 * therefore never issue an unscoped query, and a missing/empty tenantId is a
 * thrown error — never a wildcard.
 *
 * Platform-scoped entities (Tenant, Permission, PlatformModule) use plain
 * repositories that are explicitly named as platform-scoped instead.
 */
export abstract class TenantScopedRepository {
  constructor(protected readonly prisma: PrismaService) {}

  protected requireTenantId(tenantId: string): string {
    if (typeof tenantId !== 'string' || tenantId.trim() === '') {
      throw new TenantIdRequiredError(this.constructor.name);
    }
    return tenantId;
  }

  protected scope<T extends object>(
    tenantId: string,
    where?: T,
  ): T & { tenantId: string } {
    return {
      ...(where ?? ({} as T)),
      tenantId: this.requireTenantId(tenantId),
    };
  }
}
