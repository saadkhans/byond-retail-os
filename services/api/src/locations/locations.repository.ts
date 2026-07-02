import { Injectable } from '@nestjs/common';
import { Location, LocationType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TenantScopedRepository } from '../prisma/tenant-scoped.repository';

@Injectable()
export class LocationsRepository extends TenantScopedRepository {
  constructor(prisma: PrismaService) {
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
  ): Promise<Location> {
    return this.prisma.location.create({
      data: { ...data, tenantId: this.requireTenantId(tenantId) },
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
