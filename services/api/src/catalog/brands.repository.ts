import { Injectable } from '@nestjs/common';
import { Brand } from '@prisma/client';
import {
  AuditEntry,
  AuditLogService,
} from '../common/audit/audit-log.service';
import { brandAdvisoryLockKey } from '../common/locks';
import { PrismaService } from '../prisma/prisma.service';
import { TenantScopedRepository } from '../prisma/tenant-scoped.repository';

@Injectable()
export class BrandsRepository extends TenantScopedRepository {
  constructor(
    prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {
    super(prisma);
  }

  create(
    tenantId: string,
    data: { name: string; description?: string },
    buildAuditEntry: (brand: Brand) => AuditEntry,
  ): Promise<Brand> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      const brand = await tx.brand.create({
        data: { ...data, tenantId: scopedTenantId },
      });
      await this.auditLog.record(buildAuditEntry(brand), tx);
      return brand;
    });
  }

  findById(tenantId: string, id: string): Promise<Brand | null> {
    return this.prisma.brand.findFirst({
      where: this.scope(tenantId, { id }),
    });
  }

  findMany(tenantId: string): Promise<Brand[]> {
    return this.prisma.brand.findMany({
      where: this.scope(tenantId),
      orderBy: { name: 'asc' },
    });
  }

  update(
    tenantId: string,
    id: string,
    data: { name?: string; description?: string },
    buildAuditEntry: (before: Brand, after: Brand) => AuditEntry,
  ): Promise<Brand | null> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      // Serialize this update against a concurrent delete of the same brand
      // (delete() takes the identical lock). Without it, a delete could
      // snapshot the brand for its DELETE audit, then this update commits
      // first, leaving that snapshot stale relative to the row removed.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${brandAdvisoryLockKey(
        scopedTenantId,
        id,
      )}))`;
      const before = await tx.brand.findFirst({
        where: { id, tenantId: scopedTenantId },
      });
      if (!before) {
        return null;
      }
      const after = await tx.brand.update({
        where: { id: before.id },
        data,
      });
      await this.auditLog.record(buildAuditEntry(before, after), tx);
      return after;
    });
  }

  delete(
    tenantId: string,
    id: string,
    buildAuditEntry: (deleted: Brand) => AuditEntry,
  ): Promise<Brand | null> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      // Serialize against a concurrent update of the same brand (update() takes
      // the identical lock), so the DELETE audit `before` snapshot below can
      // never become stale relative to the row this transaction removes.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${brandAdvisoryLockKey(
        scopedTenantId,
        id,
      )}))`;
      const existing = await tx.brand.findFirst({
        where: { id, tenantId: scopedTenantId },
      });
      if (!existing) {
        return null;
      }
      await tx.brand.delete({ where: { id: existing.id } });
      await this.auditLog.record(buildAuditEntry(existing), tx);
      return existing;
    });
  }
}
