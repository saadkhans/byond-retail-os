import { Injectable } from '@nestjs/common';
import {
  InventoryMovementType,
  OrderReturn,
  OrderReturnKind,
  OrderReturnStatus,
  OrderStatus,
  Prisma,
  RefundSkipReason,
} from '@prisma/client';
import {
  AuditEntry,
  AuditLogService,
} from '../common/audit/audit-log.service';
import {
  orderPaymentAdvisoryLockKey,
  orderReturnAdvisoryLockKey,
} from '../common/locks';
import {
  AdjustmentFailure,
  AdjustmentRejected,
  InventoryRepository,
} from '../inventory/inventory.repository';
import { PrismaService } from '../prisma/prisma.service';
import { TenantScopedRepository } from '../prisma/tenant-scoped.repository';
import { MOVEMENT_REFERENCE_TYPE } from './returns.constants';
import {
  planReturn,
  ReturnLineRequest,
  ReturnPlanRejection,
} from './returns.logic';

export const RETURN_DETAIL_INCLUDE = {
  lines: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
  order: {
    select: {
      id: true,
      orderNumber: true,
      status: true,
      paymentStatus: true,
      locationId: true,
    },
  },
  refund: true,
} satisfies Prisma.OrderReturnInclude;

export type OrderReturnDetail = Prisma.OrderReturnGetPayload<{
  include: typeof RETURN_DETAIL_INCLUDE;
}>;

export type ReturnRejection =
  | ReturnPlanRejection
  /** The order is cancelled, or not in a state that can give goods back. */
  | 'order-not-returnable'
  /** The reference was already used for a DIFFERENT return request. */
  | 'reference-mismatch'
  /** A concurrent cancellation won the order between check and write. */
  | 'order-cancel-conflict';

export interface ReturnResult {
  orderReturn: OrderReturnDetail;
  replayed: boolean;
}

/**
 * Thrown INSIDE the return transaction when the ledger refuses a RETURN_IN
 * movement (an archived product, a quantity that would overflow the projection
 * column). Throwing is what rolls the WHOLE return back: a rejected movement
 * must never leave a return record claiming goods came back that did not.
 */
export class ReturnStockRejected extends Error {
  constructor(
    readonly failure: AdjustmentFailure,
    readonly sku: string,
  ) {
    super(failure);
    this.name = 'ReturnStockRejected';
  }
}

export interface ReturnAuditBuilders {
  returnRecorded: (orderReturn: OrderReturn) => AuditEntry;
  stockReturned: (
    movement: { id: string; quantityDelta: number; productId: string },
    level: { quantity: number },
    line: { sku: string; quantity: number },
  ) => AuditEntry;
  orderCancelled?: (
    before: { id: string; status: OrderStatus },
    after: { id: string; status: OrderStatus },
  ) => AuditEntry;
}

@Injectable()
export class ReturnsRepository extends TenantScopedRepository {
  constructor(
    prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly inventoryRepository: InventoryRepository,
  ) {
    super(prisma);
  }

  /**
   * Records ONE return or cancellation and puts the goods back into stock —
   * atomically, ledger-first in spirit.
   *
   * The whole point of the method is the last clause of that sentence. Stock
   * comes back ONLY by appending RETURN_IN movements through
   * `InventoryRepository.applyMovement`, the same entry point checkout uses to
   * take stock away. Nothing here reads, computes or writes an
   * `InventoryLevel`: the projection moves because the ledger moved, and the
   * database CHECK on OrderReturnLine (`restocked` implies `movementId`) means
   * a restock without its ledger row cannot even be stored.
   *
   * Idempotent by `reference` ((tenantId, reference) is unique, checked under
   * the per-order advisory lock): a retried request returns the original
   * return instead of reversing stock a second time. A reference reused for a
   * DIFFERENT order is a conflict the caller has to see, never a silent
   * success.
   */
  recordReturn(
    tenantId: string,
    input: {
      orderId: string;
      kind: OrderReturnKind;
      reference: string;
      reason: string;
      lines: ReturnLineRequest[] | null;
      refundRequested: boolean;
      actorId?: string;
    },
    builders: ReturnAuditBuilders,
  ): Promise<ReturnResult | ReturnRejection | ReturnStockRejected | null> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma
      .$transaction(async (tx) => {
        // order-return -> order-payment -> product. See common/locks.ts: this
        // is the only lock order any reverse-flow path takes.
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${orderReturnAdvisoryLockKey(
          scopedTenantId,
          input.orderId,
        )}))::text`;

        const existing = await tx.orderReturn.findFirst({
          where: { tenantId: scopedTenantId, reference: input.reference },
          include: RETURN_DETAIL_INCLUDE,
        });
        if (existing) {
          if (existing.orderId !== input.orderId) {
            return 'reference-mismatch' as const;
          }
          return { orderReturn: existing, replayed: true };
        }

        const order = await tx.order.findFirst({
          where: { id: input.orderId, tenantId: scopedTenantId },
          include: {
            lines: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
          },
        });
        if (!order) {
          return null;
        }
        // A cancelled order has nothing left to give back: whatever reversal
        // it needed happened when it was cancelled.
        if (order.status !== OrderStatus.CONFIRMED) {
          return 'order-not-returnable' as const;
        }
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${orderPaymentAdvisoryLockKey(
          scopedTenantId,
          order.id,
        )}))::text`;

