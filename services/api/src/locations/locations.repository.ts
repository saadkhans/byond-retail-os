import { Injectable } from '@nestjs/common';
import {
  Location,
  LocationStatus,
  LocationType,
  Prisma,
} from '@prisma/client';
import {
  AuditEntry,
  AuditLogService,
} from '../common/audit/audit-log.service';
import { locationAdvisoryLockKey } from '../common/locks';
import { PrismaService } from '../prisma/prisma.service';
import { TenantScopedRepository } from '../prisma/tenant-scoped.repository';

export interface LocationSearchFilters {
  search?: string;
  type?: LocationType;
  status?: LocationStatus;
  skip?: number;
  take?: number;
}

@Injectable()
export class LocationsRepository extends TenantScopedRepository {
  constructor(
    prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {
    super(prisma);
  }

  create(
    tenantId: string,
    data: {
      name: string;
      code: string;
      type: LocationType;
      timezone?: string;
      address?: Prisma.InputJsonValue;
    },
    buildAuditEntry: (location: Location) => AuditEntry,
  ): Promise<Location> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      const location = await tx.location.create({
        data: { ...data, tenantId: scopedTenantId },
      });
      await this.auditLog.record(buildAuditEntry(location), tx);
      return location;
    });
  }

  findById(tenantId: string, id: string): Promise<Location | null> {
    return this.prisma.location.findFirst({
      where: this.scope(tenantId, { id }),
    });
  }

  findMany(tenantId: string): Promise<Location[]> {
    return this.prisma.location.findMany({ where: this.scope(tenantId) });
  }

  async search(
    tenantId: string,
    filters: LocationSearchFilters,
  ): Promise<{ items: Location[]; total: number }> {
    const where: Prisma.LocationWhereInput = this.scope(tenantId);
    if (filters.type) {
      where.type = filters.type;
    }
    if (filters.status) {
      where.status = filters.status;
    }
    if (filters.search) {
      where.OR = [
        { name: { contains: filters.search, mode: 'insensitive' } },
        { code: { contains: filters.search, mode: 'insensitive' } },
      ];
    }
    const [items, total] = await Promise.all([
      this.prisma.location.findMany({
        where,
        // id is the deterministic tie-breaker: name is not unique within a
        // tenant, so ties would otherwise reorder across skip/take pages.
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip: filters.skip ?? 0,
        take: filters.take ?? 25,
      }),
      this.prisma.location.count({ where }),
    ]);
    return { items, total };
  }

  update(
    tenantId: string,
    id: string,
    data: {
      name?: string;
      type?: LocationType;
      status?: LocationStatus;
      timezone?: string;
      address?: Prisma.InputJsonValue;
    },
    buildAuditEntry: (before: Location, after: Location) => AuditEntry,
  ): Promise<Location | null> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      // Serialize with delete() (same key), so the DELETE audit's `before`
      // snapshot always matches the row actually removed.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${locationAdvisoryLockKey(
        scopedTenantId,
        id,
      )}))::text`;
      const before = await tx.location.findFirst({
        where: { id, tenantId: scopedTenantId },
      });
      if (!before) {
        return null;
      }
      // Tenant scope IN the destructive predicate (repo invariant): the
      // composite key makes the write itself tenant-isolated — never
      // only the prior lookup.
      const after = await tx.location.update({
        where: { id_tenantId: { id: before.id, tenantId: scopedTenantId } },
        data,
      });
      await this.auditLog.record(buildAuditEntry(before, after), tx);
      return after;
    });
  }

  delete(
    tenantId: string,
    id: string,
    buildAuditEntry: (deleted: Location) => AuditEntry,
  ): Promise<Location | null> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${locationAdvisoryLockKey(
        scopedTenantId,
        id,
      )}))::text`;
      const existing = await tx.location.findFirst({
        where: { id, tenantId: scopedTenantId },
      });
      if (!existing) {
        return null;
      }
      // Restrict FKs (retail units, inventory levels/movements) abort this
      // transaction with P2003 when the store is still referenced — mapped
      // to a controlled 409 in the service.
      await tx.location.delete({
        where: { id_tenantId: { id: existing.id, tenantId: scopedTenantId } },
      });
      await this.auditLog.record(buildAuditEntry(existing), tx);
      return existing;
    });
  }
}
