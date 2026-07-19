import { Injectable } from '@nestjs/common';
import {
  Order,
  OrderPaymentStatus,
  OrderStatus,
  Prisma,
} from '@prisma/client';
import {
  AuditEntry,
  AuditLogService,
} from '../common/audit/audit-log.service';
import { orderPaymentAdvisoryLockKey } from '../common/locks';
import { PrismaService } from '../prisma/prisma.service';
import { TenantScopedRepository } from '../prisma/tenant-scoped.repository';

/** Read shape for order list responses (no lines — keep pages light). */
export const ORDER_INCLUDE = {
  location: { select: { id: true, name: true, code: true } },
  unit: { select: { id: true, name: true, code: true } },
} satisfies Prisma.OrderInclude;

/**
 * Read shape for order detail: snapshot lines in deterministic order plus a
 * minimal reference to the originating checkout session for lineage.
 */
export const ORDER_DETAIL_INCLUDE = {
  ...ORDER_INCLUDE,
  lines: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
  session: {
    select: { id: true, status: true, startedAt: true, endedAt: true },
  },
} satisfies Prisma.OrderInclude;

export type OrderWithRefs = Prisma.OrderGetPayload<{
  include: typeof ORDER_INCLUDE;
}>;

export type OrderDetail = Prisma.OrderGetPayload<{
  include: typeof ORDER_DETAIL_INCLUDE;
}>;

export type OrderCancelRejection =
  | 'already-cancelled'
  | 'order-paid'
  // The order has an active authorization hold — void/cancel the payment
  // intent first (payments module), then cancel the order.
  | 'order-payment-active';

@Injectable()
export class OrdersRepository extends TenantScopedRepository {
  constructor(
    prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {
    super(prisma);
  }

  findById(tenantId: string, id: string): Promise<OrderDetail | null> {
    return this.prisma.order.findFirst({
      where: this.scope(tenantId, { id }),
      include: ORDER_DETAIL_INCLUDE,
    });
  }

  async search(
    tenantId: string,
    filters: {
      status?: OrderStatus;
      locationId?: string;
      unitId?: string;
      orderNumber?: string;
      skip?: number;
      take?: number;
    },
  ): Promise<{ items: OrderWithRefs[]; total: number }> {
    const where: Prisma.OrderWhereInput = this.scope(tenantId);
    if (filters.status) {
      where.status = filters.status;
    }
    if (filters.locationId) {
      where.locationId = filters.locationId;
    }
    if (filters.unitId) {
      where.unitId = filters.unitId;
    }
    if (filters.orderNumber) {
      where.orderNumber = {
        equals: filters.orderNumber,
        mode: 'insensitive',
      };
    }
    const [items, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        include: ORDER_INCLUDE,
        // id is the deterministic tie-breaker: placedAt is millisecond
        // precision, so concurrent orders could otherwise reorder across
        // skip/take pages.
        orderBy: [{ placedAt: 'desc' }, { id: 'desc' }],
        skip: filters.skip ?? 0,
        take: filters.take ?? 25,
      }),
      this.prisma.order.count({ where }),
    ]);
    return { items, total };
  }

  /**
   * Cancels an order: a status flip ONLY. Phase 5 deliberately does not
   * reverse the SALE movements — stock reversal is the returns/refunds
   * phase's job, and silently re-adding stock here would fake a return the
   * business never saw.
   *
   * Cancellation participates in the SAME per-order payment serialization as
   * payment capture (orderPaymentAdvisoryLockKey) and refuses to cancel an
   * order with payment activity: PAID (no refund flow) and AUTHORIZED (an
   * active simulated hold — void/cancel the payment intent first) are both
   * controlled 409s. This keeps refund/void orchestration OUT of the orders
   * module: releasing a hold is the payments module's job. Together with the
   * lock this closes the capture-vs-cancel race — an order can never end up
   * CANCELLED + PAID, and no active hold is left behind by a cancellation.
   */
  cancel(
    tenantId: string,
    id: string,
    reason: string | undefined,
    buildAuditEntry: (before: Order, after: OrderDetail) => AuditEntry,
  ): Promise<OrderDetail | OrderCancelRejection | null> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.order.findFirst({
        where: { id, tenantId: scopedTenantId },
      });
      if (!before) {
        return null;
      }
      // Serialize with payment capture on this order, then re-read below.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${orderPaymentAdvisoryLockKey(
        scopedTenantId,
        before.id,
      )}))`;
      const locked = await tx.order.findFirst({
        where: { id, tenantId: scopedTenantId },
      });
      if (!locked) {
        return null;
      }
      if (locked.status === OrderStatus.CANCELLED) {
        return 'already-cancelled' as const;
      }
      // A paid order must not be cancelled without a returns/refunds flow.
      if (locked.paymentStatus === OrderPaymentStatus.PAID) {
        return 'order-paid' as const;
      }
      // An order with an active authorization hold must have its payment
      // voided/cancelled FIRST (payments module) — cancelling here would
      // leave a live simulated hold behind.
      if (locked.paymentStatus === OrderPaymentStatus.AUTHORIZED) {
        return 'order-payment-active' as const;
      }
      const updated = await tx.order.updateMany({
        where: {
          id,
          tenantId: scopedTenantId,
          status: { in: [OrderStatus.DRAFT, OrderStatus.CONFIRMED] },
          // Backstop the race even without the lock: never cancel an order
          // with payment activity.
          paymentStatus: {
            notIn: [OrderPaymentStatus.PAID, OrderPaymentStatus.AUTHORIZED],
          },
        },
        data: {
          status: OrderStatus.CANCELLED,
          cancelledAt: new Date(),
          cancelReason: reason ?? null,
        },
      });
      if (updated.count === 0) {
        // Under the order lock PAID/AUTHORIZED/CANCELLED were already rejected
        // above, so a zero match here means the row is no longer cancellable
        // (a concurrent terminal transition) — report it as already-cancelled.
        return 'already-cancelled' as const;
      }
      const after = await tx.order.findUniqueOrThrow({
        where: { id: before.id },
        include: ORDER_DETAIL_INCLUDE,
      });
      // Audit from the under-lock snapshot so before/after reflect the real
      // immediately-prior state.
      await this.auditLog.record(buildAuditEntry(locked, after), tx);
      return after;
    });
  }
}
