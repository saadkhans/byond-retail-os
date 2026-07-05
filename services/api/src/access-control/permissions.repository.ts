import { Injectable } from '@nestjs/common';
import { Permission } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * PLATFORM-SCOPED repository: the permission catalog is global, seeded from
 * code (permission.catalog.ts), and read-only at runtime by design.
 */
@Injectable()
export class PermissionsRepository {
  constructor(private readonly prisma: PrismaService) {}

  findAll(): Promise<Permission[]> {
    return this.prisma.permission.findMany({ orderBy: { code: 'asc' } });
  }

  findByCode(code: string): Promise<Permission | null> {
    return this.prisma.permission.findUnique({ where: { code } });
  }
}
