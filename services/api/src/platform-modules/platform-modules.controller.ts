import { Controller, Get, Param, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { PlatformModule, TenantModule } from '@prisma/client';
import {
  RequirePermissions,
  TenantOnly,
} from '../auth/decorators/access-policy.decorators';
import {
  CurrentTenantId,
  CurrentUser,
} from '../auth/decorators/request-context.decorators';
import { RequestContext } from '../auth/request-context';
import { PlatformModulesService } from './platform-modules.service';

@ApiTags('modules')
@ApiBearerAuth()
@Controller('modules')
export class PlatformModulesController {
  constructor(
    private readonly platformModulesService: PlatformModulesService,
  ) {}

  // Catalog listing is any-authenticated (platform and tenant users alike);
  // it exposes only the public module catalog, no tenant data.
  @Get('catalog')
  @RequirePermissions('module:read')
  @ApiOperation({ summary: 'List the platform module catalog' })
  listCatalog(): Promise<PlatformModule[]> {
    return this.platformModulesService.listCatalog();
  }

  @Get()
  @TenantOnly()
  @RequirePermissions('module:read')
  @ApiOperation({ summary: 'List module enablement for the caller’s tenant' })
  listForTenant(@CurrentTenantId() tenantId: string): Promise<TenantModule[]> {
    return this.platformModulesService.listForTenant(tenantId);
  }

  @Post(':code/enable')
  @TenantOnly()
  @RequirePermissions('module:manage')
  @ApiOperation({ summary: 'Enable an active module for the caller’s tenant' })
  @ApiNotFoundResponse({ description: 'Unknown or inactive module' })
  enable(
    @CurrentTenantId() tenantId: string,
    @Param('code') code: string,
    @CurrentUser() actor: RequestContext,
  ): Promise<TenantModule> {
    return this.platformModulesService.enable(tenantId, code, {
      id: actor.userId,
      email: actor.email,
    });
  }

  @Post(':code/disable')
  @TenantOnly()
  @RequirePermissions('module:manage')
  @ApiOperation({ summary: 'Disable a module for the caller’s tenant' })
  @ApiNotFoundResponse({ description: 'Unknown module' })
  disable(
    @CurrentTenantId() tenantId: string,
    @Param('code') code: string,
    @CurrentUser() actor: RequestContext,
  ): Promise<TenantModule> {
    return this.platformModulesService.disable(tenantId, code, {
      id: actor.userId,
      email: actor.email,
    });
  }
}
