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
import { productStockAdvisoryLockKey } from '../common/locks';
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

export type ProductWithBarcodes = Prisma.ProductGetPayload<{
  include: { barcodes: true };
}>;

/**
 * Rejections surfaced by update() as sentinels (mapped to HTTP errors in the
 * service), so the whole check-and-write stays inside one transaction:
 * - 'uom-change-blocked': the product already has ledger history, so its unit
 *   of measure can no longer change.
 * - 'archive-blocked': the product still has on-hand stock, so it cannot be
 *   archived (an archived product rejects the very adjustments that would
 *   draw its stock down).
 */
export type ProductUpdateRejection = 'uom-change-blocked' | 'archive-blocked';

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
        // id is the deterministic tie-breaker: name is not unique within a
        // tenant, so ties would otherwise reorder across skip/take pages.
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
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
  ): Promise<ProductWithRelations | ProductUpdateRejection | null> {
    const scopedTenantId = this.requireTenantId(tenantId);
    // The UOM-immutability and archive-with-stock guards below read ledger
    // state, so they must serialize against inventory adjustments for this
    // product — otherwise a concurrent adjustment can commit a movement/level
    // between the check and the write. Take the SAME per-product advisory lock
    // that adjust() takes; other updates (name, etc.) skip it.
    const needsStockLock =
      data.unitOfMeasure !== undefined ||
      data.status === ProductStatus.ARCHIVED;
    return this.prisma.$transaction(async (tx) => {
      if (needsStockLock) {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${productStockAdvisoryLockKey(
          scopedTenantId,
          id,
        )}))`;
      }
      const before = await tx.product.findFirst({
        where: { id, tenantId: scopedTenantId },
      });
      if (!before) {
        return null;
      }

      // The unit of measure is immutable once any ledger history exists:
      // changing it would silently reinterpret every recorded quantityDelta,
      // quantityAfter, and projected level from the old unit into the new one.
      // Checked inside the transaction against the ledger (the source of
      // truth), so a concurrent adjustment cannot slip a movement in between.
      if (
        data.unitOfMeasure !== undefined &&
        data.unitOfMeasure !== before.unitOfMeasure
      ) {
        const movementCount = await tx.inventoryMovement.count({
          where: { tenantId: scopedTenantId, productId: before.id },
        });
        if (movementCount > 0) {
          return 'uom-change-blocked' as const;
        }
      }

      // Archiving is blocked while on-hand stock remains: an ARCHIVED product
      // rejects all stock adjustments, so its stock could never be reduced or
      // disposed through the inventory APIs and would stay stranded.
      if (
        data.status === ProductStatus.ARCHIVED &&
        before.status !== ProductStatus.ARCHIVED
      ) {
        const onHand = await tx.inventoryLevel.findFirst({
          where: {
            tenantId: scopedTenantId,
            productId: before.id,
            quantity: { gt: 0 },
          },
          select: { id: true },
        });
        if (onHand) {
          return 'archive-blocked' as const;
        }
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
    buildAuditEntry: (deleted: ProductWithBarcodes) => AuditEntry,
  ): Promise<ProductWithBarcodes | null> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      // Serialize against inventory adjustments for this product (same lock
      // adjust() takes). Otherwise a concurrent adjustment can pass its
      // existence/status check, then this delete commits first, and the
      // adjustment fails with a raw FK error instead of a controlled 404/409.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${productStockAdvisoryLockKey(
        scopedTenantId,
        id,
      )}))`;

      // Load the product WITH its barcodes so the delete audit captures the
      // scan identifiers being removed. Without this the barcodes would
      // disappear via the bulk deleteMany with no auditable trace.
      const existing = await tx.product.findFirst({
        where: { id, tenantId: scopedTenantId },
        include: { barcodes: true },
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
      // `existing` carries the removed barcodes into the audit before-snapshot.
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
      // Serialize barcode mutations against a concurrent product delete (same
      // per-product lock delete() takes). Otherwise this add could land after
      // delete() snapshotted the product's barcodes, and delete's deleteMany
      // would then remove it with no record in the product DELETE audit.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${productStockAdvisoryLockKey(
        scopedTenantId,
        productId,
      )}))`;
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
      // Serialize with a concurrent product delete on the same product, so a
      // barcode removal and the product delete cannot interleave.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${productStockAdvisoryLockKey(
        scopedTenantId,
        productId,
      )}))`;
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
