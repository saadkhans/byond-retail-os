import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  GoodsReceipt,
  PurchaseOrder,
  PurchaseOrderStatus,
  Supplier,
  SupplierProduct,
  SupplierStatus,
} from '@prisma/client';
import {
  AuditActor,
  AuditEntry,
} from '../common/audit/audit-log.service';
import { containsSensitiveFreeText } from '../video-ingest/media-safety';
import { CreatePurchaseOrderDto } from './dto/create-purchase-order.dto';
import { CreateSupplierDto } from './dto/create-supplier.dto';
import { PostGoodsReceiptDto } from './dto/post-goods-receipt.dto';
import {
  QueryGoodsReceiptsDto,
  QueryPurchaseOrdersDto,
  QuerySupplierProductsDto,
  QuerySuppliersDto,
} from './dto/query-procurement.dto';
import { CancelPurchaseOrderDto } from './dto/cancel-purchase-order.dto';
import { SubmitPurchaseOrderDto } from './dto/submit-purchase-order.dto';
import { UpdateSupplierDto } from './dto/update-supplier.dto';
import { UpsertSupplierProductDto } from './dto/upsert-supplier-product.dto';
import {
  GoodsReceiptDetail,
  ProcurementRepository,
  PurchaseOrderDetail,
  SupplierProductWithRefs,
} from './procurement.repository';
import {
  normalizeCurrencyCode,
  normalizeSupplierCode,
  normalizeSupplierSku,
  OrderLineQuantities,
  orderTotalMinor,
  receivedPacksByLine,
} from './procurement.logic';
import {
  SUPPLIER_INTEGRATION_PORT,
  SupplierIntegrationPort,
} from './supplier-integration.port';

/**
 * Free text on a supplier, an order or a delivery note is copied into
 * AuditLog.reason, which audit redaction does not cover. Screen it with the
 * strict predicate for the same reason pricing and the inventory ledger do: a
 * pasted card number or credential in a "notes" field would be retained
 * forever (AGENTS.md payments invariant).
 */
function assertSafeText(value: string | null | undefined, field: string): void {
  if (value != null && containsSensitiveFreeText(value)) {
    throw new BadRequestException(
      `${field} must not contain credential- or payment-bearing values`,
    );
  }
}

/** Caller-supplied ids echoed into errors land in logs — redact unsafe ones. */
function safeErrorEntityId(id: string): string {
  return containsSensitiveFreeText(id) ? '[REDACTED]' : id;
}

/**
 * An order line with what has actually arrived against it. Received quantity
 * is computed here from receipt rows on every read — there is no stored
 * counter to drift.
 */
export interface PurchaseOrderLineView {
  id: string;
  productId: string;
  sku: string;
  productName: string;
  quantityOrdered: number;
  packSize: number;
  unitCostMinor: number;
  currencyCode: string;
  quantityReceived: number;
  quantityOutstanding: number;
  unitsReceived: number;
}

export interface PurchaseOrderView
  extends Omit<PurchaseOrderDetail, 'lines'> {
  lines: PurchaseOrderLineView[];
  /** Recomputed from the lines, so a DRAFT order shows a running total. */
  computedTotalMinor: number;
}

@Injectable()
export class ProcurementService {
  constructor(
    private readonly repository: ProcurementRepository,
    @Inject(SUPPLIER_INTEGRATION_PORT)
    private readonly supplierIntegration: SupplierIntegrationPort,
  ) {}

  // ------------------------------------------------------------ suppliers

  async createSupplier(
    tenantId: string,
    dto: CreateSupplierDto,
    actor: AuditActor,
  ): Promise<Supplier> {
    assertSafeText(dto.notes, 'notes');
    assertSafeText(dto.contactName, 'contactName');
    const code = normalizeSupplierCode(dto.code);
    const result = await this.repository.createSupplier(
      tenantId,
      {
        code,
        name: dto.name.trim(),
        contactName: dto.contactName ?? null,
        contactEmail: dto.contactEmail ?? null,
        contactPhone: dto.contactPhone ?? null,
        leadTimeDays: dto.leadTimeDays ?? null,
        notes: dto.notes ?? null,
        createdById: actor.id,
      },
      (supplier) =>
        this.audit(tenantId, actor, {
          action: AuditAction.CREATE,
          entityType: 'Supplier',
          entityId: supplier.id,
          after: supplier,
          reason: `Supplier ${supplier.code} created`,
        }),
    );
    if (result === 'code-taken') {
      throw new ConflictException(
        `A supplier with code "${code}" already exists in this tenant`,
      );
    }
    return result;
  }

