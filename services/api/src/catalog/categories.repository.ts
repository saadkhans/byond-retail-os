import { Injectable } from '@nestjs/common';
import { ProductCategory } from '@prisma/client';
import {
  AuditEntry,
  AuditLogService,
} from '../common/audit/audit-log.service';
import { PrismaService } from '../prisma/prisma.service';
import { TenantScopedRepository } from '../prisma/tenant-scoped.repository';

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
  ): Promise<ProductCategory | null> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.productCategory.findFirst({
        where: { id, tenantId: scopedTenantId },
      });
      if (!before) {
        return null;
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
