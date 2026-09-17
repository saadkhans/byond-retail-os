import { Injectable } from '@nestjs/common';
import {
  GoodsReceipt,
  GoodsReceiptDiscrepancy,
  InventoryMovementType,
  Prisma,
  PurchaseOrder,
  PurchaseOrderStatus,
  Supplier,
  SupplierProduct,
  SupplierStatus,
} from '@prisma/client';
import { AuditEntry, AuditLogService } from '../common/audit/audit-log.service';
import { procurementReferenceAdvisoryLockKey } from '../common/locks';
import {
  AdjustmentRejected,
  InventoryRepository,
} from '../inventory/inventory.repository';
import { PrismaService } from '../prisma/prisma.service';
import { TenantScopedRepository } from '../prisma/tenant-scoped.repository';
import {
  GOODS_RECEIPT_REFERENCE_PREFIX,
  PURCHASE_ORDER_REFERENCE_PREFIX,
  RECEIPT_MOVEMENT_REFERENCE_TYPE,
} from './procurement.constants';
import {
  AllocatedReference,
  derivePurchaseOrderStatus,
  nextReference,
  OrderLineQuantities,
  orderTotalMinor,
  receivedPacksByLine,
  suggestDiscrepancy,
  unitsForPacks,
} from './procurement.logic';

export const SUPPLIER_PRODUCT_INCLUDE = {
  product: { select: { id: true, sku: true, name: true, status: true } },
  supplier: { select: { id: true, code: true, name: true } },
} satisfies Prisma.SupplierProductInclude;

export type SupplierProductWithRefs = Prisma.SupplierProductGetPayload<{
  include: typeof SUPPLIER_PRODUCT_INCLUDE;
}>;

export const ORDER_DETAIL_INCLUDE = {
  supplier: { select: { id: true, code: true, name: true } },
  location: { select: { id: true, code: true, name: true } },
  lines: {
    include: {
      product: { select: { id: true, sku: true, name: true } },
      // The supplier's own identifier for the product. Carried on the detail
      // shape so submission can quote what the SUPPLIER calls the item
      // rather than our SKU, which is meaningless on their paperwork.
      supplierProduct: { select: { id: true, supplierSku: true } },
    },
    orderBy: { createdAt: 'asc' },
  },
  receipts: {
    include: {
      lines: {
        include: {
          product: { select: { id: true, sku: true, name: true } },
        },
        orderBy: { createdAt: 'asc' },
      },
    },
    orderBy: { receivedAt: 'desc' },
  },
} satisfies Prisma.PurchaseOrderInclude;

export type PurchaseOrderDetail = Prisma.PurchaseOrderGetPayload<{
  include: typeof ORDER_DETAIL_INCLUDE;
}>;

export const RECEIPT_DETAIL_INCLUDE = {
  lines: {
    include: { product: { select: { id: true, sku: true, name: true } } },
    orderBy: { createdAt: 'asc' },
  },
} satisfies Prisma.GoodsReceiptInclude;

export type GoodsReceiptDetail = Prisma.GoodsReceiptGetPayload<{
  include: typeof RECEIPT_DETAIL_INCLUDE;
}>;

export type CreateSupplierRejection = 'code-taken';
export type UpdateSupplierRejection = 'not-found' | 'code-taken';
export type SupplierProductRejection =
  | 'supplier-not-found'
  | 'product-not-found'
  | 'supplier-sku-taken';
export type CreateOrderRejection =
  | 'supplier-not-found'
  | 'supplier-archived'
  | 'location-not-found'
  | 'product-not-found'
  | 'duplicate-product'
  | 'no-lines';
export type OrderTransitionRejection =
  | 'not-found'
  | 'illegal-transition'
  | 'no-lines';
export type ReceiptRejection =
  | 'order-not-found'
  | 'order-not-receivable'
  | 'line-not-on-order'
  | 'duplicate-line'
  | 'no-lines'
  | 'reference-mismatch'
  | 'stock-rejected';

/** Audit entry builders the service supplies, so the repository stays dumb. */
export interface ReceiptAuditBuilders {
  receiptPosted: (receipt: GoodsReceipt) => AuditEntry;
  orderStatusChanged: (
    order: PurchaseOrder,
    from: PurchaseOrderStatus,
    to: PurchaseOrderStatus,
  ) => AuditEntry;
}