  findSuppliers(
    tenantId: string,
    query: QuerySuppliersDto,
  ): Promise<{ items: Supplier[]; total: number }> {
    return this.repository.findSuppliers(tenantId, {
      status: query.status as SupplierStatus | undefined,
      skip: query.skip,
      take: query.take,
    });
  }

  async findSupplierById(tenantId: string, id: string): Promise<Supplier> {
    const supplier = await this.repository.findSupplierById(tenantId, id);
    if (!supplier) {
      throw new NotFoundException(
        `Supplier "${safeErrorEntityId(id)}" not found`,
      );
    }
    return supplier;
  }

  async updateSupplier(
    tenantId: string,
    id: string,
    dto: UpdateSupplierDto,
    actor: AuditActor,
  ): Promise<Supplier> {
    assertSafeText(dto.notes, 'notes');
    assertSafeText(dto.contactName, 'contactName');
    const code = dto.code ? normalizeSupplierCode(dto.code) : undefined;
    const result = await this.repository.updateSupplier(
      tenantId,
      id,
      {
        ...(code !== undefined ? { code } : {}),
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.status !== undefined
          ? { status: dto.status as SupplierStatus }
          : {}),
        ...(dto.contactName !== undefined
          ? { contactName: dto.contactName }
          : {}),
        ...(dto.contactEmail !== undefined
          ? { contactEmail: dto.contactEmail }
          : {}),
        ...(dto.contactPhone !== undefined
          ? { contactPhone: dto.contactPhone }
          : {}),
        ...(dto.leadTimeDays !== undefined
          ? { leadTimeDays: dto.leadTimeDays }
          : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
      },
      (before, after) =>
        this.audit(tenantId, actor, {
          action: AuditAction.UPDATE,
          entityType: 'Supplier',
          entityId: after.id,
          before,
          after,
          reason: `Supplier ${after.code} updated`,
        }),
    );
    if (result === 'not-found') {
      throw new NotFoundException(
        `Supplier "${safeErrorEntityId(id)}" not found`,
      );
    }
    if (result === 'code-taken') {
      throw new ConflictException(
        `A supplier with code "${code ?? ''}" already exists in this tenant`,
      );
    }
    return result;
  }

  // ---------------------------------------------------- supplier products

  async upsertSupplierProduct(
    tenantId: string,
    supplierId: string,
    dto: UpsertSupplierProductDto,
    actor: AuditActor,
  ): Promise<SupplierProduct> {
    assertSafeText(dto.reason, 'reason');
    const currencyCode = normalizeCurrencyCode(dto.currencyCode);
    const result = await this.repository.upsertSupplierProduct(
      tenantId,
      {
        supplierId,
        productId: dto.productId,
        supplierSku: normalizeSupplierSku(dto.supplierSku),
        packSize: dto.packSize ?? 1,
        unitCostMinor: dto.unitCostMinor,
        currencyCode,
        leadTimeDays: dto.leadTimeDays ?? null,
        isPreferred: dto.isPreferred,
        reason: dto.reason ?? null,
        createdById: actor.id,
      },
      (link, before) =>
        this.audit(tenantId, actor, {
          action: before ? AuditAction.UPDATE : AuditAction.CREATE,
          entityType: 'SupplierProduct',
          entityId: link.id,
          before,
          after: link,
          reason: before
            ? `Supplier cost updated for ${link.supplierSku}`
            : `Supplier product ${link.supplierSku} linked`,
        }),
    );
    if (result === 'supplier-not-found') {
      throw new NotFoundException(
        `Supplier "${safeErrorEntityId(supplierId)}" not found`,
      );
    }
    if (result === 'product-not-found') {
      throw new NotFoundException(
        `Product "${safeErrorEntityId(dto.productId)}" not found`,
      );
    }
    if (result === 'supplier-sku-taken') {
      throw new ConflictException(
        'That supplier SKU is already mapped to a different product',
      );
    }
    return result;
  }

