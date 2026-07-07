import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
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
import { LocationsService } from './locations.service';

@ApiTags('locations')
@ApiBearerAuth()
@TenantOnly()
@Controller('locations')
export class LocationsController {
  constructor(private readonly locationsService: LocationsService) {}

  @Post()
  @RequirePermissions('location:manage')
  @ApiOperation({ summary: 'Create a location in the caller’s tenant' })
  @ApiCreatedResponse({ description: 'Location created' })
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
  @ApiOperation({ summary: 'List locations in the caller’s tenant' })
  findMany(@CurrentTenantId() tenantId: string): Promise<Location[]> {
    return this.locationsService.findMany(tenantId);
  }

  @Get(':id')
  @RequirePermissions('location:read')
  @ApiOperation({ summary: 'Get a location in the caller’s tenant' })
  @ApiNotFoundResponse({ description: 'Not found in this tenant' })
  findById(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
  ): Promise<Location> {
    return this.locationsService.findById(tenantId, id);
  }
}
