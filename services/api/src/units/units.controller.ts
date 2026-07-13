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
import {
  RequireModule,
  RequirePermissions,
  TenantOnly,
} from '../auth/decorators/access-policy.decorators';
import {
  CurrentTenantId,
  CurrentUser,
} from '../auth/decorators/request-context.decorators';
import { RequestContext } from '../auth/request-context';
import { CreateUnitDto } from './dto/create-unit.dto';
import { QueryUnitsDto } from './dto/query-units.dto';
import { UpdateUnitDto } from './dto/update-unit.dto';
import { RetailUnitWithLocation } from './units.repository';
import { UnitsService } from './units.service';

// Tenant context comes exclusively from the authenticated user via
// @CurrentTenantId(). A tenantId in the request body is rejected by the
// global whitelist ValidationPipe (forbidNonWhitelisted).
@ApiTags('units')
@ApiBearerAuth()
@TenantOnly()
@RequireModule('devices')
@Controller('units')
export class UnitsController {
  constructor(private readonly unitsService: UnitsService) {}

  @Post()
  @RequirePermissions('unit:manage')
  @ApiOperation({
    summary: 'Create an autonomous retail unit in a store',
    description:
      'Code is normalized to uppercase and unique per tenant. The store ' +
      'must belong to the caller’s tenant. Lifecycle starts in DRAFT ' +
      'unless another status is given.',
  })
  @ApiCreatedResponse({ description: 'Unit created' })
  @ApiConflictResponse({ description: 'Duplicate unit code' })
  create(
    @CurrentTenantId() tenantId: string,
    @Body() dto: CreateUnitDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<RetailUnitWithLocation> {
    return this.unitsService.create(tenantId, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }

  @Get()
  @RequirePermissions('unit:read')
  @ApiOperation({
    summary: 'Search retail units in the caller’s tenant',
    description:
      'Filters: free-text search (name/code, case-insensitive), store, ' +
      'type, status. Paginated via skip/take with a deterministic order ' +
      '(name, then id).',
  })
  search(
    @CurrentTenantId() tenantId: string,
    @Query() query: QueryUnitsDto,
  ): Promise<{
    items: RetailUnitWithLocation[];
    total: number;
    skip: number;
    take: number;
  }> {
    return this.unitsService.search(tenantId, query);
  }

  @Get(':id')
  @RequirePermissions('unit:read')
  @ApiOperation({ summary: 'Get a retail unit with its store' })
  @ApiNotFoundResponse({ description: 'Not found in this tenant' })
  findById(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
  ): Promise<RetailUnitWithLocation> {
    return this.unitsService.findById(tenantId, id);
  }

  @Patch(':id')
  @RequirePermissions('unit:manage')
  @ApiOperation({
    summary: 'Update a retail unit',
    description:
      'The unit code is immutable and RETIRED is terminal. Lifecycle: ' +
      'DRAFT → ACTIVE ↔ MAINTENANCE/DISABLED → RETIRED. Status changes ' +
      'are audited with before/after snapshots.',
  })
  @ApiNotFoundResponse({ description: 'Not found in this tenant' })
  @ApiConflictResponse({ description: 'Unit is RETIRED (terminal)' })
  update(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Body() dto: UpdateUnitDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<RetailUnitWithLocation> {
    return this.unitsService.update(tenantId, id, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions('unit:manage')
  @ApiOperation({
    summary: 'Delete a retail unit without devices',
    description:
      'Units with devices assigned (or future inventory references) ' +
      'cannot be deleted — retire them instead.',
  })
  @ApiNoContentResponse({ description: 'Unit deleted' })
  @ApiNotFoundResponse({ description: 'Not found in this tenant' })
  @ApiConflictResponse({ description: 'Unit still has devices' })
  async delete(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @CurrentUser() actor: RequestContext,
  ): Promise<void> {
    await this.unitsService.delete(tenantId, id, {
      id: actor.userId,
      email: actor.email,
    });
  }
}