export interface PostReceiptLineInput {
  purchaseOrderLineId: string;
  /** Packs accepted. Zero is legal — the line arrived empty. */
  quantityReceived: number;
  discrepancy?: GoodsReceiptDiscrepancy;
  discrepancyNote?: string | null;
}

export interface PostReceiptInput {
  deliveryNote?: string | null;
  notes?: string | null;
  receivedAt?: Date;
  idempotencyKey?: string | null;
  receivedById?: string;
  lines: readonly PostReceiptLineInput[];
}

/**
 * Procurement data access.
 *
 * The one rule this class exists to enforce: **receiving never writes a stock
 * quantity.** Every unit admitted by a goods receipt goes through
 * `InventoryRepository.applyMovement` inside the receipt's own transaction, so
 * the ledger and the projection commit or roll back together exactly as they
 * do for a sale or a manual adjustment.
 */
@Injectable()
export class ProcurementRepository extends TenantScopedRepository {
  constructor(
    prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly inventoryRepository: InventoryRepository,
  ) {
    super(prisma);
  }

  // ------------------------------------------------------------ suppliers

  createSupplier(
    tenantId: string,
    data: {
      code: string;
      name: string;
      contactName?: string | null;
      contactEmail?: string | null;
      contactPhone?: string | null;
      leadTimeDays?: number | null;
      notes?: string | null;
      createdById?: string;
    },
    buildAuditEntry: (supplier: Supplier) => AuditEntry,
  ): Promise<Supplier | CreateSupplierRejection> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      const clash = await tx.supplier.findFirst({
        where: { tenantId: scopedTenantId, code: data.code },
        select: { id: true },
      });
      if (clash) {
        return 'code-taken' as const;
      }
      const supplier = await tx.supplier.create({
        data: {
          tenantId: scopedTenantId,
          code: data.code,
          name: data.name,
          contactName: data.contactName ?? null,
          contactEmail: data.contactEmail ?? null,
          contactPhone: data.contactPhone ?? null,
          leadTimeDays: data.leadTimeDays ?? null,
          notes: data.notes ?? null,
          createdById: data.createdById,
        },
      });
      await this.auditLog.record(buildAuditEntry(supplier), tx);
      return supplier;
    });
  }

  async findSuppliers(
    tenantId: string,
    query: { status?: SupplierStatus; skip?: number; take?: number },
  ): Promise<{ items: Supplier[]; total: number }> {
    const where = this.scope(tenantId, {
      ...(query.status ? { status: query.status } : {}),
    });
    const [items, total] = await this.prisma.$transaction([
      this.prisma.supplier.findMany({
        where,
        orderBy: [{ code: 'asc' }],
        skip: query.skip ?? 0,
        take: query.take ?? 50,
      }),
      this.prisma.supplier.count({ where }),
    ]);
    return { items, total };
  }

  findSupplierById(tenantId: string, id: string): Promise<Supplier | null> {
    return this.prisma.supplier.findFirst({
      where: this.scope(tenantId, { id }),
    });
  }

  updateSupplier(
    tenantId: string,
    id: string,
    data: {
      code?: string;
      name?: string;
      status?: SupplierStatus;
      contactName?: string | null;
      contactEmail?: string | null;
      contactPhone?: string | null;
      leadTimeDays?: number | null;
      notes?: string | null;
    },
    buildAuditEntry: (before: Supplier, after: Supplier) => AuditEntry,
  ): Promise<Supplier | UpdateSupplierRejection> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.supplier.findFirst({
        where: { id, tenantId: scopedTenantId },
      });
      if (!before) {
        return 'not-found' as const;
      }
      if (data.code && data.code !== before.code) {
        const clash = await tx.supplier.findFirst({
          where: { tenantId: scopedTenantId, code: data.code },
          select: { id: true },
        });
        if (clash) {
          return 'code-taken' as const;
        }
      }
      const after = await tx.supplier.update({
        where: { id_tenantId: { id: before.id, tenantId: scopedTenantId } },
        data: {
          ...(data.code !== undefined ? { code: data.code } : {}),
          ...(data.name !== undefined ? { name: data.name } : {}),
          ...(data.status !== undefined ? { status: data.status } : {}),
          ...(data.contactName !== undefined
            ? { contactName: data.contactName }
            : {}),
          ...(data.contactEmail !== undefined
            ? { contactEmail: data.contactEmail }
            : {}),
          ...(data.contactPhone !== undefined
            ? { contactPhone: data.contactPhone }
            : {}),
          ...(data.leadTimeDays !== undefined
            ? { leadTimeDays: data.leadTimeDays }
            : {}),
          ...(data.notes !== undefined ? { notes: data.notes } : {}),
        },
      });
      await this.auditLog.record(buildAuditEntry(before, after), tx);
      return after;
    });
  }

  // ---------------------------------------------------- supplier products

  /**
   * Creates or updates what a supplier charges for a product, APPENDING a
   * `SupplierProductCost` row whenever the cost or pack size actually changes.
   *
   * The mirrored `unitCostMinor` on the link row is a projection of the newest
   * history row, kept for fast reads — the history is the record. This is the
   * same shape as retail pricing: a cost is never silently overwritten with no
   * trace of what it used to be.
   */
  upsertSupplierProduct(
    tenantId: string,
    data: {
      supplierId: string;
      productId: string;
      supplierSku: string;
      packSize: number;
      unitCostMinor: number;
      currencyCode: string;
      leadTimeDays?: number | null;
      isPreferred?: boolean;
      reason?: string | null;
      createdById?: string;
    },
    buildAuditEntry: (
      link: SupplierProduct,
      before: SupplierProduct | null,
    ) => AuditEntry,
  ): Promise<SupplierProduct | SupplierProductRejection> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      const supplier = await tx.supplier.findFirst({
        where: { id: data.supplierId, tenantId: scopedTenantId },
        select: { id: true },
      });
      if (!supplier) {
        return 'supplier-not-found' as const;
      }
      const product = await tx.product.findFirst({
        where: { id: data.productId, tenantId: scopedTenantId },
        select: { id: true },
      });
      if (!product) {
        return 'product-not-found' as const;
      }
      const skuClash = await tx.supplierProduct.findFirst({
        where: {
          tenantId: scopedTenantId,
          supplierId: data.supplierId,
          supplierSku: data.supplierSku,
          productId: { not: data.productId },
        },
        select: { id: true },
      });
      if (skuClash) {
        return 'supplier-sku-taken' as const;
      }
      const before = await tx.supplierProduct.findFirst({
        where: {
          tenantId: scopedTenantId,
          supplierId: data.supplierId,
          productId: data.productId,
        },
      });
      const link = before
        ? await tx.supplierProduct.update({
            where: {
              id_tenantId: { id: before.id, tenantId: scopedTenantId },
            },
            data: {
              supplierSku: data.supplierSku,
              packSize: data.packSize,
              unitCostMinor: data.unitCostMinor,
              currencyCode: data.currencyCode,
              leadTimeDays: data.leadTimeDays ?? null,
              ...(data.isPreferred !== undefined
                ? { isPreferred: data.isPreferred }
                : {}),
            },
          })
        : await tx.supplierProduct.create({
            data: {
              tenantId: scopedTenantId,
              supplierId: data.supplierId,
              productId: data.productId,
              supplierSku: data.supplierSku,
              packSize: data.packSize,
              unitCostMinor: data.unitCostMinor,
              currencyCode: data.currencyCode,
              leadTimeDays: data.leadTimeDays ?? null,
              isPreferred: data.isPreferred ?? false,
              createdById: data.createdById,
            },
          });
      const costChanged =
        !before ||
        before.unitCostMinor !== data.unitCostMinor ||
        before.packSize !== data.packSize ||
        before.currencyCode !== data.currencyCode;
      if (costChanged) {
        await tx.supplierProductCost.create({
          data: {
            tenantId: scopedTenantId,
            supplierProductId: link.id,
            unitCostMinor: data.unitCostMinor,
            currencyCode: data.currencyCode,
            packSize: data.packSize,
            reason: data.reason ?? null,
            recordedById: data.createdById,
          },
        });
      }
      await this.auditLog.record(buildAuditEntry(link, before), tx);
      return link;
    });
  }

  async findSupplierProducts(
    tenantId: string,
    query: {
      supplierId?: string;
      productId?: string;
      skip?: number;
      take?: number;
    },
  ): Promise<{ items: SupplierProductWithRefs[]; total: number }> {
    const where = this.scope(tenantId, {
      ...(query.supplierId ? { supplierId: query.supplierId } : {}),
      ...(query.productId ? { productId: query.productId } : {}),
    });
    const [items, total] = await this.prisma.$transaction([
      this.prisma.supplierProduct.findMany({
        where,
        include: SUPPLIER_PRODUCT_INCLUDE,
        orderBy: [{ supplierId: 'asc' }, { supplierSku: 'asc' }],
        skip: query.skip ?? 0,
        take: query.take ?? 50,
      }),
      this.prisma.supplierProduct.count({ where }),
    ]);
    return { items, total };
  }

  // ------------------------------------------------------ purchase orders

  createPurchaseOrder(
    tenantId: string,
    data: {
      supplierId: string;
      locationId: string;
      currencyCode: string;
      expectedAt?: Date | null;
      notes?: string | null;
      createdById?: string;
      lines: readonly {
        productId: string;
        quantityOrdered: number;
        packSize?: number;
        unitCostMinor?: number;
      }[];
    },
    buildAuditEntry: (order: PurchaseOrder) => AuditEntry,
  ): Promise<PurchaseOrderDetail | CreateOrderRejection> {
    const scopedTenantId = this.requireTenantId(tenantId);
    if (data.lines.length === 0) {
      return Promise.resolve('no-lines' as const);
    }
    const productIds = data.lines.map((line) => line.productId);
    if (new Set(productIds).size !== productIds.length) {
      return Promise.resolve('duplicate-product' as const);
    }
    return this.withReferenceRetry(() =>
      this.prisma.$transaction(async (tx) => {
        const supplier = await tx.supplier.findFirst({
          where: { id: data.supplierId, tenantId: scopedTenantId },
          select: { id: true, status: true },
        });
        if (!supplier) {
          return 'supplier-not-found' as const;
        }
        if (supplier.status === SupplierStatus.ARCHIVED) {
          return 'supplier-archived' as const;
        }
        const location = await tx.location.findFirst({
          where: { id: data.locationId, tenantId: scopedTenantId },
          select: { id: true },
        });
        if (!location) {
          return 'location-not-found' as const;
        }
        const products = await tx.product.findMany({
          where: { tenantId: scopedTenantId, id: { in: productIds } },
          select: { id: true, sku: true, name: true },
        });
        if (products.length !== productIds.length) {
          return 'product-not-found' as const;
        }
        const productById = new Map(products.map((p) => [p.id, p]));
        const supplierLinks = await tx.supplierProduct.findMany({
          where: {
            tenantId: scopedTenantId,
            supplierId: data.supplierId,
            productId: { in: productIds },
          },
        });
        const linkByProduct = new Map(
          supplierLinks.map((link) => [link.productId, link]),
        );

        const resolvedLines = data.lines.map((line) => {
          const link = linkByProduct.get(line.productId);
          const product = productById.get(line.productId)!;
          return {
            productId: line.productId,
            supplierProductId: link?.id ?? null,
            sku: product.sku,
            productName: product.name,
            quantityOrdered: line.quantityOrdered,
            // Fall back to the supplier catalog when the caller does not
            // override, and to a single-unit pack at zero cost when the product
            // is not in that catalog at all — an order for an unlisted product
            // is legal, it just carries no cost until someone states one.
            packSize: line.packSize ?? link?.packSize ?? 1,
            unitCostMinor: line.unitCostMinor ?? link?.unitCostMinor ?? 0,
            currencyCode: data.currencyCode,
          };
        });

        const allocated = await this.allocateReference(
          tx,
          scopedTenantId,
          'purchaseOrder',
          PURCHASE_ORDER_REFERENCE_PREFIX,
        );
        const order = await tx.purchaseOrder.create({
          data: {
            tenantId: scopedTenantId,
            reference: allocated.reference,
            referenceYear: allocated.year,
            referenceSequence: allocated.sequence,
            supplierId: data.supplierId,
            locationId: data.locationId,
            currencyCode: data.currencyCode,
            expectedAt: data.expectedAt ?? null,
            notes: data.notes ?? null,
            createdById: data.createdById,
            lines: {
              create: resolvedLines.map((line) => ({
                tenantId: scopedTenantId,
                productId: line.productId,
                supplierProductId: line.supplierProductId,
                sku: line.sku,
                productName: line.productName,
                quantityOrdered: line.quantityOrdered,
                packSize: line.packSize,
                unitCostMinor: line.unitCostMinor,
                currencyCode: line.currencyCode,
              })),
            },
          },
          include: ORDER_DETAIL_INCLUDE,
        });
        await this.auditLog.record(buildAuditEntry(order), tx);
        return order;
      }),
    );
  }

  async findPurchaseOrders(
    tenantId: string,
    query: {
      supplierId?: string;
      locationId?: string;
      status?: PurchaseOrderStatus;
      skip?: number;
      take?: number;
    },
  ): Promise<{ items: PurchaseOrderDetail[]; total: number }> {
    const where = this.scope(tenantId, {
      ...(query.supplierId ? { supplierId: query.supplierId } : {}),
      ...(query.locationId ? { locationId: query.locationId } : {}),
      ...(query.status ? { status: query.status } : {}),
    });
    const [items, total] = await this.prisma.$transaction([
      this.prisma.purchaseOrder.findMany({
        where,
        include: ORDER_DETAIL_INCLUDE,
        orderBy: [{ createdAt: 'desc' }],
        skip: query.skip ?? 0,
        take: query.take ?? 50,
      }),
      this.prisma.purchaseOrder.count({ where }),
    ]);
    return { items, total };
  }

  findPurchaseOrderById(
    tenantId: string,
    id: string,
  ): Promise<PurchaseOrderDetail | null> {
    return this.prisma.purchaseOrder.findFirst({
      where: this.scope(tenantId, { id }),
      include: ORDER_DETAIL_INCLUDE,
    });
  }

  /**
   * Moves a DRAFT order to SUBMITTED and stamps the total. The supplier
   * adapter has already run in the service, so its acknowledgement reference
   * arrives here as plain data — the repository never talks to a vendor.
   */
  submitPurchaseOrder(
    tenantId: string,
    id: string,
    data: { externalReference?: string | null; submittedById?: string },
    buildAuditEntry: (
      before: PurchaseOrder,
      after: PurchaseOrder,
    ) => AuditEntry,
  ): Promise<PurchaseOrderDetail | OrderTransitionRejection> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.purchaseOrder.findFirst({
        where: { id, tenantId: scopedTenantId },
        include: { lines: true },
      });
      if (!before) {
        return 'not-found' as const;
      }
      if (before.status !== PurchaseOrderStatus.DRAFT) {
        return 'illegal-transition' as const;
      }
      if (before.lines.length === 0) {
        return 'no-lines' as const;
      }
      const after = await tx.purchaseOrder.update({
        where: { id_tenantId: { id: before.id, tenantId: scopedTenantId } },
        data: {
          status: PurchaseOrderStatus.SUBMITTED,
          submittedAt: new Date(),
          submittedById: data.submittedById,
          externalReference: data.externalReference ?? null,
          totalCostMinor: orderTotalMinor(before.lines),
        },
        include: ORDER_DETAIL_INCLUDE,
      });
      await this.auditLog.record(buildAuditEntry(before, after), tx);
      return after;
    });
  }

  cancelPurchaseOrder(
    tenantId: string,
    id: string,
    data: { reason: string },
    buildAuditEntry: (
      before: PurchaseOrder,
      after: PurchaseOrder,
    ) => AuditEntry,
  ): Promise<PurchaseOrderDetail | OrderTransitionRejection> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.purchaseOrder.findFirst({
        where: { id, tenantId: scopedTenantId },
      });
      if (!before) {
        return 'not-found' as const;
      }
      if (
        before.status === PurchaseOrderStatus.RECEIVED ||
        before.status === PurchaseOrderStatus.CANCELLED
      ) {
        return 'illegal-transition' as const;
      }
      const after = await tx.purchaseOrder.update({
        where: { id_tenantId: { id: before.id, tenantId: scopedTenantId } },
        data: {
          status: PurchaseOrderStatus.CANCELLED,
          cancelledReason: data.reason,
          closedAt: new Date(),
        },
        include: ORDER_DETAIL_INCLUDE,
      });
      await this.auditLog.record(buildAuditEntry(before, after), tx);
      return after;
    });
  }

  // ------------------------------------------------------- goods receipts

  /**
   * Posts a goods receipt: ONE transaction that appends the receipt, writes a
   * RECEIPT ledger movement for every line that actually received something,
   * and recomputes the order's status from the receipts that now exist.
   *
   * Idempotent by `idempotencyKey`. A replay under an advisory lock on the
   * (tenant, key) pair returns the receipt the first call created instead of
   * stocking the same delivery twice — the same guarantee, and the same
   * mechanism, as `InventoryRepository.recordExternalMovement`. A key reused
   * with a DIFFERENT payload is a conflict the caller must see, not a silent
   * success.
   */
  postGoodsReceipt(
    tenantId: string,
    orderId: string,
    input: PostReceiptInput,
    builders: ReceiptAuditBuilders,
  ): Promise<GoodsReceiptDetail | ReceiptRejection> {
    const scopedTenantId = this.requireTenantId(tenantId);
    if (input.lines.length === 0) {
      return Promise.resolve('no-lines' as const);
    }
    const lineIds = input.lines.map((line) => line.purchaseOrderLineId);
    if (new Set(lineIds).size !== lineIds.length) {
      return Promise.resolve('duplicate-line' as const);
    }
    return this.withReferenceRetry(() =>
      this.prisma
        .$transaction(async (tx) => {
          if (input.idempotencyKey) {
            await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`goods-receipt:${scopedTenantId}:${input.idempotencyKey}`}))::text`;
            const existing = await tx.goodsReceipt.findFirst({
              where: {
                tenantId: scopedTenantId,
                idempotencyKey: input.idempotencyKey,
              },
              include: RECEIPT_DETAIL_INCLUDE,
            });
            if (existing) {
              // A replay is only a replay when it asks for the SAME receipt
              // against the same order. Anything else is a reused key.
              if (existing.purchaseOrderId !== orderId) {
                throw new ReceiptRejectedError('reference-mismatch');
              }
              return existing;
            }
          }

          const order = await tx.purchaseOrder.findFirst({
            where: { id: orderId, tenantId: scopedTenantId },
            include: { lines: true },
          });
          if (!order) {
            throw new ReceiptRejectedError('order-not-found');
          }
          if (
            order.status !== PurchaseOrderStatus.SUBMITTED &&
            order.status !== PurchaseOrderStatus.PARTIALLY_RECEIVED
          ) {
            throw new ReceiptRejectedError('order-not-receivable');
          }
          const orderLineById = new Map(
            order.lines.map((line) => [line.id, line]),
          );
          for (const line of input.lines) {
            if (!orderLineById.has(line.purchaseOrderLineId)) {
              throw new ReceiptRejectedError('line-not-on-order');
            }
          }

          // What had already arrived BEFORE this receipt — needed so a
          // discrepancy suggestion looks at the running total, not one delivery
          // in isolation.
          const priorReceiptLines = await tx.goodsReceiptLine.findMany({
            where: {
              tenantId: scopedTenantId,
              purchaseOrderLineId: { in: order.lines.map((l) => l.id) },
            },
            select: { purchaseOrderLineId: true, quantityReceived: true },
          });
          const priorPacks = receivedPacksByLine(
            order.lines as OrderLineQuantities[],
            priorReceiptLines,
          );

          const allocated = await this.allocateReference(
            tx,
            scopedTenantId,
            'goodsReceipt',
            GOODS_RECEIPT_REFERENCE_PREFIX,
          );
          const receipt = await tx.goodsReceipt.create({
            data: {
              tenantId: scopedTenantId,
              purchaseOrderId: order.id,
              reference: allocated.reference,
              referenceYear: allocated.year,
              referenceSequence: allocated.sequence,
              deliveryNote: input.deliveryNote ?? null,
              notes: input.notes ?? null,
              receivedAt: input.receivedAt ?? new Date(),
              idempotencyKey: input.idempotencyKey ?? null,
              receivedById: input.receivedById,
            },
          });

          // Sort by product id so two concurrent receipts touching the same
          // products acquire the per-product advisory locks in the same order
          // and cannot deadlock — the rule checkout completion follows.
          const sorted = [...input.lines].sort((a, b) => {
            const pa = orderLineById.get(a.purchaseOrderLineId)!.productId;
            const pb = orderLineById.get(b.purchaseOrderLineId)!.productId;
            return pa < pb ? -1 : pa > pb ? 1 : 0;
          });

          for (const line of sorted) {
            const orderLine = orderLineById.get(line.purchaseOrderLineId)!;
            const units = unitsForPacks(
              line.quantityReceived,
              orderLine.packSize,
            );
            let movementId: string | null = null;
            if (units > 0) {
              try {
                const { movement } =
                  await this.inventoryRepository.applyMovement(tx, {
                    tenantId: scopedTenantId,
                    locationId: order.locationId,
                    productId: orderLine.productId,
                    quantityDelta: units,
                    movementType: InventoryMovementType.RECEIPT,
                    reason: `Goods receipt ${receipt.reference} against ${order.reference}`,
                    referenceType: RECEIPT_MOVEMENT_REFERENCE_TYPE,
                    referenceId: receipt.id,
                    createdById: input.receivedById,
                  });
                movementId = movement.id;
              } catch (error) {
                if (error instanceof AdjustmentRejected) {
                  throw new ReceiptRejectedError(
                    'stock-rejected',
                    error.reason,
                  );
                }
                throw error;
              }
            }
            const discrepancy =
              line.discrepancy &&
              line.discrepancy !== GoodsReceiptDiscrepancy.NONE
                ? line.discrepancy
                : suggestDiscrepancy(
                    orderLine.quantityOrdered,
                    priorPacks.get(orderLine.id) ?? 0,
                    line.quantityReceived,
                  );
            await tx.goodsReceiptLine.create({
              data: {
                tenantId: scopedTenantId,
                goodsReceiptId: receipt.id,
                purchaseOrderLineId: orderLine.id,
                productId: orderLine.productId,
                quantityReceived: line.quantityReceived,
                packSize: orderLine.packSize,
                unitsReceived: units,
                discrepancy,
                discrepancyNote: line.discrepancyNote ?? null,
                inventoryMovementId: movementId,
              },
            });
          }

          // Recompute the order's status from ALL receipt lines that now exist,
          // rather than nudging it forward. Received quantity stays a
          // projection; only the lifecycle status is stored.
          const allReceiptLines = await tx.goodsReceiptLine.findMany({
            where: {
              tenantId: scopedTenantId,
              purchaseOrderLineId: { in: order.lines.map((l) => l.id) },
            },
            select: { purchaseOrderLineId: true, quantityReceived: true },
          });
          const nextStatus = derivePurchaseOrderStatus(
            order.status,
            order.lines as OrderLineQuantities[],
            receivedPacksByLine(
              order.lines as OrderLineQuantities[],
              allReceiptLines,
            ),
          );
          if (nextStatus !== order.status) {
            const updated = await tx.purchaseOrder.update({
              where: {
                id_tenantId: { id: order.id, tenantId: scopedTenantId },
              },
              data: {
                status: nextStatus,
                ...(nextStatus === PurchaseOrderStatus.RECEIVED
                  ? { closedAt: new Date() }
                  : {}),
              },
            });
            await this.auditLog.record(
              builders.orderStatusChanged(updated, order.status, nextStatus),
              tx,
            );
          }

          await this.auditLog.record(builders.receiptPosted(receipt), tx);
          return tx.goodsReceipt.findFirstOrThrow({
            where: { id: receipt.id, tenantId: scopedTenantId },
            include: RECEIPT_DETAIL_INCLUDE,
          });
        })
        .catch((error: unknown) => {
          if (error instanceof ReceiptRejectedError) {
            return error.rejection;
          }
          throw error;
        }),
    );
  }

  async findGoodsReceipts(
    tenantId: string,
    query: { purchaseOrderId?: string; skip?: number; take?: number },
  ): Promise<{ items: GoodsReceiptDetail[]; total: number }> {
    const where = this.scope(tenantId, {
      ...(query.purchaseOrderId
        ? { purchaseOrderId: query.purchaseOrderId }
        : {}),
    });
    const [items, total] = await this.prisma.$transaction([
      this.prisma.goodsReceipt.findMany({
        where,
        include: RECEIPT_DETAIL_INCLUDE,
        orderBy: [{ receivedAt: 'desc' }],
        skip: query.skip ?? 0,
        take: query.take ?? 50,
      }),
      this.prisma.goodsReceipt.count({ where }),
    ]);
    return { items, total };
  }

  /**
   * Ledger movements a receipt produced, so the admin UI can show exactly what
   * a delivery did to stock without trusting any number stored on the receipt.
   */
  findReceiptMovements(
    tenantId: string,
    receiptId: string,
  ): Promise<
    {
      id: string;
      productId: string;
      quantityDelta: number;
      quantityAfter: number;
      createdAt: Date;
    }[]
  > {
    return this.prisma.inventoryMovement.findMany({
      where: this.scope(tenantId, {
        referenceType: RECEIPT_MOVEMENT_REFERENCE_TYPE,
        referenceId: receiptId,
      }),
      select: {
        id: true,
        productId: true,
        quantityDelta: true,
        quantityAfter: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Next reference in the tenant's yearly sequence, read inside the caller's
   * transaction.
   *
   * Ordering is on the INTEGER `referenceSequence`, never on the reference
   * string. A string sort agrees with numeric order only while every sequence
   * is the same width: the moment `PO-2026-10000` exists,
   * `'PO-2026-9999' > 'PO-2026-10000'`, so a string-ordered lookup keeps
   * returning 9999, keeps computing 10000, and keeps being rejected by the
   * (tenantId, reference) unique — every subsequent order for the tenant-year
   * a permanent failure. The integer column has a total order at every width.
   *
   * The advisory lock serializes allocation for this (tenant, prefix, year) so
   * two simultaneous creations do not read the same maximum. The unique index
   * remains the real guarantee behind it, and `withReferenceRetry` turns the
   * rare loser — a row inserted out of band, say — into a second attempt that
   * reads a strictly larger maximum.
   */
  private async allocateReference(
    tx: Prisma.TransactionClient,
    tenantId: string,
    model: 'purchaseOrder' | 'goodsReceipt',
    prefix: string,
  ): Promise<AllocatedReference> {
    const year = new Date().getUTCFullYear();
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${procurementReferenceAdvisoryLockKey(
      tenantId,
      prefix,
      year,
    )}))::text`;
    const where = { tenantId, referenceYear: year };
    const orderBy = { referenceSequence: 'desc' } as const;
    const select = { referenceSequence: true } as const;
    const latest =
      model === 'purchaseOrder'
        ? await tx.purchaseOrder.findFirst({ where, orderBy, select })
        : await tx.goodsReceipt.findFirst({ where, orderBy, select });
    return nextReference(prefix, year, latest?.referenceSequence ?? null);
  }

  /**
   * Runs a reference-allocating transaction, retrying a bounded number of
   * times when the (tenantId, reference) unique rejects the insert.
   *
   * This loop TERMINATES because each attempt re-reads the year's maximum
   * sequence and adds one. The loser of a race re-reads a maximum that now
   * includes the winner's committed row, so the number it computes is strictly
   * larger than the one that was rejected. That was precisely what the
   * string-ordered lookup could not promise: it recomputed the same rejected
   * value forever, which is what made the 10,000th document of a year a
   * permanent 500 rather than a momentary conflict.
   *
   * Only a reference conflict is retried. A reused idempotency key, a domain
   * rejection, or any other error is the caller's answer and is rethrown
   * unchanged.
   */
  private async withReferenceRetry<T>(run: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await run();
      } catch (error) {
        if (
          attempt >= REFERENCE_ALLOCATION_ATTEMPTS ||
          !isReferenceConflict(error)
        ) {
          throw error;
        }
      }
    }
  }
}