  findSupplierProducts(
    tenantId: string,
    query: QuerySupplierProductsDto,
  ): Promise<{ items: SupplierProductWithRefs[]; total: number }> {
    return this.repository.findSupplierProducts(tenantId, {
      supplierId: query.supplierId,
      productId: query.productId,
      skip: query.skip,
      take: query.take,
    });
  }

  // ------------------------------------------------------ purchase orders

  async createPurchaseOrder(
    tenantId: string,
    dto: CreatePurchaseOrderDto,
    actor: AuditActor,
  ): Promise<PurchaseOrderView> {
    assertSafeText(dto.notes, 'notes');
    const currencyCode = normalizeCurrencyCode(dto.currencyCode);
    const result = await this.repository.createPurchaseOrder(
      tenantId,
      {
        supplierId: dto.supplierId,
        locationId: dto.locationId,
        currencyCode,
        expectedAt: dto.expectedAt ? new Date(dto.expectedAt) : null,
        notes: dto.notes ?? null,
        createdById: actor.id,
        lines: dto.lines,
      },
      (order) =>
        this.audit(tenantId, actor, {
          action: AuditAction.CREATE,
          entityType: 'PurchaseOrder',
          entityId: order.id,
          after: order,
          reason: `Purchase order ${order.reference} created`,
        }),
    );
    if (typeof result === 'string') {
      throw this.orderCreationError(result, dto);
    }
    return toOrderView(result);
  }

  async findPurchaseOrders(
    tenantId: string,
    query: QueryPurchaseOrdersDto,
  ): Promise<{ items: PurchaseOrderView[]; total: number }> {
    const page = await this.repository.findPurchaseOrders(tenantId, {
      supplierId: query.supplierId,
      locationId: query.locationId,
      status: query.status as PurchaseOrderStatus | undefined,
      skip: query.skip,
      take: query.take,
    });
    return { items: page.items.map(toOrderView), total: page.total };
  }

  async findPurchaseOrderById(
    tenantId: string,
    id: string,
  ): Promise<PurchaseOrderView> {
    const order = await this.repository.findPurchaseOrderById(tenantId, id);
    if (!order) {
      throw new NotFoundException(
        `Purchase order "${safeErrorEntityId(id)}" not found`,
      );
    }
    return toOrderView(order);
  }

  /**
   * Submits an order to its supplier through the adapter, then records the
   * transition.
   *
   * The adapter runs BEFORE the transaction on purpose: an outbound call must
   * never hold a database transaction open, and a supplier that rejects the
   * order leaves it in DRAFT where an operator can fix and resend it.
   */
  async submitPurchaseOrder(
    tenantId: string,
    id: string,
    dto: SubmitPurchaseOrderDto,
    actor: AuditActor,
  ): Promise<PurchaseOrderView> {
    const order = await this.repository.findPurchaseOrderById(tenantId, id);
    if (!order) {
      throw new NotFoundException(
        `Purchase order "${safeErrorEntityId(id)}" not found`,
      );
    }
    if (order.status !== PurchaseOrderStatus.DRAFT) {
      throw new ConflictException(
        `Only a DRAFT order can be submitted; this one is ${order.status}`,
      );
    }
    if (order.lines.length === 0) {
      throw new BadRequestException('A purchase order needs at least one line');
    }

    let externalReference: string | null = null;
    if (dto.sendToSupplier !== false) {
      const submission = await this.supplierIntegration.submitOrder({
        reference: order.reference,
        supplierCode: order.supplier.code,
        supplierName: order.supplier.name,
        destinationCode: order.location.code,
        destinationName: order.location.name,
        expectedAt: order.expectedAt,
        currencyCode: order.currencyCode,
        totalCostMinor: orderTotalMinor(order.lines),
        lines: order.lines.map((line) => ({
          // What the SUPPLIER calls it, falling back to our SKU when the
          // product is not in their catalog — an order for an unlisted
          // product is legal, it just quotes our own identifier.
          supplierSku: line.supplierProduct?.supplierSku ?? line.sku,
          sku: line.sku,
          productName: line.productName,
          quantity: line.quantityOrdered,
          packSize: line.packSize,
          unitCostMinor: line.unitCostMinor,
          currencyCode: line.currencyCode,
        })),
      });
      if (submission.status === 'REJECTED') {
        throw new ConflictException(
          `The supplier integration rejected this order (${submission.failure}); it stays in DRAFT`,
        );
      }
      externalReference = submission.externalReference;
    }

    const result = await this.repository.submitPurchaseOrder(
      tenantId,
      id,
      { externalReference, submittedById: actor.id },
      (before, after) =>
        this.audit(tenantId, actor, {
          action: AuditAction.UPDATE,
          entityType: 'PurchaseOrder',
          entityId: after.id,
          before,
          after,
          reason: `Purchase order ${after.reference} submitted to supplier`,
        }),
    );
    if (typeof result === 'string') {
      throw this.orderTransitionError(result, id);
    }
    return toOrderView(result);
  }

