import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Tenant } from '@prisma/client';
import { CreateTenantDto } from './dto/create-tenant.dto';
import { TenantsService } from './tenants.service';

@ApiTags('tenants')
@Controller('tenants')
export class TenantsController {
  constructor(private readonly tenantsService: TenantsService) {}

  @Post()
  @ApiOperation({ summary: 'Create a tenant with default modules enabled' })
  @ApiCreatedResponse({ description: 'Tenant created' })
  create(@Body() dto: CreateTenantDto): Promise<Tenant> {
    return this.tenantsService.create(dto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a tenant by id' })
  @ApiNotFoundResponse({ description: 'Tenant not found' })
  findById(@Param('id') id: string): Promise<Tenant> {
    return this.tenantsService.findById(id);
  }
}
