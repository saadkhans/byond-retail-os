import { Injectable } from '@nestjs/common';
import {
  InventoryLevel,
  InventoryMovement,
  InventoryMovementType,
  Prisma,
  ProductStatus,
} from '@prisma/client';
import {
  AuditEntry,
  AuditLogService,
} from '../common/audit/audit-log.service';
import { PG_INT_MAX } from '../common/integer-bounds';
import { productStockAdvisoryLockKey } from '../common/locks';
import { PrismaService } from '../prisma/prisma.service';
import { TenantScopedRepository } from '../prisma/tenant-scoped.repository';

/** Read shape for stock level listings. */
export const LEVEL_INCLUDE = {
  product: {
    select: {
      id: true,
      sku: true,
      name: true,
      status: true,
      unitOfMeasure: true,
      lowStockThreshold: true,
    },
  },
  location: { select: { id: true, name: true, code: true } },
} satisfies Prisma.InventoryLevelInclude;

export type InventoryLevelWithRefs = Prisma.InventoryLevelGetPayload<{
  include: typeof LEVEL_INCLUDE;
}>;

export type AdjustmentFailure =
  | 'location-not-found'
  | 'product-not-found'
  | 'product-archived'
  | 'insufficient-stock'
  | 'quantity-overflow';

export interface AdjustmentResult {
  level: InventoryLevel;
  movement: InventoryMovement;
}

/**
 * Thrown INSIDE the adjustment transaction to abort it. Rejecting by throwing
 * (rather than returning a sentinel) guarantees the whole transaction rolls
 * back — including any InventoryLevel row the upsert created — so a rejected
 * adjustment never leaves an orphan projection behind. Caught at the boundary
 * and mapped back to the AdjustmentFailure sentinel.
 */
class AdjustmentRejected extends Error {
  constructor(readonly reason: AdjustmentFailure) {
    super(reason);
    this.name = 'AdjustmentRejected';
  }
}

