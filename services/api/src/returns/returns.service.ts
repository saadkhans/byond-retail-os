import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  OrderReturn,
  OrderReturnKind,
  OrderReturnStatus,
  PaymentRefundStatus,
  RefundSkipReason,
} from '@prisma/client';
import {
  AuditActor,
  AuditEntry,
  SYSTEM_ACTOR_EMAIL,
} from '../common/audit/audit-log.service';
import { PaymentsService } from '../payments/payments.service';
import { assertSafeReverseFlowText, safeErrorEntityId } from './reverse-flow-safety';
import { IDEMPOTENCY } from './returns.constants';
import { QueryReturnsDto, RecordReturnDto } from './returns.dto';
import {
  OrderReturnDetail,
  ReturnsRepository,
  ReturnStockRejected,
} from './returns.repository';

/**
 * Phase 27 — returns, cancellations and the refunds they trigger.
 *
 * The service owns the ORDER of the two irreversible things a return does, and
 * nothing else:
 *
 *   1. Goods first. The repository reverses stock and records the return in
 *      ONE transaction. If anything about the goods is wrong (an archived
 *      product, a quantity that was never bought), nothing at all happens.
 *   2. Money second, and only if goods succeeded. The refund goes through
 *      PaymentsService — the SAME provider-neutral abstraction an operator
 *      drives by hand. This module owns no payment logic and touches no
 *      payment table.
 *
 * Doing it this way means a failed refund leaves a correct, visible record (a
 * RECORDED return with REFUND_FAILED status and the goods properly back on the
 * shelf) rather than a half-reversed order. The reverse is not true: money
 * moved for goods that never came back would be unrecoverable.
 */
@Injectable()
export class ReturnsService {
  constructor(
    private readonly repository: ReturnsRepository,
    private readonly payments: PaymentsService,
  ) {}

  async recordReturn(
    tenantId: string,
    dto: RecordReturnDto,
    actor: AuditActor,
  ): Promise<OrderReturnDetail> {
    const reason = dto.reason.trim();
    if (!reason) {
      throw new BadRequestException('A return reason is required');
    }
    // The reason lands verbatim in InventoryMovement.reason, Order.cancelReason
    // and AuditLog.reason, none of which redaction covers. Screen before any
    // write (AGENTS.md payments invariant).
    assertSafeReverseFlowText('reason', reason);
    // The reference charset ([A-Za-z0-9._-]) still admits a PAN grouped by
    // dash, dot OR underscore, so it gets the same strict screen.
    assertSafeReverseFlowText('reference', dto.reference);
    for (const line of dto.lines ?? []) {
      if (line.note !== undefined) {
        assertSafeReverseFlowText('note', line.note);
      }
    }
    if (
      dto.kind === OrderReturnKind.CUSTOMER_RETURN &&
      (dto.lines ?? []).length === 0
    ) {
      throw new BadRequestException(
        'A customer return must name the lines coming back',
      );
    }

    const refundRequested = dto.refund !== false;
    const result = await this.repository.recordReturn(
      tenantId,
      {
        orderId: dto.orderId,
        kind: dto.kind,
        reference: dto.reference,
        reason,
        lines:
          dto.kind === OrderReturnKind.ORDER_CANCELLATION
            ? null
            : (dto.lines ?? []).map((line) => ({
                orderLineId: line.orderLineId,
                quantity: line.quantity,
                restock: line.restock,
                note: line.note,
              })),
        refundRequested,
        actorId: actor.id,
      },
      {
        returnRecorded: (orderReturn) =>
          this.auditEntry(tenantId, actor, {
            action: AuditAction.CREATE,
            entityType: 'OrderReturn',
            entityId: orderReturn.id,
            after: orderReturn,
            reason,
          }),
        stockReturned: (movement, level, line) =>
          this.auditEntry(tenantId, actor, {
            action: AuditAction.STOCK_ADJUSTMENT,
            entityType: 'InventoryMovement',
            entityId: movement.id,
            before: { quantity: level.quantity - movement.quantityDelta },
            after: {
              quantity: level.quantity,
              quantityDelta: movement.quantityDelta,
              productId: movement.productId,
              sku: line.sku,
            },
            reason,
          }),
        orderCancelled: (before, after) =>
          this.auditEntry(tenantId, actor, {
            action: AuditAction.CANCEL,
            entityType: 'Order',
            entityId: after.id,
            before,
            after,
            reason,
          }),
      },
    );
    const recorded = this.resolveReturn(result, dto);
    return this.settleMoney(tenantId, recorded, refundRequested, reason, actor);
  }

