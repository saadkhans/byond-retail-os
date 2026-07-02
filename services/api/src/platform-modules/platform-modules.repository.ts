import { Injectable } from '@nestjs/common';
import { PlatformModule } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * PLATFORM-SCOPED repository: the module catalog is global and seeded from
 * code (platform-module.catalog.ts).
 */
@Injectable()
export class PlatformModulesRepository {
  constructor(private readonly prisma: PrismaService) {}

  findAll(): Promise<PlatformModule[]> {
    return this.prisma.platformModule.findMany({ orderBy: { code: 'asc' } });
  }

  findByCode(code: string): Promise<PlatformModule | null> {
    return this.prisma.platformModule.findUnique({ where: { code } });
  }
}