        // How much of each line has ALREADY come back, across every earlier
        // return on this order. Tenant-scoped, like every read here.
        const priorReturns = await tx.orderReturnLine.groupBy({
          by: ['orderLineId'],
          where: {
            tenantId: scopedTenantId,
            return: { tenantId: scopedTenantId, orderId: order.id },
          },
          _sum: { quantity: true },
        });
        const alreadyReturned = new Map(
          priorReturns.map((row) => [
            row.orderLineId,
            row._sum.quantity ?? 0,
          ]),
        );

        const plan = planReturn(
          order.lines.map((line) => ({
            id: line.id,
            productId: line.productId,
            sku: line.sku,
            productName: line.productName,
            unitOfMeasure: line.unitOfMeasure,
            quantity: line.quantity,
            unitPriceMinor: line.unitPriceMinor,
            currencyCode: line.currencyCode,
          })),
          alreadyReturned,
          input.kind === OrderReturnKind.ORDER_CANCELLATION
            ? null
            : (input.lines ?? []),
        );
        if (typeof plan === 'string') {
          return plan;
        }

        const orderReturn = await tx.orderReturn.create({
          data: {
            tenantId: scopedTenantId,
            orderId: order.id,
            kind: input.kind,
            status: OrderReturnStatus.RECORDED,
            reference: input.reference,
            reason: input.reason,
            restockedQuantity: plan.restockedQuantity,
            refundAmountMinor: plan.refundAmountMinor,
            currencyCode: plan.currencyCode,
            // A return starts owing nothing. The service links a refund
            // afterwards, or records why there was none.
            refundSkipReason: input.refundRequested
              ? null
              : RefundSkipReason.NOT_REQUESTED,
            recordedById: input.actorId,
          },
        });

        // Reverse stock line by line IN productId ORDER, exactly like checkout
        // completion: every concurrent multi-product reverse-flow write locks
        // products in the same sequence, so two returns sharing products
        // cannot deadlock.
        const ordered = [...plan.lines].sort((a, b) =>
          a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0,
        );
        for (const line of ordered) {
          let movementId: string | null = null;
          if (line.restocked) {
            try {
              const { movement, level } =
                await this.inventoryRepository.applyMovement(tx, {
                  tenantId: scopedTenantId,
                  locationId: order.locationId,
                  productId: line.productId,
                  quantityDelta: line.quantity,
                  movementType: InventoryMovementType.RETURN_IN,
                  // The returned quantity was captured in the ORDER LINE's
                  // unit. If the product's unit changed since the sale,
                  // putting that number back would mean something else
                  // entirely — reject rather than corrupt the ledger.
                  expectedUnitOfMeasure: line.unitOfMeasure,
                  reason: input.reason,
                  referenceType: MOVEMENT_REFERENCE_TYPE.ORDER_RETURN,
                  referenceId: orderReturn.id,
                  createdById: input.actorId,
                });
              movementId = movement.id;
              await this.auditLog.record(
                builders.stockReturned(movement, level, line),
                tx,
              );
            } catch (error) {
              if (error instanceof AdjustmentRejected) {
                // Re-thrown with the offending SKU so the 409 can name it;
                // throwing (not returning) is what rolls everything back.
                throw new ReturnStockRejected(error.reason, line.sku);
              }
              throw error;
            }
          }
          await tx.orderReturnLine.create({
            data: {
              tenantId: scopedTenantId,
              returnId: orderReturn.id,
              orderLineId: line.orderLineId,
              productId: line.productId,
              sku: line.sku,
              productName: line.productName,
              quantity: line.quantity,
              restocked: line.restocked,
              movementId,
              refundAmountMinor: line.refundAmountMinor,
              note: line.note,
            },
          });
        }

