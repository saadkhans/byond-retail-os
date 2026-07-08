import { Injectable } from '@nestjs/common';
import { ProductCategory } from '@prisma/client';
import {
  AuditEntry,
  AuditLogService,
} from '../common/audit/audit-log.service';
import { PrismaService } from '../prisma/prisma.service';
import { TenantScopedRepository } from '../prisma/tenant-scoped.repository';

// Defensive cap when walking the parent chain inside the transaction; a
// legitimate retail category tree never approaches this depth.
const MAX_TREE_DEPTH = 64;

/**
 * update() returns this sentinel (mapped to a 409 in the service) when the
 * requested parent would put the category on its own ancestor chain. The
 * check runs inside the move transaction under a per-tenant advisory lock, so
 * it also catches cycles that only two CONCURRENT moves could form.
 */
export type CategoryMoveRejection = 'cycle-detected';

@Injectable()
export class CategoriesRepository extends TenantScopedRepository {
  constructor(
    prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {
    super(prisma);
  }

  create(
    tenantId: string,
    data: { name: string; description?: string; parentId?: string },
    buildAuditEntry: (category: ProductCategory) => AuditEntry,
  ): Promise<ProductCategory> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      const category = await tx.productCategory.create({
        data: { ...data, tenantId: scopedTenantId },
      });
      await this.auditLog.record(buildAuditEntry(category), tx);
      return category;
    });
  }

  findById(tenantId: string, id: string): Promise<ProductCategory | null> {
    return this.prisma.productCategory.findFirst({
      where: this.scope(tenantId, { id }),
    });
  }

  findMany(tenantId: string): Promise<ProductCategory[]> {
    return this.prisma.productCategory.findMany({
      where: this.scope(tenantId),
      orderBy: { name: 'asc' },
    });
  }

  /**
   * Scoped update: the row is re-fetched WITH the tenant filter inside the
   * transaction, so a foreign id can never be updated. Returns null when the
   * category does not exist in this tenant.
   */
  update(
    tenantId: string,
    id: string,
    data: {
      name?: string;
      description?: string;
      parentId?: string | null;
    },
    buildAuditEntry: (
      before: ProductCategory,
      after: ProductCategory,
    ) => AuditEntry,
  ): Promise<ProductCategory | CategoryMoveRejection | null> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      // Serialize every category-tree MOVE within a tenant. Without this, two
      // concurrent reparents can each validate against the old tree and commit
      // a cycle between them (A under B while B under A). The advisory lock is
      // held for the rest of this transaction and released automatically on
      // commit/rollback, so the second move waits and then re-validates
      // against the first's committed change. Only taken when a parent is
      // actually being set (parentId is a non-null string).
      if (typeof data.parentId === 'string') {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`category-tree:${scopedTenantId}`}))`;
      }

      const before = await tx.productCategory.findFirst({
        where: { id, tenantId: scopedTenantId },
      });
      if (!before) {
        return null;
      }

      // Authoritative acyclicity check, now holding the tenant tree lock and
      // therefore seeing every previously-committed move: walk up from the new
      // parent; reaching this category (including the new parent BEING this
      // category) means the move would create a cycle.
      if (typeof data.parentId === 'string') {
        let ancestorId: string | null = data.parentId;
        for (let depth = 0; ancestorId; depth += 1) {
          if (depth >= MAX_TREE_DEPTH || ancestorId === before.id) {
            return 'cycle-detected' as const;
          }
          const ancestor: { parentId: string | null } | null =
            await tx.productCategory.findFirst({
              where: { id: ancestorId, tenantId: scopedTenantId },
              select: { parentId: true },
            });
          ancestorId = ancestor?.parentId ?? null;
        }
      }

      const after = await tx.productCategory.update({
        where: { id: before.id },
        data,
      });
      await this.auditLog.record(buildAuditEntry(before, after), tx);
      return after;
    });
  }

  /** Scoped delete; returns null when not found in this tenant. */
  delete(
    tenantId: string,
    id: string,
    buildAuditEntry: (deleted: ProductCategory) => AuditEntry,
  ): Promise<ProductCategory | null> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.productCategory.findFirst({
        where: { id, tenantId: scopedTenantId },
      });
      if (!existing) {
        return null;
      }
      await tx.productCategory.delete({ where: { id: existing.id } });
      await this.auditLog.record(buildAuditEntry(existing), tx);
      return existing;
    });
  }
}
