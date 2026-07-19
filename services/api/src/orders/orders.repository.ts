import { Injectable } from '@nestjs/common';
import {
  AuditAction,
  Order,
  OrderPaymentStatus,
  OrderStatus,
  PaymentAuthorizationStatus,
  PaymentStatus,
  Prisma,
} from '@prisma/client';
import {
  AuditActor,
  AuditEntry,
  AuditLogService,
  SYSTEM_ACTOR_EMAIL,
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

export type OrderCancelRejection = 'already-cancelled' | 'order-paid';

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
   * payment capture (orderPaymentAdvisoryLockKey), and refuses to cancel a
   * PAID order. Together these close the capture-vs-cancel race: a capture that
   * commits PAID first makes the waiting cancel observe PAID and reject
   * (controlled 409); a cancel that commits first makes the waiting capture's
   * conditional projection match zero rows and roll back. An order can never
   * end up CANCELLED + PAID with no refund flow. The conditional updateMany
   * additionally guards the duplicate-cancel race.
   */
  cancel(
    tenantId: string,
    id: string,
    reason: string | undefined,
    buildAuditEntry: (before: Order, after: OrderDetail) => AuditEntry,
    actor?: AuditActor,
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
      const updated = await tx.order.updateMany({
        where: {
          id,
          tenantId: scopedTenantId,
          status: { in: [OrderStatus.DRAFT, OrderStatus.CONFIRMED] },
          // Backstop the race even without the lock: never cancel a PAID order.
          paymentStatus: { not: OrderPaymentStatus.PAID },
        },
        data: {
          status: OrderStatus.CANCELLED,
          cancelledAt: new Date(),
          cancelReason: reason ?? null,
          // Releasing the order also releases any authorization: an AUTHORIZED
          // order's simulated hold is voided below, so its payment projection
          // becomes VOIDED (an UNPAID order stays UNPAID; PAID was rejected).
          paymentStatus:
            locked.paymentStatus === OrderPaymentStatus.AUTHORIZED
              ? OrderPaymentStatus.VOIDED
              : locked.paymentStatus,
        },
      });
      if (updated.count === 0) {
        // Under the order lock a PAID/CANCELLED order was already rejected
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

      // Phase 6: cancelling an order releases any SIMULATED authorization holds
      // its linked payment intents still carry (AUTHORIZED/CAPTURE_PENDING) —
      // the money was authorized but never captured, so no refund is involved.
      // Runs under the SAME order-payment lock as capture, so it cannot race a
      // capture. A PAID order was already rejected above, so no CAPTURED intent
      // is voided here.
      const heldIntents = await tx.paymentIntent.findMany({
        where: {
          tenantId: scopedTenantId,
          status: {
            in: [PaymentStatus.AUTHORIZED, PaymentStatus.CAPTURE_PENDING],
          },
          OR: [{ orderId: id }, { checkoutSessionId: locked.checkoutSessionId }],
        },
      });
      if (heldIntents.length > 0) {
        const heldIds = heldIntents.map((intent) => intent.id);
        await tx.paymentAuthorization.updateMany({
          where: {
            tenantId: scopedTenantId,
            intentId: { in: heldIds },
            status: PaymentAuthorizationStatus.AUTHORIZED,
          },
          data: {
            status: PaymentAuthorizationStatus.VOIDED,
            voidedAt: new Date(),
          },
        });
        for (const heldIntent of heldIntents) {
          const voidedIntent = await tx.paymentIntent.update({
            where: {
              id_tenantId: { id: heldIntent.id, tenantId: scopedTenantId },
            },
            data: { status: PaymentStatus.VOIDED, cancelledAt: new Date() },
          });
          await this.auditLog.record(
            {
              tenantId: scopedTenantId,
              actorId: actor?.id ?? null,
              actorEmail: actor?.email ?? SYSTEM_ACTOR_EMAIL,
              action: AuditAction.VOID,
              entityType: 'PaymentIntent',
              entityId: heldIntent.id,
              before: heldIntent,
              after: voidedIntent,
              reason: `Authorization hold released by order ${after.orderNumber} cancellation`,
            },
            tx,
          );
        }
      }
      return after;
    });
  }
}