  async findById(tenantId: string, id: string): Promise<OrderReturnDetail> {
    const found = await this.repository.findById(tenantId, id);
    if (!found) {
      throw new NotFoundException(
        `Return "${safeErrorEntityId(id)}" not found`,
      );
    }
    return found;
  }

  async search(
    tenantId: string,
    query: QueryReturnsDto,
  ): Promise<{
    items: OrderReturnDetail[];
    total: number;
    skip: number;
    take: number;
  }> {
    const skip = query.skip ?? 0;
    const take = query.take ?? 25;
    const { items, total } = await this.repository.search(tenantId, {
      orderId: query.orderId,
      skip,
      take,
    });
    return { items, total, skip, take };
  }

  // --------------------------------------------------------------- the money

  /**
   * Turns a recorded return into a refund, or records why there was none.
   *
   * Safe to call on a REPLAYED return: a return that already carries a refund
   * (or a skip reason) short-circuits, so retrying a request never pays a
   * shopper twice. The refund's own idempotency key is derived from the return
   * id — which is itself guarded by the caller's tenant-scoped `reference` —
   * so even a replay that DID reach the payments module lands on the original
   * refund row.
   *
   * This is also where Phase 26's inherited terminal-payment-state thread is
   * resolved. A pre-existing intent that ended CANCELLED/FAILED/VOIDED/EXPIRED
   * never captured anything, so there is nothing to give back: the return is
   * recorded with NO_CAPTURED_PAYMENT rather than throwing. Goods still come
   * back, the order is still cancelled, and the absence of a refund is stated
   * in a closed vocabulary instead of being an exception.
   */
  private async settleMoney(
    tenantId: string,
    orderReturn: OrderReturnDetail,
    refundRequested: boolean,
    reason: string,
    actor: AuditActor,
  ): Promise<OrderReturnDetail> {
    if (
      orderReturn.refundId !== null ||
      orderReturn.refundSkipReason !== null ||
      orderReturn.status !== OrderReturnStatus.RECORDED
    ) {
      return orderReturn;
    }
    if (!refundRequested) {
      return this.link(tenantId, orderReturn, {
        status: OrderReturnStatus.RECORDED,
        refundId: null,
        refundSkipReason: RefundSkipReason.NOT_REQUESTED,
      });
    }
    if (
      orderReturn.refundAmountMinor === null ||
      orderReturn.refundAmountMinor <= 0
    ) {
      return this.link(tenantId, orderReturn, {
        status: OrderReturnStatus.RECORDED,
        refundId: null,
        refundSkipReason: RefundSkipReason.NO_PRICEABLE_LINES,
      });
    }
    const intent = await this.payments.findCapturedIntentForOrder(
      tenantId,
      orderReturn.orderId,
    );
    if (!intent) {
      return this.link(tenantId, orderReturn, {
        status: OrderReturnStatus.RECORDED,
        refundId: null,
        refundSkipReason: RefundSkipReason.NO_CAPTURED_PAYMENT,
      });
    }
    const refundable = intent.capturedAmountMinor - intent.refundedAmountMinor;
    if (refundable <= 0) {
      return this.link(tenantId, orderReturn, {
        status: OrderReturnStatus.RECORDED,
        refundId: null,
        refundSkipReason: RefundSkipReason.ALREADY_FULLY_REFUNDED,
      });
    }
    // The ceiling wins over what the goods were worth. Both numbers are kept:
    // the return says what came back, the refund says what was actually
    // returnable — an auditor can see the gap instead of it being smoothed
    // over, and the payments module re-checks the same ceiling anyway.
    const amountMinor = Math.min(orderReturn.refundAmountMinor, refundable);
    const refund = await this.payments.refund(
      tenantId,
      intent.id,
      {
        amountMinor,
        reason,
        idempotencyKey: IDEMPOTENCY.returnRefund(orderReturn.id),
      },
      actor,
    );
    return this.link(tenantId, orderReturn, {
      status:
        refund.status === PaymentRefundStatus.SUCCEEDED
          ? OrderReturnStatus.REFUNDED
          : refund.status === PaymentRefundStatus.PENDING
            ? OrderReturnStatus.REFUND_PENDING
            : OrderReturnStatus.REFUND_FAILED,
      refundId: refund.id,
      refundSkipReason: null,
    });
  }

