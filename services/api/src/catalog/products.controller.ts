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
import { ProductBarcode } from '@prisma/client';
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
import {
  CreateProductDto,
  ProductBarcodeInputDto,
} from './dto/create-product.dto';
import { QueryProductsDto } from './dto/query-products.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ProductsService } from './products.service';
import { ProductWithRelations } from './products.repository';

@ApiTags('catalog')
@ApiBearerAuth()
@TenantOnly()
@RequireModule('inventory')
@Controller('catalog/products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Post()
  @RequirePermissions('catalog:manage')
  @ApiOperation({
    summary: 'Create a product (SKU) in the caller’s tenant',
    description:
      'SKU is normalized to uppercase and unique per tenant. Optional ' +
      'barcodes are created with the product and must be unique per tenant.',
  })
  @ApiCreatedResponse({ description: 'Product created' })
  @ApiConflictResponse({ description: 'Duplicate SKU or barcode' })
  create(
    @CurrentTenantId() tenantId: string,
    @Body() dto: CreateProductDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<ProductWithRelations> {
    return this.productsService.create(tenantId, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }

  @Get()
  @RequirePermissions('catalog:read')
  @ApiOperation({
    summary: 'Search products in the caller’s tenant',
    description:
      'Filters: free-text search (name/SKU, case-insensitive), exact ' +
      'barcode, category, brand, status. Paginated via skip/take.',
  })
  search(
    @CurrentTenantId() tenantId: string,
    @Query() query: QueryProductsDto,
  ): Promise<{
    items: ProductWithRelations[];
    total: number;
    skip: number;
    take: number;
  }> {
    return this.productsService.search(tenantId, query);
  }

  @Get(':id')
  @RequirePermissions('catalog:read')
  @ApiOperation({ summary: 'Get a product with barcodes, category, brand' })
  @ApiNotFoundResponse({ description: 'Not found in this tenant' })
  findById(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
  ): Promise<ProductWithRelations> {
    return this.productsService.findById(tenantId, id);
  }

  @Patch(':id')
  @RequirePermissions('catalog:manage')
  @ApiOperation({
    summary: 'Update a product',
    description:
      'SKU is immutable; barcodes are managed via the barcode sub-endpoints.',
  })
  @ApiNotFoundResponse({ description: 'Not found in this tenant' })
  update(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Body() dto: UpdateProductDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<ProductWithRelations> {
    return this.productsService.update(tenantId, id, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions('catalog:manage')
  @ApiOperation({
    summary: 'Delete a product without inventory history',
    description:
      'Products already referenced by the inventory ledger cannot be ' +
      'deleted (the ledger is immutable); archive them instead.',
  })
  @ApiNoContentResponse({ description: 'Product deleted' })
  @ApiNotFoundResponse({ description: 'Not found in this tenant' })
  @ApiConflictResponse({ description: 'Product has inventory history' })
  async delete(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @CurrentUser() actor: RequestContext,
  ): Promise<void> {
    await this.productsService.delete(tenantId, id, {
      id: actor.userId,
      email: actor.email,
    });
  }

  @Post(':id/barcodes')
  @RequirePermissions('catalog:manage')
  @ApiOperation({ summary: 'Add a barcode to a product' })
  @ApiCreatedResponse({ description: 'Barcode added' })
  @ApiNotFoundResponse({ description: 'Product not found in this tenant' })
  @ApiConflictResponse({ description: 'Barcode already assigned' })
  addBarcode(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Body() dto: ProductBarcodeInputDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<ProductBarcode> {
    return this.productsService.addBarcode(tenantId, id, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }

  @Delete(':id/barcodes/:barcodeId')
  @HttpCode(204)
  @RequirePermissions('catalog:manage')
  @ApiOperation({ summary: 'Remove a barcode from a product' })
  @ApiNoContentResponse({ description: 'Barcode removed' })
  @ApiNotFoundResponse({ description: 'Not found in this tenant' })
  async removeBarcode(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Param('barcodeId') barcodeId: string,
    @CurrentUser() actor: RequestContext,
  ): Promise<void> {
    await this.productsService.removeBarcode(tenantId, id, barcodeId, {
      id: actor.userId,
      email: actor.email,
    });
  }
}
