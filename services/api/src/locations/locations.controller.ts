import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Location } from '@prisma/client';
import {
  RequirePermissions,
  TenantOnly,
} from '../auth/decorators/access-policy.decorators';
import {
  CurrentTenantId,
  CurrentUser,
} from '../auth/decorators/request-context.decorators';
import { RequestContext } from '../auth/request-context';
import { CreateLocationDto } from './dto/create-location.dto';
import { QueryLocationsDto } from './dto/query-locations.dto';
import { UpdateLocationDto } from './dto/update-location.dto';
import { LocationsService } from './locations.service';

// The Location entity IS the store/branch/site concept — one controller
// serves both route prefixes (`/locations` is the original Phase 1 path,
// `/stores` the Phase 4 store-management alias).
// Tenant context comes exclusively from the authenticated user via
// @CurrentTenantId(). A tenantId in the request body is rejected by the
// global whitelist ValidationPipe (forbidNonWhitelisted).
@ApiTags('stores')
@ApiBearerAuth()
@TenantOnly()
@Controller(['locations', 'stores'])
export class LocationsController {
  constructor(private readonly locationsService: LocationsService) {}

  @Post()
  @RequirePermissions('location:manage')
  @ApiOperation({
    summary: 'Create a store/branch/site in the caller’s tenant',
    description: 'Code is normalized to uppercase and unique per tenant.',
  })
  @ApiCreatedResponse({ description: 'Store created' })
  @ApiConflictResponse({ description: 'Duplicate store code' })
  create(
    @CurrentTenantId() tenantId: string,
    @Body() dto: CreateLocationDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<Location> {
    return this.locationsService.create(tenantId, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }

  @Get()
  @RequirePermissions('location:read')
  @ApiOperation({
    summary: 'Search stores in the caller’s tenant',
    description:
      'Filters: free-text search (name/code, case-insensitive), type, ' +
      'status. Paginated via skip/take with a deterministic order ' +
      '(name, then id).',
  })
  search(
    @CurrentTenantId() tenantId: string,
    @Query() query: QueryLocationsDto,
  ): Promise<{ items: Location[]; total: number; skip: number; take: number }> {
    return this.locationsService.search(tenantId, query);
  }

  @Get(':id')
  @RequirePermissions('location:read')
  @ApiOperation({ summary: 'Get a store in the caller’s tenant' })
  @ApiNotFoundResponse({ description: 'Not found in this tenant' })
  findById(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
  ): Promise<Location> {
    return this.locationsService.findById(tenantId, id);
  }

  @Patch(':id')
  @RequirePermissions('location:manage')
  @ApiOperation({
    summary: 'Update a store (name, type, status, timezone, address)',
    description: 'The store code is immutable. Status changes are audited.',
  })
  @ApiNotFoundResponse({ description: 'Not found in this tenant' })
  update(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Body() dto: UpdateLocationDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<Location> {
    return this.locationsService.update(tenantId, id, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions('location:manage')
  @ApiOperation({
    summary: 'Delete a store that has no units or inventory history',
    description:
      'Stores referenced by retail units or inventory records cannot be ' +
      'deleted; set their status to CLOSED instead.',
  })
  @ApiNoContentResponse({ description: 'Store deleted' })
  @ApiNotFoundResponse({ description: 'Not found in this tenant' })
  @ApiConflictResponse({ description: 'Store is still referenced' })
  async delete(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @CurrentUser() actor: RequestContext,
  ): Promise<void> {
    await this.locationsService.delete(tenantId, id, {
      id: actor.userId,
      email: actor.email,
    });
  }
}
