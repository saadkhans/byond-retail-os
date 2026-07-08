import { Injectable } from '@nestjs/common';
import {
  BarcodeFormat,
  Prisma,
  Product,
  ProductBarcode,
  ProductStatus,
  UnitOfMeasure,
} from '@prisma/client';
import {
  AuditEntry,
  AuditLogService,
} from '../common/audit/audit-log.service';
import { PrismaService } from '../prisma/prisma.service';
import { TenantScopedRepository } from '../prisma/tenant-scoped.repository';

/** Read shape for product detail/list responses. */
export const PRODUCT_INCLUDE = {
  barcodes: true,
  category: true,
  brand: true,
} satisfies Prisma.ProductInclude;

export type ProductWithRelations = Prisma.ProductGetPayload<{
  include: typeof PRODUCT_INCLUDE;
}>;

export interface ProductSearchFilters {
  search?: string;
  barcode?: string;
  categoryId?: string;
  brandId?: string;
  status?: ProductStatus;
  skip?: number;
  take?: number;
}

@Injectable()
export class ProductsRepository extends TenantScopedRepository {
  constructor(
    prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {
    super(prisma);
  }

  create(
    tenantId: string,
    data: {
      sku: string;
      name: string;
      description?: string;
      categoryId?: string;
      brandId?: string;
      unitOfMeasure?: UnitOfMeasure;
      status?: ProductStatus;
      lowStockThreshold?: number;
      barcodes?: { value: string; format?: BarcodeFormat }[];
    },
    buildAuditEntry: (product: ProductWithRelations) => AuditEntry,
  ): Promise<ProductWithRelations> {
    const scopedTenantId = this.requireTenantId(tenantId);
    const { barcodes, ...productData } = data;
    return this.prisma.$transaction(async (tx) => {
      const product = await tx.product.create({
        data: {
          ...productData,
          tenantId: scopedTenantId,
          // Barcodes carry the DENORMALIZED tenantId (composite FK in
          // migration SQL guarantees it matches the product's tenant).
          ...(barcodes && barcodes.length > 0
            ? {
                barcodes: {
                  create: barcodes.map((barcode) => ({
                    ...barcode,
                    tenantId: scopedTenantId,
                  })),
                },
              }
            : {}),
        },
        include: PRODUCT_INCLUDE,
      });
      await this.auditLog.record(buildAuditEntry(product), tx);
      return product;
    });
  }

  findById(
    tenantId: string,
    id: string,
  ): Promise<ProductWithRelations | null> {
    return this.prisma.product.findFirst({
      where: this.scope(tenantId, { id }),
      include: PRODUCT_INCLUDE,
    });
  }

  async search(
    tenantId: string,
    filters: ProductSearchFilters,
  ): Promise<{ items: ProductWithRelations[]; total: number }> {
    const where: Prisma.ProductWhereInput = this.scope(tenantId);
    if (filters.status) {
      where.status = filters.status;
    }
    if (filters.categoryId) {
      where.categoryId = filters.categoryId;
    }
    if (filters.brandId) {
      where.brandId = filters.brandId;
    }
    if (filters.barcode) {
      where.barcodes = { some: { value: filters.barcode } };
    }
    if (filters.search) {
      where.OR = [
        { name: { contains: filters.search, mode: 'insensitive' } },
        { sku: { contains: filters.search, mode: 'insensitive' } },
      ];
    }
    const [items, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        include: PRODUCT_INCLUDE,
        orderBy: { name: 'asc' },
        skip: filters.skip ?? 0,
        take: filters.take ?? 25,
      }),
      this.prisma.product.count({ where }),
    ]);
    return { items, total };
  }

  update(
    tenantId: string,
    id: string,
    data: {
      name?: string;
      description?: string | null;
      categoryId?: string | null;
      brandId?: string | null;
      unitOfMeasure?: UnitOfMeasure;
      status?: ProductStatus;
      lowStockThreshold?: number | null;
    },
    buildAuditEntry: (
      before: Product,
      after: ProductWithRelations,
    ) => AuditEntry,
  ): Promise<ProductWithRelations | null> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.product.findFirst({
        where: { id, tenantId: scopedTenantId },
      });
      if (!before) {
        return null;
      }
      const after = await tx.product.update({
        where: { id: before.id },
        data,
        include: PRODUCT_INCLUDE,
      });
      await this.auditLog.record(buildAuditEntry(before, after), tx);
      return after;
    });
  }

  delete(
    tenantId: string,
    id: string,
    buildAuditEntry: (deleted: Product) => AuditEntry,
  ): Promise<Product | null> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.product.findFirst({
        where: { id, tenantId: scopedTenantId },
      });
      if (!existing) {
        return null;
      }
      // Barcodes are owned by the product; inventory rows are NOT deleted —
      // their Restrict FKs abort this transaction (mapped to 409 upstream).
      await tx.productBarcode.deleteMany({
        where: { productId: existing.id, tenantId: scopedTenantId },
      });
      await tx.product.delete({ where: { id: existing.id } });
      await this.auditLog.record(buildAuditEntry(existing), tx);
      return existing;
    });
  }

  addBarcode(
    tenantId: string,
    productId: string,
    data: { value: string; format?: BarcodeFormat },
    buildAuditEntry: (barcode: ProductBarcode) => AuditEntry,
  ): Promise<ProductBarcode | 'product-not-found'> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      const product = await tx.product.findFirst({
        where: { id: productId, tenantId: scopedTenantId },
      });
      if (!product) {
        return 'product-not-found' as const;
      }
      const barcode = await tx.productBarcode.create({
        data: { ...data, productId: product.id, tenantId: scopedTenantId },
      });
      await this.auditLog.record(buildAuditEntry(barcode), tx);
      return barcode;
    });
  }

  removeBarcode(
    tenantId: string,
    productId: string,
    barcodeId: string,
    buildAuditEntry: (deleted: ProductBarcode) => AuditEntry,
  ): Promise<ProductBarcode | null> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.productBarcode.findFirst({
        where: { id: barcodeId, productId, tenantId: scopedTenantId },
      });
      if (!existing) {
        return null;
      }
      await tx.productBarcode.delete({ where: { id: existing.id } });
      await this.auditLog.record(buildAuditEntry(existing), tx);
      return existing;
    });
  }
}
