import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ModuleEnabledGuard } from './module-enabled.guard';
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
    // Global guard: enforces @RequireModule(...) after authn/authz. Registered
    // here so it can resolve PlatformModulesService from this module's context;
    // AppModule imports AuthModule before this one, so it runs last.
    { provide: APP_GUARD, useClass: ModuleEnabledGuard },
  ],
  exports: [PlatformModulesService],
})
export class PlatformModulesModule {}
