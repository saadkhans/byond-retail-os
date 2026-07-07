import { Module } from '@nestjs/common';
import { PlatformModulesController } from './platform-modules.controller';
import { PlatformModulesRepository } from './platform-modules.repository';
import { PlatformModulesService } from './platform-modules.service';
import { TenantModulesRepository } from './tenant-modules.repository';

// Named PlatformModulesModule (plural) to avoid colliding with the Prisma
// model PlatformModule.
@Module({
  controllers: [PlatformModulesController],
  providers: [
    PlatformModulesService,
    PlatformModulesRepository,
    TenantModulesRepository,
  ],
  exports: [PlatformModulesService],
})
export class PlatformModulesModule {}