/**
 * How many times a reference-allocating transaction may be replayed before the
 * conflict is reported. Each attempt allocates a strictly larger sequence, so
 * more than a couple means something other than a race — an out-of-band writer
 * inserting references faster than we can step over them — and failing loudly
 * beats spinning.
 */
const REFERENCE_ALLOCATION_ATTEMPTS = 5;

/**
 * Was this the (tenantId, reference) unique rejecting a collision?
 *
 * Deliberately narrow: GoodsReceipt also carries a (tenantId, idempotencyKey)
 * unique, and a reused key must reach the caller as a conflict rather than
 * being retried into a second receipt.
 */
function isReferenceConflict(error: unknown): boolean {
  if ((error as { code?: unknown } | null)?.code !== 'P2002') {
    return false;
  }
  const target = (error as { meta?: { target?: unknown } }).meta?.target;
  if (Array.isArray(target)) {
    return target.includes('reference');
  }
  return typeof target === 'string' && target.includes('reference');
}

/**
 * Thrown INSIDE the receipt transaction to abort it, mirroring
 * `AdjustmentRejected`: rejecting by throwing guarantees the receipt row, its
 * lines, and every ledger movement roll back together, so a partially posted
 * delivery can never survive.
 */
class ReceiptRejectedError extends Error {
  constructor(
    readonly rejection: ReceiptRejection,
    readonly detail?: string,
  ) {
    super(rejection);
    this.name = 'ReceiptRejectedError';
  }
}
