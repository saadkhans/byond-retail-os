import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, ProductBarcode } from '@prisma/client';
import {
  AuditActor,
  AuditEntry,
  SYSTEM_ACTOR_EMAIL,
} from '../common/audit/audit-log.service';
import { BrandsRepository } from './brands.repository';
import { CategoriesRepository } from './categories.repository';
import { CreateProductDto, ProductBarcodeInputDto } from './dto/create-product.dto';
import { QueryProductsDto } from './dto/query-products.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import {
  ProductsRepository,
  ProductWithRelations,
} from './products.repository';

function prismaErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null
    ? String((error as { code?: unknown }).code ?? '')
    : undefined;
}

@Injectable()
export class ProductsService {
  constructor(
    private readonly productsRepository: ProductsRepository,
    private readonly categoriesRepository: CategoriesRepository,
    private readonly brandsRepository: BrandsRepository,
  ) {}

  async create(
    tenantId: string,
    dto: CreateProductDto,
    actor?: AuditActor,
  ): Promise<ProductWithRelations> {
    const name = dto.name.trim();
    if (!name) {
      throw new BadRequestException('Product name is required');
    }
    // SKUs are case-insensitive identifiers; store the canonical uppercase.
    const sku = dto.sku.trim().toUpperCase();
    await this.assertCategoryAndBrand(tenantId, dto.categoryId, dto.brandId);
    const barcodes = this.normalizeBarcodes(dto.barcodes);

    try {
      return await this.productsRepository.create(
        tenantId,
        {
          sku,
          name,
          description: dto.description?.trim() || undefined,
          categoryId: dto.categoryId,
          brandId: dto.brandId,
          unitOfMeasure: dto.unitOfMeasure,
          status: dto.status,
          lowStockThreshold: dto.lowStockThreshold,
          barcodes,
        },
        (product) =>
          this.auditEntry(tenantId, actor, {
            action: AuditAction.CREATE,
            entityType: 'Product',
            entityId: product.id,
            after: product,
            reason: 'Product created',
          }),
      );
    } catch (error) {
      if (prismaErrorCode(error) === 'P2002') {
        throw new ConflictException(
          `SKU "${sku}" or one of the barcodes already exists for this tenant`,
        );
      }
      throw error;
    }
  }

  async findById(
    tenantId: string,
    id: string,
  ): Promise<ProductWithRelations> {
    const product = await this.productsRepository.findById(tenantId, id);
    if (!product) {
      throw new NotFoundException(`Product "${id}" not found`);
    }
    return product;
  }

  async search(
    tenantId: string,
    query: QueryProductsDto,
  ): Promise<{
    items: ProductWithRelations[];
    total: number;
    skip: number;
    take: number;
  }> {
    const skip = query.skip ?? 0;
    const take = query.take ?? 25;
    const { items, total } = await this.productsRepository.search(tenantId, {
      search: query.search?.trim() || undefined,
      barcode: query.barcode?.trim() || undefined,
      categoryId: query.categoryId,
      brandId: query.brandId,
      status: query.status,
      skip,
      take,
    });
    return { items, total, skip, take };
  }

  async update(
    tenantId: string,
    id: string,
    dto: UpdateProductDto,
    actor?: AuditActor,
  ): Promise<ProductWithRelations> {
    const data: Parameters<ProductsRepository['update']>[2] = {};
    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (!name) {
        throw new BadRequestException('Product name is required');
      }
      data.name = name;
    }
    if (dto.description !== undefined) {
      data.description = dto.description === null ? null : dto.description.trim();
    }
    if (dto.categoryId !== undefined) {
      data.categoryId = dto.categoryId;
    }
    if (dto.brandId !== undefined) {
      data.brandId = dto.brandId;
    }
    if (dto.unitOfMeasure !== undefined) {
      data.unitOfMeasure = dto.unitOfMeasure;
    }
    if (dto.status !== undefined) {
      data.status = dto.status;
    }
    if (dto.lowStockThreshold !== undefined) {
      data.lowStockThreshold = dto.lowStockThreshold;
    }
    if (Object.keys(data).length === 0) {
      throw new BadRequestException('No fields to update');
    }
    await this.assertCategoryAndBrand(
      tenantId,
      dto.categoryId ?? undefined,
      dto.brandId ?? undefined,
    );

