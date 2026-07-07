import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Tenant } from '@prisma/client';
import {
  PlatformOnly,
  RequirePermissions,
} from '../auth/decorators/access-policy.decorators';
import { CurrentUser } from '../auth/decorators/request-context.decorators';
import { RequestContext } from '../auth/request-context';
import { CreateTenantDto } from './dto/create-tenant.dto';
import { TenantsService } from './tenants.service';

// Tenant administration is the platform control plane: platform users only,
// gated by tenant:* permissions. Tenant users never manage tenant records.
@ApiTags('tenants')
@ApiBearerAuth()
@PlatformOnly()
@Controller('tenants')
export class TenantsController {
  constructor(private readonly tenantsService: TenantsService) {}

  @Post()
  @RequirePermissions('tenant:manage')
  @ApiOperation({ summary: 'Create a tenant with default modules enabled' })
  @ApiCreatedResponse({ description: 'Tenant created' })
  @ApiForbiddenResponse({ description: 'Requires platform tenant:manage' })
  create(
    @Body() dto: CreateTenantDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<Tenant> {
    return this.tenantsService.create(dto, {
      id: actor.userId,
      email: actor.email,
    });
  }

  @Get(':id')
  @RequirePermissions('tenant:read')
  @ApiOperation({ summary: 'Get a tenant by id' })
  @ApiNotFoundResponse({ description: 'Tenant not found' })
  findById(@Param('id') id: string): Promise<Tenant> {
    return this.tenantsService.findById(id);
  }
}
