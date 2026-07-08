import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
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
import { Brand } from '@prisma/client';
import {
  RequirePermissions,
  TenantOnly,
} from '../auth/decorators/access-policy.decorators';
import {
  CurrentTenantId,
  CurrentUser,
} from '../auth/decorators/request-context.decorators';
import { RequestContext } from '../auth/request-context';
import { BrandsService } from './brands.service';
import { CreateBrandDto } from './dto/create-brand.dto';
import { UpdateBrandDto } from './dto/update-brand.dto';

@ApiTags('catalog')
@ApiBearerAuth()
@TenantOnly()
@Controller('catalog/brands')
export class BrandsController {
  constructor(private readonly brandsService: BrandsService) {}

  @Post()
  @RequirePermissions('catalog:manage')
  @ApiOperation({ summary: 'Create a brand in the caller’s tenant' })
  @ApiCreatedResponse({ description: 'Brand created' })
  @ApiConflictResponse({ description: 'Duplicate brand name' })
  create(
    @CurrentTenantId() tenantId: string,
    @Body() dto: CreateBrandDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<Brand> {
    return this.brandsService.create(tenantId, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }

  @Get()
  @RequirePermissions('catalog:read')
  @ApiOperation({ summary: 'List brands in the caller’s tenant' })
  findMany(@CurrentTenantId() tenantId: string): Promise<Brand[]> {
    return this.brandsService.findMany(tenantId);
  }

  @Get(':id')
  @RequirePermissions('catalog:read')
  @ApiOperation({ summary: 'Get a brand in the caller’s tenant' })
  @ApiNotFoundResponse({ description: 'Not found in this tenant' })
  findById(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
  ): Promise<Brand> {
    return this.brandsService.findById(tenantId, id);
  }

  @Patch(':id')
  @RequirePermissions('catalog:manage')
  @ApiOperation({ summary: 'Update a brand' })
  @ApiNotFoundResponse({ description: 'Not found in this tenant' })
  @ApiConflictResponse({ description: 'Duplicate brand name' })
  update(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Body() dto: UpdateBrandDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<Brand> {
    return this.brandsService.update(tenantId, id, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions('catalog:manage')
  @ApiOperation({ summary: 'Delete a brand' })
  @ApiNoContentResponse({ description: 'Brand deleted' })
  @ApiNotFoundResponse({ description: 'Not found in this tenant' })
  @ApiConflictResponse({ description: 'Brand still referenced by products' })
  async delete(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @CurrentUser() actor: RequestContext,
  ): Promise<void> {
    await this.brandsService.delete(tenantId, id, {
      id: actor.userId,
      email: actor.email,
    });
  }
}