    let updated: Awaited<ReturnType<ProductsRepository['update']>>;
    try {
      updated = await this.productsRepository.update(
        tenantId,
        id,
        data,
        (before, after) =>
          this.auditEntry(tenantId, actor, {
            action: AuditAction.UPDATE,
            entityType: 'Product',
            entityId: after.id,
            before,
            after,
            reason: 'Product updated',
          }),
      );
    } catch (error) {
      // The category/brand were validated above, but a concurrent delete can
      // remove them before this update lands, surfacing a Restrict FK
      // violation. Map it to a controlled 400 instead of a 500.
      if (prismaErrorCode(error) === 'P2003') {
        throw new BadRequestException(
          'Referenced category or brand no longer exists',
        );
      }
      throw error;
    }
    if (updated === 'uom-change-blocked') {
      throw new ConflictException(
        'Unit of measure cannot be changed once the product has inventory ' +
          'history; it would reinterpret every recorded stock quantity',
      );
    }
    if (updated === 'archive-blocked') {
      throw new ConflictException(
        'Cannot archive a product that still has on-hand stock; reduce its ' +
          'stock to zero first',
      );
    }
    if (!updated) {
      throw new NotFoundException(`Product "${id}" not found`);
    }
    return updated;
  }

  async delete(
    tenantId: string,
    id: string,
    actor?: AuditActor,
  ): Promise<void> {
    let deleted;
    try {
      deleted = await this.productsRepository.delete(tenantId, id, (product) =>
        this.auditEntry(tenantId, actor, {
          action: AuditAction.DELETE,
          entityType: 'Product',
          entityId: product.id,
          before: product,
          reason: 'Product deleted',
        }),
      );
    } catch (error) {
      if (prismaErrorCode(error) === 'P2003') {
        throw new ConflictException(
          'Product has inventory history and cannot be deleted; set its status to ARCHIVED instead',
        );
      }
      throw error;
    }
    if (!deleted) {
      throw new NotFoundException(`Product "${id}" not found`);
    }
  }

  async addBarcode(
    tenantId: string,
    productId: string,
    dto: ProductBarcodeInputDto,
    actor?: AuditActor,
  ): Promise<ProductBarcode> {
    const [normalized] = this.normalizeBarcodes([dto]) ?? [];
    let result: ProductBarcode | 'product-not-found';
    try {
      result = await this.productsRepository.addBarcode(
        tenantId,
        productId,
        normalized,
        (barcode) =>
          this.auditEntry(tenantId, actor, {
            action: AuditAction.CREATE,
            entityType: 'ProductBarcode',
            entityId: barcode.id,
            after: barcode,
            reason: 'Barcode added to product',
          }),
      );
    } catch (error) {
      if (prismaErrorCode(error) === 'P2002') {
        throw new ConflictException(
          `Barcode "${normalized.value}" is already assigned in this tenant`,
        );
      }
      throw error;
    }
    if (result === 'product-not-found') {
      throw new NotFoundException(`Product "${productId}" not found`);
    }
    return result;
  }

  async removeBarcode(
    tenantId: string,
    productId: string,
    barcodeId: string,
    actor?: AuditActor,
  ): Promise<void> {
    const removed = await this.productsRepository.removeBarcode(
      tenantId,
      productId,
      barcodeId,
      (barcode) =>
        this.auditEntry(tenantId, actor, {
          action: AuditAction.DELETE,
          entityType: 'ProductBarcode',
          entityId: barcode.id,
          before: barcode,
          reason: 'Barcode removed from product',
        }),
    );
    if (!removed) {
      throw new NotFoundException(
        `Barcode "${barcodeId}" not found on product "${productId}"`,
      );
    }
  }

  /** Optional references must exist IN THIS TENANT (scoped lookups). */
  private async assertCategoryAndBrand(
    tenantId: string,
    categoryId?: string,
    brandId?: string,
  ): Promise<void> {
    if (categoryId) {
      const category = await this.categoriesRepository.findById(
        tenantId,
        categoryId,
      );
      if (!category) {
        throw new BadRequestException(`Category "${categoryId}" not found`);
      }
    }
    if (brandId) {
      const brand = await this.brandsRepository.findById(tenantId, brandId);
      if (!brand) {
        throw new BadRequestException(`Brand "${brandId}" not found`);
      }
    }
  }

  private normalizeBarcodes(
    barcodes?: ProductBarcodeInputDto[],
  ): { value: string; format?: ProductBarcodeInputDto['format'] }[] {
    if (!barcodes || barcodes.length === 0) {
      return [];
    }
    const normalized = barcodes.map((barcode) => ({
      value: barcode.value.trim(),
      format: barcode.format,
    }));
    const values = new Set(normalized.map((barcode) => barcode.value));
    if (values.size !== normalized.length) {
      throw new BadRequestException('Duplicate barcode values in request');
    }
    return normalized;
  }

  private auditEntry(
    tenantId: string,
    actor: AuditActor | undefined,
    partial: Pick<
      AuditEntry,
      'action' | 'entityType' | 'entityId' | 'before' | 'after' | 'reason'
    >,
  ): AuditEntry {
    return {
      tenantId,
      actorId: actor?.id ?? null,
      actorEmail: actor?.email ?? SYSTEM_ACTOR_EMAIL,
      ...partial,
    };
  }
}
