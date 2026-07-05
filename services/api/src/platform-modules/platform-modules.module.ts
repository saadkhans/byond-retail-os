import { Module } from '@nestjs/common';
import { PlatformModulesRepository } from './platform-modules.repository';
import { PlatformModulesService } from './platform-modules.service';
import { TenantModulesRepository } from './tenant-modules.repository';

// Named PlatformModulesModule (plural) to avoid colliding with the Prisma
// model PlatformModule. Service-level only in Phase 1.
@Module({
  providers: [
    PlatformModulesService,
    PlatformModulesRepository,
    TenantModulesRepository,
  ],
  exports: [PlatformModulesService],
})
export class PlatformModulesModule {}
