import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, ShrinkEvent } from '@prisma/client';
import {
  AuditActor,
  AuditEntry,
  SYSTEM_ACTOR_EMAIL,
} from '../common/audit/audit-log.service';
import {
  assertSafeReverseFlowText,
  safeErrorEntityId,
} from './reverse-flow-safety';
import { QueryShrinkDto, RecordShrinkDto } from './returns.dto';
import { ShrinkRepository, ShrinkStockRejected } from './shrink.repository';

/**
 * Phase 27 — the shrink path for CV-detected loss.
 *
 * A camera sees goods leave. No order ever accounts for them. Somebody with
 * `shrink:record` decides that is loss, and this turns that decision into ONE
 * append-only SHRINK movement plus the record of who decided and why.
 *
 * What it deliberately is NOT: automatic. Nothing in this module watches the
 * observation stream, and no pipeline output ever reaches it. A write-off
 * removes real stock from the books, so it stays a human decision against a
 * specific, already-reviewed observation — which is also why the repository
 * refuses an observation that is still in the review queue.
 */
@Injectable()
export class ShrinkService {
  constructor(private readonly repository: ShrinkRepository) {}

  async record(
    tenantId: string,
    dto: RecordShrinkDto,
    actor: AuditActor,
  ): Promise<ShrinkEvent> {
    const reason = dto.reason.trim();
    if (!reason) {
      throw new BadRequestException('A shrink reason is required');
    }
    // Lands verbatim in InventoryMovement.reason, ShrinkEvent.reason AND
    // AuditLog.reason, none of which redaction covers.
    assertSafeReverseFlowText('reason', reason);

    const result = await this.repository.recordShrink(
      tenantId,
      {
        visionEventId: dto.visionEventId,
        productId: dto.productId,
        quantity: dto.quantity,
        reason,
        actorId: actor.id,
      },
      {
        stockWrittenOff: (movement, level) =>
          this.auditEntry(tenantId, actor, {
            action: AuditAction.STOCK_ADJUSTMENT,
            entityType: 'InventoryMovement',
            entityId: movement.id,
            before: { quantity: level.quantity - movement.quantityDelta },
            after: {
              quantity: level.quantity,
              quantityDelta: movement.quantityDelta,
              productId: movement.productId,
            },
            reason,
          }),
        shrinkRecorded: (shrink) =>
          this.auditEntry(tenantId, actor, {
            action: AuditAction.CREATE,
            entityType: 'ShrinkEvent',
            entityId: shrink.id,
            after: shrink,
            reason,
          }),
      },
    );

    if (result instanceof ShrinkStockRejected) {
      if (result.failure === 'insufficient-stock') {
        throw new ConflictException(
          'Write-off rejected: the books already show no stock of this ' +
            'product at this store, so there is nothing left to write off',
        );
      }
      if (result.failure === 'product-archived') {
        throw new ConflictException(
          'Write-off rejected: the product has been archived and can no ' +
            'longer take stock movements',
        );
      }
      throw new ConflictException(`Write-off rejected: ${result.failure}`);
    }
    if (typeof result === 'string') {
      throw this.rejection(result, dto);
    }
    return result.shrink;
  }

  async search(
    tenantId: string,
    query: QueryShrinkDto,
  ): Promise<{
    items: ShrinkEvent[];
    total: number;
    skip: number;
    take: number;
  }> {
    const skip = query.skip ?? 0;
    const take = query.take ?? 25;
    const { items, total } = await this.repository.search(tenantId, {
      locationId: query.locationId,
      skip,
      take,
    });
    return { items, total, skip, take };
  }

  private rejection(reason: string, dto: RecordShrinkDto): Error {
    switch (reason) {
      case 'observation-not-found':
        throw new NotFoundException(
          `Observation "${safeErrorEntityId(dto.visionEventId)}" not found`,
        );
      case 'not-a-pickup':
        throw new ConflictException(
          'Only a PRODUCT_PICKUP observation can become a loss; a return or ' +
            'a transfer is not shrink',
        );
      case 'observation-under-review':
        throw new ConflictException(
          'This observation is still waiting for a human decision. Decide it ' +
            'in the review queue first — an undecided observation is not yet ' +
            'a loss',
        );
      case 'product-not-observed':
        throw new ConflictException(
          'The written-off product is not one this observation proposed. A ' +
            'write-off can only name a SKU the camera actually put forward',
        );
      case 'quantity-exceeds-observation':
        throw new ConflictException(
          'Write-off rejected: it names more units than the observation saw ' +
            'leave',
        );
      case 'loss-already-accounted':
        throw new ConflictException(
          'These goods are already accounted for by an order — they were ' +
            'paid for, so this is not shrink',
        );
      case 'observation-mismatch':
        throw new ConflictException(
          'This observation has already been written off for a different ' +
            'product or quantity',
        );
      default:
        throw new ConflictException(`Write-off rejected: ${reason}`);
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
