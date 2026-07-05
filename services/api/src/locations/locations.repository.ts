import { Injectable } from '@nestjs/common';
import { Location, LocationType, Prisma } from '@prisma/client';
import {
  AuditEntry,
  AuditLogService,
} from '../common/audit/audit-log.service';
import { PrismaService } from '../prisma/prisma.service';
import { TenantScopedRepository } from '../prisma/tenant-scoped.repository';

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
}