@Injectable()
export class InventoryRepository extends TenantScopedRepository {
  constructor(
    prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {
    super(prisma);
  }

  /**
   * Applies a manual stock adjustment ATOMICALLY, ledger-first in spirit:
   * the movement row, the projected level change, and the audit record
   * commit or roll back together — a stock level can never change without
   * its immutable ledger entry (AGENTS.md inventory invariant).
   *
   * The level is only ever changed via a CONDITIONAL atomic increment
   * (`quantity >= -delta`), never assigned from user input, so concurrent
   * adjustments serialize on the row and can never drive stock negative —
   * with the CHECK constraint in migration SQL as a final backstop.
   */
  adjust(
    tenantId: string,
    data: {
      locationId: string;
      productId: string;
      quantityDelta: number;
      reason: string;
      createdById?: string;
    },
    buildAuditEntry: (
      movement: InventoryMovement,
      level: InventoryLevel,
    ) => AuditEntry,
  ): Promise<AdjustmentResult | AdjustmentFailure> {
    // Synchronous (never a wildcard query) — must run before the promise.
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.runAdjustment(scopedTenantId, data, buildAuditEntry);
  }

  private async runAdjustment(
    scopedTenantId: string,
    data: {
      locationId: string;
      productId: string;
      quantityDelta: number;
      reason: string;
      createdById?: string;
    },
    buildAuditEntry: (
      movement: InventoryMovement,
      level: InventoryLevel,
    ) => AuditEntry,
  ): Promise<AdjustmentResult | AdjustmentFailure> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        // Serialize against product mutations that depend on ledger state
        // (unit-of-measure change, archive) for THIS product: a plain row read
        // does not stop a concurrent UOM/archive update from committing while
        // this adjustment appends a movement. The advisory lock is held for
        // the rest of the transaction and released on commit/rollback.
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${productStockAdvisoryLockKey(
          scopedTenantId,
          data.productId,
        )}))`;

        // Scoped existence checks: ids from other tenants are simply not
        // found. Every rejection THROWS so the transaction rolls back —
        // see AdjustmentRejected.
        const location = await tx.location.findFirst({
          where: { id: data.locationId, tenantId: scopedTenantId },
          select: { id: true },
        });
        if (!location) {
          throw new AdjustmentRejected('location-not-found');
        }
        const product = await tx.product.findFirst({
          where: { id: data.productId, tenantId: scopedTenantId },
          select: { id: true, status: true },
        });
        if (!product) {
          throw new AdjustmentRejected('product-not-found');
        }
        if (product.status === ProductStatus.ARCHIVED) {
          throw new AdjustmentRejected('product-archived');
        }

        // Attribute the movement only to an actor IN THIS TENANT. A
        // createdById from another tenant (or a stale/deleted user) resolves
        // to null rather than corrupting tenant-scoped ledger attribution —
        // the single-column FK alone would accept any global user id.
        const actorId = data.createdById
          ? ((
              await tx.user.findFirst({
                where: { id: data.createdById, tenantId: scopedTenantId },
                select: { id: true },
              })
            )?.id ?? null)
          : null;

        // Ensure the projection row exists (starts at zero stock). If the
        // adjustment is later rejected, this insert is rolled back with the
        // rest of the transaction, so no orphan level survives.
        await tx.inventoryLevel.upsert({
          where: {
            tenantId_locationId_productId: {
              tenantId: scopedTenantId,
              locationId: data.locationId,
              productId: data.productId,
            },
          },
          update: {},
          create: {
            tenantId: scopedTenantId,
            locationId: data.locationId,
            productId: data.productId,
            quantity: 0,
          },
        });

        // Conditional atomic increment: matches only when the resulting
        // quantity stays within [0, PG_INT_MAX]. The lower bound stops a
        // decrease going negative; the upper bound (added only for increases)
        // stops the sum overflowing the INTEGER column. Zero rows updated ⇒
        // the adjustment would breach a bound.
        const quantityBound: Prisma.IntFilter = {
          gte: Math.max(0, -data.quantityDelta),
        };
        if (data.quantityDelta > 0) {
          quantityBound.lte = PG_INT_MAX - data.quantityDelta;
        }
        const updated = await tx.inventoryLevel.updateMany({
          where: {
            tenantId: scopedTenantId,
            locationId: data.locationId,
            productId: data.productId,
            quantity: quantityBound,
          },
          data: { quantity: { increment: data.quantityDelta } },
        });
        if (updated.count === 0) {
          // A positive delta always satisfies the lower bound, so a miss there
          // is an overflow; a negative delta can only miss the lower bound.
          throw new AdjustmentRejected(
            data.quantityDelta > 0 ? 'quantity-overflow' : 'insufficient-stock',
          );
        }

        const level = await tx.inventoryLevel.findUniqueOrThrow({
          where: {
            tenantId_locationId_productId: {
              tenantId: scopedTenantId,
              locationId: data.locationId,
              productId: data.productId,
            },
          },
        });

        const movement = await tx.inventoryMovement.create({
          data: {
            tenantId: scopedTenantId,
            locationId: data.locationId,
            productId: data.productId,
            movementType: InventoryMovementType.ADJUSTMENT,
            quantityDelta: data.quantityDelta,
            quantityAfter: level.quantity,
            reason: data.reason,
            createdById: actorId,
          },
        });

        await this.auditLog.record(buildAuditEntry(movement, level), tx);
        return { level, movement };
      });
    } catch (error) {
      if (error instanceof AdjustmentRejected) {
        return error.reason;
      }
      throw error;
    }
  }

  findLevels(
    tenantId: string,
    filters: { locationId?: string; productId?: string },
  ): Promise<InventoryLevelWithRefs[]> {
    const where: Prisma.InventoryLevelWhereInput = this.scope(tenantId);
    if (filters.locationId) {
      where.locationId = filters.locationId;
    }
    if (filters.productId) {
      where.productId = filters.productId;
    }
    return this.prisma.inventoryLevel.findMany({
      where,
      include: LEVEL_INCLUDE,
      orderBy: { updatedAt: 'desc' },
    });
  }

  async findMovements(
    tenantId: string,
    filters: {
      locationId?: string;
      productId?: string;
      skip?: number;
      take?: number;
    },
  ): Promise<{ items: InventoryMovement[]; total: number }> {
    const where: Prisma.InventoryMovementWhereInput = this.scope(tenantId);
    if (filters.locationId) {
      where.locationId = filters.locationId;
    }
    if (filters.productId) {
      where.productId = filters.productId;
    }
    const [items, total] = await Promise.all([
      this.prisma.inventoryMovement.findMany({
        where,
        // id is the deterministic tie-breaker: createdAt is millisecond
        // precision, so concurrent movements can share a timestamp and would
        // otherwise reorder across pages under skip/take.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: filters.skip ?? 0,
        take: filters.take ?? 50,
      }),
      this.prisma.inventoryMovement.count({ where }),
    ]);
    return { items, total };
  }
}