  private async link(
    tenantId: string,
    orderReturn: OrderReturnDetail,
    linkage: {
      status: OrderReturnStatus;
      refundId: string | null;
      refundSkipReason: RefundSkipReason | null;
    },
  ): Promise<OrderReturnDetail> {
    const updated = await this.repository.linkRefund(
      tenantId,
      orderReturn.id,
      linkage,
      (before: OrderReturn, after: OrderReturn) => ({
        tenantId,
        actorId: null,
        actorEmail: SYSTEM_ACTOR_EMAIL,
        action: AuditAction.UPDATE,
        entityType: 'OrderReturn',
        entityId: after.id,
        before: { status: before.status, refundId: before.refundId },
        after: {
          status: after.status,
          refundId: after.refundId,
          refundSkipReason: after.refundSkipReason,
        },
        reason:
          linkage.refundId === null
            ? `No refund recorded: ${linkage.refundSkipReason}`
            : 'Refund linked to the return',
      }),
    );
    return updated ?? orderReturn;
  }

  // --------------------------------------------------------------- rejection

  private resolveReturn(
    result: Awaited<ReturnType<ReturnsRepository['recordReturn']>>,
    dto: RecordReturnDto,
  ): OrderReturnDetail {
    if (result === null) {
      throw new NotFoundException(
        `Order "${safeErrorEntityId(dto.orderId)}" not found`,
      );
    }
    if (result instanceof ReturnStockRejected) {
      throw this.stockConflict(result);
    }
    if (typeof result === 'string') {
      throw this.planConflict(result);
    }
    return result.orderReturn;
  }

  private planConflict(rejection: string): Error {
    switch (rejection) {
      case 'no-lines':
        throw new BadRequestException(
          'A customer return must name the lines coming back',
        );
      case 'too-many-lines':
        throw new BadRequestException('Too many lines in one return');
      case 'duplicate-line':
        throw new BadRequestException(
          'Each order line may appear at most once in a return',
        );
      case 'line-not-on-order':
        throw new BadRequestException(
          'A returned line does not belong to this order',
        );
      case 'quantity-invalid':
        throw new BadRequestException(
          'Each returned quantity must be a whole number of at least one',
        );
      case 'quantity-exceeds-remaining':
        throw new ConflictException(
          'Return rejected: it would take back more units than were bought, ' +
            'counting everything already returned',
        );
      case 'nothing-left-to-return':
        throw new ConflictException(
          'Every line on this order has already been returned; there is ' +
            'nothing left to reverse',
        );
      case 'order-not-returnable':
        throw new ConflictException(
          'Only a CONFIRMED order can be returned or cancelled here',
        );
      case 'reference-mismatch':
        throw new ConflictException(
          'Return rejected: this reference was already used for a different ' +
            'order — reuse a reference only to retry the identical request',
        );
      case 'order-cancel-conflict':
        throw new ConflictException(
          'The order was cancelled by someone else while this return was ' +
            'being recorded; nothing was changed',
        );
      default:
        throw new ConflictException(`Return rejected: ${rejection}`);
    }
  }

  private stockConflict(rejected: ReturnStockRejected): Error {
    const sku = safeErrorEntityId(rejected.sku);
    switch (rejected.failure) {
      case 'product-archived':
        throw new ConflictException(
          `Stock of ARCHIVED product "${sku}" cannot be returned to the shelf`,
        );
      case 'unit-of-measure-changed':
        throw new ConflictException(
          `Return rejected: the unit of measure of "${sku}" changed since it ` +
            'was sold, so the returned quantity can no longer be trusted',
        );
      case 'quantity-overflow':
        throw new ConflictException(
          `Return rejected: restocking "${sku}" would exceed the maximum ` +
            'supported quantity',
        );
      case 'location-not-found':
      case 'product-not-found':
        throw new NotFoundException(
          `The store or product behind "${sku}" no longer exists`,
        );
      default:
        throw new ConflictException(
          `Return rejected for "${sku}": ${rejected.failure}`,
        );
    }
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
      actorEmail: actor?.email || SYSTEM_ACTOR_EMAIL,
      ...partial,
    };
  }
}
