import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction } from '@prisma/client';
import {
  AuditActor,
  AuditEntry,
  SYSTEM_ACTOR_EMAIL,
} from '../common/audit/audit-log.service';
import { containsSensitiveValue } from '../common/sensitive-keys';
import { CancelOrderDto } from './dto/cancel-order.dto';
import { QueryOrdersDto } from './dto/query-orders.dto';
import {
  OrderDetail,
  OrdersRepository,
  OrderWithRefs,
} from './orders.repository';

@Injectable()
export class OrdersService {
  constructor(private readonly ordersRepository: OrdersRepository) {}

  async findById(tenantId: string, id: string): Promise<OrderDetail> {
    const order = await this.ordersRepository.findById(tenantId, id);
    if (!order) {
      throw new NotFoundException(`Order "${id}" not found`);
    }
    return order;
  }

  async search(
    tenantId: string,
    query: QueryOrdersDto,
  ): Promise<{
    items: OrderWithRefs[];
    total: number;
    skip: number;
    take: number;
  }> {
    const skip = query.skip ?? 0;
    const take = query.take ?? 25;
    const { items, total } = await this.ordersRepository.search(tenantId, {
      status: query.status,
      locationId: query.locationId,
      unitId: query.unitId,
      orderNumber: query.orderNumber?.trim() || undefined,
      skip,
      take,
    });
    return { items, total, skip, take };
  }

  async cancel(
    tenantId: string,
    id: string,
    dto: CancelOrderDto,
    actor?: AuditActor,
  ): Promise<OrderDetail> {
    const reason = dto.reason?.trim() || undefined;
    // The reason is persisted verbatim to Order.cancelReason AND used as the
    // audit reason; audit-snapshot redaction only covers before/after, not the
    // top-level reason field. Reject credential-/payment-bearing content before
    // either write (AGENTS.md payments invariant), like device metadata.
    this.assertSafeReason(reason);
    const result = await this.ordersRepository.cancel(
      tenantId,
      id,
      reason,
      (before, after) =>
        this.auditEntry(tenantId, actor, {
          action: AuditAction.CANCEL,
          entityType: 'Order',
          entityId: after.id,
          before,
          after,
          reason: dto.reason?.trim() || 'Order cancelled',
        }),
    );
    if (result === null) {
      throw new NotFoundException(`Order "${id}" not found`);
    }
    if (result === 'already-cancelled') {
      throw new ConflictException('Order is already cancelled');
    }
    if (result === 'order-paid') {
      throw new ConflictException(
        'Order is paid and cannot be cancelled here; returns/refunds are a later phase',
      );
    }
    return result;
  }

  /**
   * A cancellation reason is free-form operator text; it must never carry
   * credential- or payment-bearing values (a pasted PAN, token, or credential
   * URL) into Order.cancelReason or the audit log. Reject (controlled 400)
   * before persistence — redaction is only a backstop.
   */
  private assertSafeReason(reason: string | undefined): void {
    if (reason !== undefined && containsSensitiveValue(reason)) {
      throw new BadRequestException(
        'Cancellation reason must not contain credential- or ' +
          'payment-bearing values',
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
      actorEmail: actor?.email ?? SYSTEM_ACTOR_EMAIL,
      ...partial,
    };
  }
}