  async cancelPurchaseOrder(
    tenantId: string,
    id: string,
    dto: CancelPurchaseOrderDto,
    actor: AuditActor,
  ): Promise<PurchaseOrderView> {
    assertSafeText(dto.reason, 'reason');
    const result = await this.repository.cancelPurchaseOrder(
      tenantId,
      id,
      { reason: dto.reason.trim() },
      (before, after) =>
        this.audit(tenantId, actor, {
          action: AuditAction.CANCEL,
          entityType: 'PurchaseOrder',
          entityId: after.id,
          before,
          after,
          reason: `Purchase order ${after.reference} cancelled: ${dto.reason.trim()}`,
        }),
    );
    if (typeof result === 'string') {
      throw this.orderTransitionError(result, id);
    }
    return toOrderView(result);
  }

  // ------------------------------------------------------- goods receipts

  /**
   * Records what arrived. Every accepted unit becomes a RECEIPT movement on
   * the append-only ledger inside the same transaction — this method writes no
   * stock quantity of its own.
   */
  async postGoodsReceipt(
    tenantId: string,
    orderId: string,
    dto: PostGoodsReceiptDto,
    actor: AuditActor,
  ): Promise<GoodsReceiptDetail> {
    assertSafeText(dto.notes, 'notes');
    assertSafeText(dto.deliveryNote, 'deliveryNote');
    for (const line of dto.lines) {
      assertSafeText(line.discrepancyNote, 'discrepancyNote');
    }
    const result = await this.repository.postGoodsReceipt(
      tenantId,
      orderId,
      {
        deliveryNote: dto.deliveryNote ?? null,
        notes: dto.notes ?? null,
        receivedAt: dto.receivedAt ? new Date(dto.receivedAt) : undefined,
        idempotencyKey: dto.idempotencyKey ?? null,
        receivedById: actor.id,
        lines: dto.lines,
      },
      {
        receiptPosted: (receipt: GoodsReceipt) =>
          this.audit(tenantId, actor, {
            action: AuditAction.RECEIVE,
            entityType: 'GoodsReceipt',
            entityId: receipt.id,
            after: receipt,
            reason: `Goods receipt ${receipt.reference} posted`,
          }),
        orderStatusChanged: (
          order: PurchaseOrder,
          from: PurchaseOrderStatus,
          to: PurchaseOrderStatus,
        ) =>
          this.audit(tenantId, actor, {
            action: AuditAction.UPDATE,
            entityType: 'PurchaseOrder',
            entityId: order.id,
            before: { status: from },
            after: { status: to },
            reason: `Purchase order ${order.reference} moved from ${from} to ${to} by receiving`,
          }),
      },
    );
    if (typeof result === 'string') {
      throw this.receiptError(result, orderId);
    }
    return result;
  }

