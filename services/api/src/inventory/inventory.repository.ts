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
  | 'insufficient-stock';

export interface AdjustmentResult {
  level: InventoryLevel;
  movement: InventoryMovement;
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
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      // Scoped existence checks: ids from other tenants are simply not found.
      const location = await tx.location.findFirst({
        where: { id: data.locationId, tenantId: scopedTenantId },
        select: { id: true },
      });
      if (!location) {
        return 'location-not-found' as const;
      }
      const product = await tx.product.findFirst({
        where: { id: data.productId, tenantId: scopedTenantId },
        select: { id: true, status: true },
      });
      if (!product) {
        return 'product-not-found' as const;
      }
      if (product.status === ProductStatus.ARCHIVED) {
        return 'product-archived' as const;
      }

      // Ensure the projection row exists (starts at zero stock).
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
      // quantity stays >= 0. Zero rows updated ⇒ insufficient stock.
      const updated = await tx.inventoryLevel.updateMany({
        where: {
          tenantId: scopedTenantId,
          locationId: data.locationId,
          productId: data.productId,
          quantity: { gte: Math.max(0, -data.quantityDelta) },
        },
        data: { quantity: { increment: data.quantityDelta } },
      });
      if (updated.count === 0) {
        return 'insufficient-stock' as const;
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
          createdById: data.createdById ?? null,
        },
      });

      await this.auditLog.record(buildAuditEntry(movement, level), tx);
      return { level, movement };
    });
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
        orderBy: { createdAt: 'desc' },
        skip: filters.skip ?? 0,
        take: filters.take ?? 50,
      }),
      this.prisma.inventoryMovement.count({ where }),
    ]);
    return { items, total };
  }
}
