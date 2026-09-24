import { Injectable } from '@nestjs/common';
import {
  InventoryMovementType,
  OrderStatus,
  Prisma,
  ShrinkEvent,
  ShrinkSource,
  VisionEventStatus,
  VisionEventType,
} from '@prisma/client';
import {
  AuditEntry,
  AuditLogService,
} from '../common/audit/audit-log.service';
import { shrinkEventAdvisoryLockKey } from '../common/locks';
import {
  AdjustmentFailure,
  AdjustmentRejected,
  InventoryRepository,
} from '../inventory/inventory.repository';
import { PrismaService } from '../prisma/prisma.service';
import { TenantScopedRepository } from '../prisma/tenant-scoped.repository';
import { MOVEMENT_REFERENCE_TYPE } from './returns.constants';

export type ShrinkRejection =
  /** The observation does not exist in this tenant. */
  | 'observation-not-found'
  /** Only a pickup can be a loss: a return or a transfer is not shrink. */
  | 'not-a-pickup'
  /** The observation is still queued for a human. Calling it loss is early. */
  | 'observation-under-review'
  /** The write-off names a product the observation never proposed. */
  | 'product-not-observed'
  /** More units than the camera saw leave. */
  | 'quantity-exceeds-observation'
  /** A live order already accounts for these goods — they were paid for. */
  | 'loss-already-accounted'
  /** The observation was written off before, for something else. */
  | 'observation-mismatch';

export class ShrinkStockRejected extends Error {
  constructor(
    readonly failure: AdjustmentFailure,
    readonly productId: string,
  ) {
    super(failure);
    this.name = 'ShrinkStockRejected';
  }
}

export interface ShrinkAuditBuilders {
  stockWrittenOff: (
    movement: { id: string; quantityDelta: number; productId: string },
    level: { quantity: number },
  ) => AuditEntry;
  shrinkRecorded: (shrink: ShrinkEvent) => AuditEntry;
}

@Injectable()
export class ShrinkRepository extends TenantScopedRepository {
  constructor(
    prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly inventoryRepository: InventoryRepository,
  ) {
    super(prisma);
  }

  /**
   * Turns a CV-detected unexplained loss into a recorded SHRINK movement.
   *
   * This is the whole "shrink path": a vision observation of goods leaving,
   * which no order accounts for, becomes ONE ledger movement and ONE decision
   * record — and it is gated so that it cannot become a way to make stock
   * disappear on demand:
   *
   *   * the observation must exist in THIS tenant and be a PRODUCT_PICKUP;
   *   * it must not still be queued for a human (an undecided observation is
   *     not yet a loss);
   *   * the product must be one the observation actually PROPOSED, so a
   *     write-off cannot name an unrelated SKU;
   *   * the quantity cannot exceed what was observed;
   *   * no live order may already account for the goods — if the shopper's
   *     session became an order that was not cancelled, they paid, and this is
   *     not shrink.
   *
   * Idempotent per observation: (tenantId, visionEventId) is unique and is
   * checked under an advisory lock, so a replayed decision returns the original
   * write-off instead of removing the stock twice. A replay asking for a
   * DIFFERENT product or quantity is a conflict, never a silent success.
   */
  recordShrink(
    tenantId: string,
    input: {
      visionEventId: string;
      productId: string;
      quantity: number;
      reason: string;
      actorId?: string;
    },
    builders: ShrinkAuditBuilders,
  ): Promise<
    | { shrink: ShrinkEvent; replayed: boolean }
    | ShrinkRejection
    | ShrinkStockRejected
  > {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma
      .$transaction(async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${shrinkEventAdvisoryLockKey(
          scopedTenantId,
          input.visionEventId,
        )}))::text`;
        const existing = await tx.shrinkEvent.findFirst({
          where: {
            tenantId: scopedTenantId,
            visionEventId: input.visionEventId,
          },
        });
        if (existing) {
          if (
            existing.productId !== input.productId ||
            existing.quantity !== input.quantity
          ) {
            return 'observation-mismatch' as const;
          }
          return { shrink: existing, replayed: true };
        }

        const observation = await tx.visionEvent.findFirst({
          where: { id: input.visionEventId, tenantId: scopedTenantId },
          select: {
            id: true,
            locationId: true,
            sessionId: true,
            type: true,
            status: true,
            quantity: true,
            candidates: { select: { productId: true } },
          },
        });
        if (!observation) {
          return 'observation-not-found' as const;
        }
        if (observation.type !== VisionEventType.PRODUCT_PICKUP) {
          return 'not-a-pickup' as const;
        }
        if (observation.status === VisionEventStatus.PENDING_REVIEW) {
          return 'observation-under-review' as const;
        }
        if (
          !observation.candidates.some(
            (candidate) => candidate.productId === input.productId,
          )
        ) {
          return 'product-not-observed' as const;
        }
        if (input.quantity > observation.quantity) {
          return 'quantity-exceeds-observation' as const;
        }
        if (observation.sessionId) {
          const order = await tx.order.findFirst({
            where: {
              tenantId: scopedTenantId,
              checkoutSessionId: observation.sessionId,
            },
            select: { id: true, status: true },
          });
          if (order && order.status !== OrderStatus.CANCELLED) {
            return 'loss-already-accounted' as const;
          }
        }

        let movementId: string;
        try {
          const applied = await this.inventoryRepository.applyMovement(tx, {
            tenantId: scopedTenantId,
            locationId: observation.locationId,
            productId: input.productId,
            quantityDelta: -input.quantity,
            movementType: InventoryMovementType.SHRINK,
            reason: input.reason,
            // The OBSERVATION is the cause, and it already exists — so the
            // ledger row can name its evidence without any back-patching.
            referenceType: MOVEMENT_REFERENCE_TYPE.SHRINK,
            referenceId: observation.id,
            createdById: input.actorId,
          });
          movementId = applied.movement.id;
          await this.auditLog.record(
            builders.stockWrittenOff(applied.movement, applied.level),
            tx,
          );
        } catch (error) {
          if (error instanceof AdjustmentRejected) {
            throw new ShrinkStockRejected(error.reason, input.productId);
          }
          throw error;
        }

        const shrink = await tx.shrinkEvent.create({
          data: {
            tenantId: scopedTenantId,
            locationId: observation.locationId,
            productId: input.productId,
            visionEventId: observation.id,
            source: ShrinkSource.CV_DETECTED,
            quantity: input.quantity,
            reason: input.reason,
            movementId,
            recordedById: input.actorId,
          },
        });
        await this.auditLog.record(builders.shrinkRecorded(shrink), tx);
        return { shrink, replayed: false };
      })
      .catch((error: unknown) => {
        if (error instanceof ShrinkStockRejected) {
          return error;
        }
        throw error;
      });
  }

  async search(
    tenantId: string,
    filters: { locationId?: string; skip?: number; take?: number },
  ): Promise<{ items: ShrinkEvent[]; total: number }> {
    const where: Prisma.ShrinkEventWhereInput = this.scope(tenantId);
    if (filters.locationId) {
      where.locationId = filters.locationId;
    }
    const [items, total] = await Promise.all([
      this.prisma.shrinkEvent.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: filters.skip ?? 0,
        take: filters.take ?? 25,
      }),
      this.prisma.shrinkEvent.count({ where }),
    ]);
    return { items, total };
  }
}
