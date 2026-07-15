import { Injectable } from '@nestjs/common';
import {
  InventoryLevel,
  InventoryMovement,
  InventoryMovementType,
  Prisma,
  ProductStatus,
  UnitOfMeasure,
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
  | 'product-not-saleable'
  | 'unit-of-measure-changed'
  | 'insufficient-stock'
  | 'quantity-overflow';

export interface AdjustmentResult {
  level: InventoryLevel;
  movement: InventoryMovement;
}

/**
 * Thrown INSIDE the movement transaction to abort it. Rejecting by throwing
 * (rather than returning a sentinel) guarantees the whole transaction rolls
 * back — including any InventoryLevel row the upsert created — so a rejected
 * movement never leaves an orphan projection behind. `adjust()` catches it at
 * the boundary and maps it back to the AdjustmentFailure sentinel; external
 * callers of `applyMovement()` (checkout completion) catch it to roll back
 * their own enclosing transaction.
 */
export class AdjustmentRejected extends Error {
  constructor(readonly reason: AdjustmentFailure) {
    super(reason);
    this.name = 'AdjustmentRejected';
  }
}

/**
 * One ledger movement applied inside a caller-supplied transaction. The
 * referenceType/referenceId pair links the movement to its business cause
 * (e.g. 'Order' + orderId for checkout completion) without schema changes.
 */
export interface ApplyMovementInput {
  tenantId: string;
  locationId: string;
  productId: string;
  quantityDelta: number;
  movementType: InventoryMovementType;
  /**
   * When set, the product's CURRENT unit of measure is revalidated against
   * this snapshot under the per-product advisory lock, and a mismatch rejects
   * the movement ('unit-of-measure-changed'). Callers that consume stock
   * against a quantity captured earlier (checkout completion consuming a
   * basket-line snapshot) MUST pass it: a UOM change between snapshot and
   * movement would silently reinterpret the quantity in the new unit.
   */
  expectedUnitOfMeasure?: UnitOfMeasure;
  reason?: string | null;
  referenceType?: string | null;
  referenceId?: string | null;
  createdById?: string | null;
}

export interface ApplyMovementResult {
  movement: InventoryMovement;
  level: InventoryLevel;
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
        const { movement, level } = await this.applyMovement(tx, {
          tenantId: scopedTenantId,
          locationId: data.locationId,
          productId: data.productId,
          quantityDelta: data.quantityDelta,
          movementType: InventoryMovementType.ADJUSTMENT,
          reason: data.reason,
          createdById: data.createdById,
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

  /**
   * Applies ONE ledger movement inside a CALLER-SUPPLIED transaction: scoped
   * existence checks, conditional atomic level increment, and the immutable
   * movement append — everything `adjust()` does except owning the
   * transaction and writing the audit row (the caller audits, so the audit
   * commits/rolls back with the caller's own transaction).
   *
   * Used by manual adjustments (via `adjust()`) and by checkout completion,
   * which decrements every basket line atomically with order creation: any
   * AdjustmentRejected thrown here aborts the caller's whole transaction, so
   * a failed decrement can never leave a confirmed order behind.
   */
  async applyMovement(
    tx: Prisma.TransactionClient,
    input: ApplyMovementInput,
  ): Promise<ApplyMovementResult> {
    const scopedTenantId = this.requireTenantId(input.tenantId);

    // Serialize against product mutations that depend on ledger state
    // (unit-of-measure change, archive) for THIS product: a plain row read
    // does not stop a concurrent UOM/archive update from committing while
    // this movement appends. The advisory lock is held for the rest of the
    // caller's transaction and released on commit/rollback. (Re-acquiring
    // the same key inside one transaction is a no-op, so multi-line callers
    // may lock the same product twice safely.)
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${productStockAdvisoryLockKey(
      scopedTenantId,
      input.productId,
    )}))`;

    // Scoped existence checks: ids from other tenants are simply not
    // found. Every rejection THROWS so the transaction rolls back —
    // see AdjustmentRejected.
    const location = await tx.location.findFirst({
      where: { id: input.locationId, tenantId: scopedTenantId },
      select: { id: true },
    });
    if (!location) {
      throw new AdjustmentRejected('location-not-found');
    }
    const product = await tx.product.findFirst({
      where: { id: input.productId, tenantId: scopedTenantId },
      select: { id: true, status: true, unitOfMeasure: true },
    });
    if (!product) {
      throw new AdjustmentRejected('product-not-found');
    }
    if (product.status === ProductStatus.ARCHIVED) {
      throw new AdjustmentRejected('product-archived');
    }
    // A SALE consumes stock for a shopper: the product must be saleable NOW,
    // not merely when it entered the basket. DRAFT/DISCONTINUED products can
    // still be adjusted/received (Phase 3 behavior, unchanged for non-SALE
    // movements) but can no longer be sold. Checked under the per-product
    // advisory lock, so a concurrent status change cannot slip in between.
    if (
      input.movementType === InventoryMovementType.SALE &&
      product.status !== ProductStatus.ACTIVE
    ) {
      throw new AdjustmentRejected('product-not-saleable');
    }
    // Revalidate the caller's UOM snapshot (see ApplyMovementInput): the
    // quantityDelta was captured in the snapshot unit, so if the product's
    // unit changed since, applying it would corrupt ledger semantics.
    if (
      input.expectedUnitOfMeasure !== undefined &&
      product.unitOfMeasure !== input.expectedUnitOfMeasure
    ) {
      throw new AdjustmentRejected('unit-of-measure-changed');
    }

    // Attribute the movement only to an actor IN THIS TENANT. A
    // createdById from another tenant (or a stale/deleted user) resolves
    // to null rather than corrupting tenant-scoped ledger attribution —
    // the single-column FK alone would accept any global user id.
    const actorId = input.createdById
      ? ((
          await tx.user.findFirst({
            where: { id: input.createdById, tenantId: scopedTenantId },
            select: { id: true },
          })
        )?.id ?? null)
      : null;

    // Ensure the projection row exists (starts at zero stock). If the
    // movement is later rejected, this insert is rolled back with the
    // rest of the transaction, so no orphan level survives.
    await tx.inventoryLevel.upsert({
      where: {
        tenantId_locationId_productId: {
          tenantId: scopedTenantId,
          locationId: input.locationId,
          productId: input.productId,
        },
      },
      update: {},
      create: {
        tenantId: scopedTenantId,
        locationId: input.locationId,
        productId: input.productId,
        quantity: 0,
      },
    });

    // Conditional atomic increment: matches only when the resulting
    // quantity stays within [0, PG_INT_MAX]. The lower bound stops a
    // decrease going negative; the upper bound (added only for increases)
    // stops the sum overflowing the INTEGER column. Zero rows updated ⇒
    // the movement would breach a bound.
    const requiredMinimum = Math.max(0, -input.quantityDelta);
    // A decrease of PG_INT_MIN needs a minimum of PG_INT_MAX+1 on hand,
    // which no INTEGER column can hold. Short-circuit before that bound
    // reaches Prisma as an out-of-range filter literal.
    if (requiredMinimum > PG_INT_MAX) {
      throw new AdjustmentRejected('insufficient-stock');
    }
    const quantityBound: Prisma.IntFilter = {
      gte: requiredMinimum,
    };
    if (input.quantityDelta > 0) {
      quantityBound.lte = PG_INT_MAX - input.quantityDelta;
    }
    const updated = await tx.inventoryLevel.updateMany({
      where: {
        tenantId: scopedTenantId,
        locationId: input.locationId,
        productId: input.productId,
        quantity: quantityBound,
      },
      data: { quantity: { increment: input.quantityDelta } },
    });
    if (updated.count === 0) {
      // A positive delta always satisfies the lower bound, so a miss there
      // is an overflow; a negative delta can only miss the lower bound.
      throw new AdjustmentRejected(
        input.quantityDelta > 0 ? 'quantity-overflow' : 'insufficient-stock',
      );
    }

    const level = await tx.inventoryLevel.findUniqueOrThrow({
      where: {
        tenantId_locationId_productId: {
          tenantId: scopedTenantId,
          locationId: input.locationId,
          productId: input.productId,
        },
      },
    });

    const movement = await tx.inventoryMovement.create({
      data: {
        tenantId: scopedTenantId,
        locationId: input.locationId,
        productId: input.productId,
        movementType: input.movementType,
        quantityDelta: input.quantityDelta,
        quantityAfter: level.quantity,
        // The ledger requires a human-readable cause; movement type is the
        // honest fallback when the caller supplies none.
        reason: input.reason ?? input.movementType,
        referenceType: input.referenceType ?? null,
        referenceId: input.referenceId ?? null,
        createdById: actorId,
      },
    });

    return { movement, level };
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