  findGoodsReceipts(
    tenantId: string,
    query: QueryGoodsReceiptsDto,
  ): Promise<{ items: GoodsReceiptDetail[]; total: number }> {
    return this.repository.findGoodsReceipts(tenantId, {
      purchaseOrderId: query.purchaseOrderId,
      skip: query.skip,
      take: query.take,
    });
  }

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
    return this.repository.findReceiptMovements(tenantId, receiptId);
  }

  // ------------------------------------------------------------- internals

  private orderCreationError(
    rejection: string,
    dto: CreatePurchaseOrderDto,
  ): Error {
    switch (rejection) {
      case 'supplier-not-found':
        return new NotFoundException(
          `Supplier "${safeErrorEntityId(dto.supplierId)}" not found`,
        );
      case 'supplier-archived':
        return new ConflictException(
          'That supplier is archived and cannot receive new orders',
        );
      case 'location-not-found':
        return new NotFoundException(
          `Location "${safeErrorEntityId(dto.locationId)}" not found`,
        );
      case 'product-not-found':
        return new NotFoundException(
          'One or more products on this order do not exist in this tenant',
        );
      case 'duplicate-product':
        return new BadRequestException(
          'A product may appear at most once on a purchase order',
        );
      default:
        return new BadRequestException(
          'A purchase order needs at least one line',
        );
    }
  }

  private orderTransitionError(rejection: string, id: string): Error {
    switch (rejection) {
      case 'not-found':
        return new NotFoundException(
          `Purchase order "${safeErrorEntityId(id)}" not found`,
        );
      case 'no-lines':
        return new BadRequestException(
          'A purchase order needs at least one line',
        );
      default:
        return new ConflictException(
          'That transition is not legal from the order’s current status',
        );
    }
  }

  private receiptError(rejection: string, orderId: string): Error {
    switch (rejection) {
      case 'order-not-found':
        return new NotFoundException(
          `Purchase order "${safeErrorEntityId(orderId)}" not found`,
        );
      case 'order-not-receivable':
        return new ConflictException(
          'Goods can only be received against a SUBMITTED or PARTIALLY_RECEIVED order',
        );
      case 'line-not-on-order':
        return new BadRequestException(
          'One or more receipt lines do not belong to this purchase order',
        );
      case 'duplicate-line':
        return new BadRequestException(
          'An order line may appear at most once on a receipt',
        );
      case 'reference-mismatch':
        return new ConflictException(
          'That idempotency key was already used for a different receipt',
        );
      case 'stock-rejected':
        return new ConflictException(
          'The inventory ledger rejected this delivery; nothing was received',
        );
      default:
        return new BadRequestException('A receipt needs at least one line');
    }
  }

  private audit(
    tenantId: string,
    actor: AuditActor,
    entry: Omit<AuditEntry, 'tenantId' | 'actorId' | 'actorEmail'>,
  ): AuditEntry {
    return {
      ...entry,
      tenantId,
      actorId: actor.id,
      actorEmail: actor.email,
    };
  }
}

/**
 * Projects an order row into the API shape, deriving received and outstanding
 * quantities from its receipts. Nothing here reads a stored counter, which is
 * why the numbers a client sees can never disagree with the ledger.
 */
export function toOrderView(order: PurchaseOrderDetail): PurchaseOrderView {
  const receiptLines = order.receipts.flatMap((receipt) =>
    receipt.lines.map((line) => ({
      purchaseOrderLineId: line.purchaseOrderLineId,
      quantityReceived: line.quantityReceived,
    })),
  );
  const received = receivedPacksByLine(
    order.lines as OrderLineQuantities[],
    receiptLines,
  );
  const lines: PurchaseOrderLineView[] = order.lines.map((line) => {
    const packs = received.get(line.id) ?? 0;
    return {
      id: line.id,
      productId: line.productId,
      sku: line.sku,
      productName: line.productName,
      quantityOrdered: line.quantityOrdered,
      packSize: line.packSize,
      unitCostMinor: line.unitCostMinor,
      currencyCode: line.currencyCode,
      quantityReceived: packs,
      quantityOutstanding: Math.max(0, line.quantityOrdered - packs),
      unitsReceived: packs * line.packSize,
    };
  });
  return {
    ...order,
    lines,
    computedTotalMinor: orderTotalMinor(order.lines as OrderLineQuantities[]),
  };
}
