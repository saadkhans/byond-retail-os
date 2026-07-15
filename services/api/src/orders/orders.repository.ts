import { Injectable } from '@nestjs/common';
import { Order, OrderStatus, Prisma } from '@prisma/client';
import {
  AuditEntry,
  AuditLogService,
} from '../common/audit/audit-log.service';
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

export type OrderCancelRejection = 'already-cancelled';

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
   * business never saw. The conditional updateMany guards the
   * read-then-write race (cancel is the only order mutation in Phase 5, so
   * no advisory lock is needed): a concurrent duplicate cancel matches zero
   * rows and reports 'already-cancelled'.
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
      if (before.status === OrderStatus.CANCELLED) {
        return 'already-cancelled' as const;
      }
      const updated = await tx.order.updateMany({
        where: {
          id,
          tenantId: scopedTenantId,
          status: { in: [OrderStatus.DRAFT, OrderStatus.CONFIRMED] },
        },
        data: {
          status: OrderStatus.CANCELLED,
          cancelledAt: new Date(),
          cancelReason: reason ?? null,
        },
      });
      if (updated.count === 0) {
        return 'already-cancelled' as const;
      }
      const after = await tx.order.findUniqueOrThrow({
        where: { id: before.id },
        include: ORDER_DETAIL_INCLUDE,
      });
      await this.auditLog.record(buildAuditEntry(before, after), tx);
      return after;
    });
  }
}
