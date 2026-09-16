import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, CycleCountLine } from '@prisma/client';
import {
  AuditActor,
  AuditEntry,
  SYSTEM_ACTOR_EMAIL,
} from '../common/audit/audit-log.service';
import { PG_INT_MAX } from '../common/integer-bounds';
import {
  CountReconcileRejected,
  CycleCountDetail,
  CycleCountRepository,
} from './cycle-count.repository';
import {
  assertSafeReverseFlowText,
  safeErrorEntityId,
} from './reverse-flow-safety';
import {
  CancelCycleCountDto,
  OpenCycleCountDto,
  QueryCycleCountsDto,
  RecordCountLineDto,
} from './returns.dto';

/**
 * Phase 27 — cycle counts and stocktakes.
 *
 * An operator counts a location; reconciling compares what they found against
 * the stock projection AND against the ledger the projection is derived from,
 * and writes a signed correction movement for any difference.
 *
 * The service's job is to keep operator text out of the ledger unscreened, to
 * keep the counted numbers inside what the database can hold, and to turn the
 * repository's rejections into controlled responses. The invariant itself —
 * that a count appends a delta rather than setting a level — lives in the
 * repository and in the migration's CHECK constraints.
 */
@Injectable()
export class CycleCountService {
  constructor(private readonly repository: CycleCountRepository) {}

  async open(
    tenantId: string,
    dto: OpenCycleCountDto,
    actor: AuditActor,
  ): Promise<CycleCountDetail> {
    assertSafeReverseFlowText('reference', dto.reference);
    if (dto.note !== undefined) {
      assertSafeReverseFlowText('note', dto.note);
    }
    const result = await this.repository.open(
      tenantId,
      {
        locationId: dto.locationId,
        reference: dto.reference,
        isFullStocktake: dto.isFullStocktake === true,
        note: dto.note?.trim() || undefined,
        actorId: actor.id,
      },
      (count) =>
        this.auditEntry(tenantId, actor, {
          action: AuditAction.CREATE,
          entityType: 'CycleCount',
          entityId: count.id,
          after: count,
          reason: count.isFullStocktake
            ? 'Stocktake opened'
            : 'Cycle count opened',
        }),
    );
    if (result === 'location-not-found') {
      throw new NotFoundException(
        `Location "${safeErrorEntityId(dto.locationId)}" not found`,
      );
    }
    if (result === 'reference-in-use') {
      throw new ConflictException(
        'That reference is already in use for a count at a different store',
      );
    }
    if (typeof result === 'string') {
      throw new ConflictException(`Count rejected: ${result}`);
    }
    return result.count;
  }

  async recordLine(
    tenantId: string,
    cycleCountId: string,
    dto: RecordCountLineDto,
    actor: AuditActor,
  ): Promise<CycleCountLine> {
    if (dto.note !== undefined) {
      assertSafeReverseFlowText('note', dto.note);
    }
    // Redundant with the DTO, deliberately: a counted quantity that cannot be
    // held by the column would otherwise surface as a raw database error, and
    // count arithmetic must never rest on transport validation alone.
    if (
      !Number.isInteger(dto.countedQuantity) ||
      dto.countedQuantity < 0 ||
      dto.countedQuantity > PG_INT_MAX
    ) {
      throw new BadRequestException(
        'countedQuantity must be a whole number between zero and the maximum ' +
          'supported quantity',
      );
    }
    const result = await this.repository.recordLine(
      tenantId,
      cycleCountId,
      {
        productId: dto.productId,
        countedQuantity: dto.countedQuantity,
        note: dto.note?.trim() || undefined,
      },
      (line) =>
        this.auditEntry(tenantId, actor, {
          action: AuditAction.UPDATE,
          entityType: 'CycleCountLine',
          entityId: line.id,
          after: line,
          reason: 'Counted quantity recorded',
        }),
    );
    if (result === null) {
      throw new NotFoundException(
        `Cycle count "${safeErrorEntityId(cycleCountId)}" not found`,
      );
    }
    if (result === 'product-not-found') {
      throw new NotFoundException(
        `Product "${safeErrorEntityId(dto.productId)}" not found`,
      );
    }
    if (result === 'not-open') {
      throw new ConflictException(
        'This count is no longer open; counted quantities cannot be changed ' +
          'after it has been reconciled or cancelled',
      );
    }
    if (result === 'too-many-lines') {
      throw new BadRequestException('Too many products in one count');
    }
    if (typeof result === 'string') {
      throw new ConflictException(`Count line rejected: ${result}`);
    }
    return result;
  }