        if (input.kind === OrderReturnKind.ORDER_CANCELLATION) {
          // The tenant travels IN the write predicate, alongside the CONFIRMED
          // guard that makes the flip happen at most once.
          const cancelled = await tx.order.updateMany({
            where: {
              id: order.id,
              tenantId: scopedTenantId,
              status: OrderStatus.CONFIRMED,
            },
            data: {
              status: OrderStatus.CANCELLED,
              cancelledAt: new Date(),
              cancelReason: input.reason,
            },
          });
          if (cancelled.count === 0) {
            // A concurrent cancellation won the order. Roll the whole reversal
            // back rather than leaving stock added against a dead order.
            return 'order-cancel-conflict' as const;
          }
          if (builders.orderCancelled) {
            const after = await tx.order.findFirstOrThrow({
              where: { id: order.id, tenantId: scopedTenantId },
              select: { id: true, status: true },
            });
            await this.auditLog.record(
              builders.orderCancelled(
                { id: order.id, status: order.status },
                after,
              ),
              tx,
            );
          }
        }

        await this.auditLog.record(builders.returnRecorded(orderReturn), tx);
        const detail = await tx.orderReturn.findUniqueOrThrow({
          where: {
            id_tenantId: { id: orderReturn.id, tenantId: scopedTenantId },
          },
          include: RETURN_DETAIL_INCLUDE,
        });
        return { orderReturn: detail, replayed: false };
      })
      .catch((error: unknown) => {
        if (error instanceof ReturnStockRejected) {
          return error;
        }
        throw error;
      });
  }

  /**
   * Records what happened to the money, AFTER the refund has been driven
   * through the payments abstraction.
   *
   * This is the only method that ever updates a return, and it only ever
   * writes the refund linkage. The lines and their movements are already
   * written and are never touched again — a return's account of what came off
   * the shelf is immutable once recorded.
   */
  async linkRefund(
    tenantId: string,
    returnId: string,
    linkage: {
      status: OrderReturnStatus;
      refundId: string | null;
      refundSkipReason: RefundSkipReason | null;
    },
    buildAuditEntry: (
      before: OrderReturn,
      after: OrderReturn,
    ) => AuditEntry,
  ): Promise<OrderReturnDetail | null> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.orderReturn.findFirst({
        where: { id: returnId, tenantId: scopedTenantId },
      });
      if (!before) {
        return null;
      }
      const after = await tx.orderReturn.update({
        // Composite key: the tenant is IN the write predicate, never merely
        // implied by the lookup above.
        where: { id_tenantId: { id: returnId, tenantId: scopedTenantId } },
        data: {
          status: linkage.status,
          refundId: linkage.refundId,
          refundSkipReason: linkage.refundSkipReason,
        },
      });
      await this.auditLog.record(buildAuditEntry(before, after), tx);
      return tx.orderReturn.findUniqueOrThrow({
        where: { id_tenantId: { id: returnId, tenantId: scopedTenantId } },
        include: RETURN_DETAIL_INCLUDE,
      });
    });
  }

  findById(
    tenantId: string,
    id: string,
  ): Promise<OrderReturnDetail | null> {
    return this.prisma.orderReturn.findFirst({
      where: this.scope(tenantId, { id }),
      include: RETURN_DETAIL_INCLUDE,
    });
  }

  async search(
    tenantId: string,
    filters: { orderId?: string; skip?: number; take?: number },
  ): Promise<{ items: OrderReturnDetail[]; total: number }> {
    const where: Prisma.OrderReturnWhereInput = this.scope(tenantId);
    if (filters.orderId) {
      where.orderId = filters.orderId;
    }
    const [items, total] = await Promise.all([
      this.prisma.orderReturn.findMany({
        where,
        include: RETURN_DETAIL_INCLUDE,
        // id is the deterministic tie-breaker: createdAt is millisecond
        // precision, so concurrent returns could otherwise reorder across
        // skip/take pages.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: filters.skip ?? 0,
        take: filters.take ?? 25,
      }),
      this.prisma.orderReturn.count({ where }),
    ]);
    return { items, total };
  }
}
