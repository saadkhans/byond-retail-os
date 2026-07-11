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
import { ProductCategory } from '@prisma/client';
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
import { CategoriesService } from './categories.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';

// Tenant context comes exclusively from the authenticated user via
// @CurrentTenantId(). A tenantId in the request body is rejected by the
// global whitelist ValidationPipe (forbidNonWhitelisted).
@ApiTags('catalog')
@ApiBearerAuth()
@TenantOnly()
@RequireModule('inventory')
@Controller('catalog/categories')
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @Post()
  @RequirePermissions('catalog:manage')
  @ApiOperation({
    summary: 'Create a product category in the caller’s tenant',
    description:
      'Categories support an optional single-parent hierarchy; the parent ' +
      'must belong to the same tenant.',
  })
  @ApiCreatedResponse({ description: 'Category created' })
  @ApiConflictResponse({ description: 'Duplicate category name' })
  create(
    @CurrentTenantId() tenantId: string,
    @Body() dto: CreateCategoryDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<ProductCategory> {
    return this.categoriesService.create(tenantId, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }

  @Get()
  @RequirePermissions('catalog:read')
  @ApiOperation({ summary: 'List product categories in the caller’s tenant' })
  findMany(@CurrentTenantId() tenantId: string): Promise<ProductCategory[]> {
    return this.categoriesService.findMany(tenantId);
  }

  @Get(':id')
  @RequirePermissions('catalog:read')
  @ApiOperation({ summary: 'Get a product category in the caller’s tenant' })
  @ApiNotFoundResponse({ description: 'Not found in this tenant' })
  findById(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
  ): Promise<ProductCategory> {
    return this.categoriesService.findById(tenantId, id);
  }

  @Patch(':id')
  @RequirePermissions('catalog:manage')
  @ApiOperation({ summary: 'Update a product category' })
  @ApiNotFoundResponse({ description: 'Not found in this tenant' })
  @ApiConflictResponse({ description: 'Duplicate category name' })
  update(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Body() dto: UpdateCategoryDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<ProductCategory> {
    return this.categoriesService.update(tenantId, id, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions('catalog:manage')
  @ApiOperation({ summary: 'Delete a product category' })
  @ApiNoContentResponse({ description: 'Category deleted' })
  @ApiNotFoundResponse({ description: 'Not found in this tenant' })
  @ApiConflictResponse({
    description: 'Category still referenced by products or child categories',
  })
  async delete(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @CurrentUser() actor: RequestContext,
  ): Promise<void> {
    await this.categoriesService.delete(tenantId, id, {
      id: actor.userId,
      email: actor.email,
    });
  }
}