  async reconcile(
    tenantId: string,
    cycleCountId: string,
    actor: AuditActor,
  ): Promise<CycleCountDetail> {
    const result = await this.repository.reconcile(
      tenantId,
      cycleCountId,
      actor.id,
      {
        varianceCorrected: (movement, level, line) =>
          this.auditEntry(tenantId, actor, {
            action: AuditAction.STOCK_ADJUSTMENT,
            entityType: 'InventoryMovement',
            entityId: movement.id,
            before: { quantity: level.quantity - movement.quantityDelta },
            after: {
              quantity: level.quantity,
              quantityDelta: movement.quantityDelta,
              productId: movement.productId,
              countedQuantity: line.countedQuantity,
            },
            reason: 'Cycle count variance corrected through the ledger',
          }),
        countReconciled: (before, after) =>
          this.auditEntry(tenantId, actor, {
            action: AuditAction.UPDATE,
            entityType: 'CycleCount',
            entityId: after.id,
            before: { status: before.status },
            after: { status: after.status, reconciledAt: after.reconciledAt },
            reason: 'Count reconciled against the ledger',
          }),
      },
    );
    if (result === null) {
      throw new NotFoundException(
        `Cycle count "${safeErrorEntityId(cycleCountId)}" not found`,
      );
    }
    if (result instanceof CountReconcileRejected) {
      if (result.failure === 'insufficient-stock') {
        throw new ConflictException(
          'Reconciliation rejected: correcting the variance would take ' +
            'on-hand stock below zero — the shelf changed while it was being ' +
            'counted. Nothing was written; re-count and reconcile again.',
        );
      }
      if (result.failure === 'quantity-overflow') {
        throw new ConflictException(
          'Reconciliation rejected: the variance would take on-hand stock ' +
            'above the maximum supported quantity',
        );
      }
      if (result.failure === 'product-archived') {
        throw new ConflictException(
          'Reconciliation rejected: one of the counted products has been ' +
            'archived and can no longer take stock movements',
        );
      }
      throw new ConflictException(
        `Reconciliation rejected: ${result.failure}`,
      );
    }
    if (result === 'not-open') {
      throw new ConflictException(
        'This count has already been reconciled or cancelled',
      );
    }
    if (result === 'no-lines') {
      throw new ConflictException(
        'Reconcile nothing? Record at least one counted product first',
      );
    }
    if (typeof result === 'string') {
      throw new ConflictException(`Reconciliation rejected: ${result}`);
    }
    return result;
  }

  async cancel(
    tenantId: string,
    cycleCountId: string,
    dto: CancelCycleCountDto,
    actor: AuditActor,
  ): Promise<CycleCountDetail> {
    const reason = dto.reason?.trim() || undefined;
    if (reason !== undefined) {
      assertSafeReverseFlowText('reason', reason);
    }
    const result = await this.repository.cancel(
      tenantId,
      cycleCountId,
      (before, after) =>
        this.auditEntry(tenantId, actor, {
          action: AuditAction.CANCEL,
          entityType: 'CycleCount',
          entityId: after.id,
          before: { status: before.status },
          after: { status: after.status },
          reason: reason ?? 'Count abandoned before reconciliation',
        }),
    );
    if (result === null) {
      throw new NotFoundException(
        `Cycle count "${safeErrorEntityId(cycleCountId)}" not found`,
      );
    }
    if (result === 'not-open') {
      throw new ConflictException(
        'This count has already been reconciled or cancelled',
      );
    }
    if (typeof result === 'string') {
      throw new ConflictException(`Cancellation rejected: ${result}`);
    }
    return result;
  }

  async findById(tenantId: string, id: string): Promise<CycleCountDetail> {
    const found = await this.repository.findById(tenantId, id);
    if (!found) {
      throw new NotFoundException(
        `Cycle count "${safeErrorEntityId(id)}" not found`,
      );
    }
    return found;
  }

  async search(
    tenantId: string,
    query: QueryCycleCountsDto,
  ): Promise<{
    items: CycleCountDetail[];
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
