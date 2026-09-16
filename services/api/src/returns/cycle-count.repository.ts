import { Injectable } from '@nestjs/common';
import {
  CycleCount,
  CycleCountLine,
  CycleCountStatus,
  Prisma,
} from '@prisma/client';
import {
  AuditEntry,
  AuditLogService,
} from '../common/audit/audit-log.service';
import {
  cycleCountAdvisoryLockKey,
  productStockAdvisoryLockKey,
} from '../common/locks';
import {
  AdjustmentFailure,
  AdjustmentRejected,
  InventoryRepository,
} from '../inventory/inventory.repository';
import { PrismaService } from '../prisma/prisma.service';
import { TenantScopedRepository } from '../prisma/tenant-scoped.repository';
import { MAX_CYCLE_COUNT_LINES, MOVEMENT_REFERENCE_TYPE } from './returns.constants';
import { compareCount } from './returns.logic';

export const CYCLE_COUNT_DETAIL_INCLUDE = {
  lines: { orderBy: [{ productId: 'asc' }, { id: 'asc' }] },
  location: { select: { id: true, name: true, code: true } },
} satisfies Prisma.CycleCountInclude;

export type CycleCountDetail = Prisma.CycleCountGetPayload<{
  include: typeof CYCLE_COUNT_DETAIL_INCLUDE;
}>;

export type CycleCountRejection =
  | 'location-not-found'
  | 'reference-in-use'
  | 'product-not-found'
  | 'not-open'
  | 'no-lines'
  | 'too-many-lines';

/**
 * Thrown INSIDE the reconcile transaction when the ledger refuses a variance
 * correction (most plausibly: the count says a product has fewer units than
 * the projection, and applying the correction would drive stock below zero
 * because a sale landed in between). Throwing rolls the WHOLE reconciliation
 * back, so a count is never half-applied.
 */
export class CountReconcileRejected extends Error {
  constructor(
    readonly failure: AdjustmentFailure,
    readonly productId: string,
  ) {
    super(failure);
    this.name = 'CountReconcileRejected';
  }
}

export interface ReconcileAuditBuilders {
  varianceCorrected: (
    movement: { id: string; quantityDelta: number; productId: string },
    level: { quantity: number },
    line: { productId: string; countedQuantity: number },
  ) => AuditEntry;
  countReconciled: (before: CycleCount, after: CycleCount) => AuditEntry;
}

@Injectable()
export class CycleCountRepository extends TenantScopedRepository {
  constructor(
    prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly inventoryRepository: InventoryRepository,
  ) {
    super(prisma);
  }

  /** Opens a count for one store. Idempotent by (tenantId, reference). */
  open(
    tenantId: string,
    data: {
      locationId: string;
      reference: string;
      isFullStocktake: boolean;
      note?: string;
      actorId?: string;
    },
    buildAuditEntry: (count: CycleCount) => AuditEntry,
  ): Promise<
    { count: CycleCountDetail; replayed: boolean } | CycleCountRejection
  > {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.cycleCount.findFirst({
        where: { tenantId: scopedTenantId, reference: data.reference },
        include: CYCLE_COUNT_DETAIL_INCLUDE,
      });
      if (existing) {
        if (existing.locationId !== data.locationId) {
          return 'reference-in-use' as const;
        }
        return { count: existing, replayed: true };
      }
      const location = await tx.location.findFirst({
        where: { id: data.locationId, tenantId: scopedTenantId },
        select: { id: true },
      });
      if (!location) {
        return 'location-not-found' as const;
      }
      const created = await tx.cycleCount.create({
        data: {
          tenantId: scopedTenantId,
          locationId: data.locationId,
          reference: data.reference,
          isFullStocktake: data.isFullStocktake,
          note: data.note,
          status: CycleCountStatus.OPEN,
          createdById: data.actorId,
        },
      });
      await this.auditLog.record(buildAuditEntry(created), tx);
      const detail = await tx.cycleCount.findUniqueOrThrow({
        where: { id_tenantId: { id: created.id, tenantId: scopedTenantId } },
        include: CYCLE_COUNT_DETAIL_INCLUDE,
      });
      return { count: detail, replayed: false };
    });
  }

  /**
   * Records what an operator found for ONE product. Re-counting the same
   * product overwrites the counted figure — a count sheet is a working
   * document until it is reconciled, and nothing here has touched stock yet.
   *
   * The upsert key is (tenantId, cycleCountId, productId), so the TENANT is
   * part of the write predicate rather than being implied by the lookup.
   */
  recordLine(
    tenantId: string,
    cycleCountId: string,
    data: {
      productId: string;
      countedQuantity: number;
      note?: string;
    },
    buildAuditEntry: (line: CycleCountLine) => AuditEntry,
  ): Promise<CycleCountLine | CycleCountRejection | null> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${cycleCountAdvisoryLockKey(
        scopedTenantId,
        cycleCountId,
      )}))::text`;
      const count = await tx.cycleCount.findFirst({
        where: { id: cycleCountId, tenantId: scopedTenantId },
      });
      if (!count) {
        return null;
      }
      if (count.status !== CycleCountStatus.OPEN) {
        return 'not-open' as const;
      }
      const product = await tx.product.findFirst({
        where: { id: data.productId, tenantId: scopedTenantId },
        select: { id: true },
      });
      if (!product) {
        return 'product-not-found' as const;
      }
      const lineCount = await tx.cycleCountLine.count({
        where: { tenantId: scopedTenantId, cycleCountId },
      });
      const existing = await tx.cycleCountLine.findFirst({
        where: {
          tenantId: scopedTenantId,
          cycleCountId,
          productId: data.productId,
        },
        select: { id: true },
      });
      if (!existing && lineCount >= MAX_CYCLE_COUNT_LINES) {
        return 'too-many-lines' as const;
      }
      const line = await tx.cycleCountLine.upsert({
        where: {
          tenantId_cycleCountId_productId: {
            tenantId: scopedTenantId,
            cycleCountId,
            productId: data.productId,
          },
        },
        create: {
          tenantId: scopedTenantId,
          cycleCountId,
          productId: data.productId,
          countedQuantity: data.countedQuantity,
          note: data.note,
        },
        update: {
          countedQuantity: data.countedQuantity,
          note: data.note ?? null,
        },
      });
      await this.auditLog.record(buildAuditEntry(line), tx);
      return line;
    });
  }

  /**
   * Reconciles the count. THE method of this file, and the one place where the
   * "reconciliation must not become a second source of truth" rule is either
   * kept or broken.
   *
   * For every counted product, under that product's advisory lock:
   *
   *   * the stock PROJECTION is READ (never written);
   *   * the LEDGER is replayed by summing its signed deltas for the same
   *     (store, product);
   *   * the two are compared with each other and with the counted figure.
   *
   * The counted figure is never assigned anywhere. If it differs from the
   * projection, the difference is appended to the ledger as a signed
   * CORRECTION_IN / CORRECTION_OUT movement through the same
   * `applyMovement` every other stock change uses, and the projection moves
   * because of that movement. A count that agrees with the books writes no
   * movement at all.
   *
   * `ledgerDriftQuantity` (projection minus ledger replay) is recorded rather
   * than corrected. It must always be zero; a non-zero value means the
   * projection disagrees with its own history, which is a platform bug and
   * must be investigated, not quietly absorbed into an operator's variance.
   */
  reconcile(
    tenantId: string,
    cycleCountId: string,
    actorId: string | undefined,
    builders: ReconcileAuditBuilders,
  ): Promise<
    CycleCountDetail | CycleCountRejection | CountReconcileRejected | null
  > {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma
      .$transaction(async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${cycleCountAdvisoryLockKey(
          scopedTenantId,
          cycleCountId,
        )}))::text`;
        const count = await tx.cycleCount.findFirst({
          where: { id: cycleCountId, tenantId: scopedTenantId },
          include: { lines: { orderBy: [{ productId: 'asc' }, { id: 'asc' }] } },
        });
        if (!count) {
          return null;
        }
        if (count.status !== CycleCountStatus.OPEN) {
          return 'not-open' as const;
        }
        if (count.lines.length === 0) {
          return 'no-lines' as const;
        }

        for (const line of count.lines) {
          // Products are visited in id order (the include orders by
          // productId), so two concurrent reconciliations sharing products
          // take the per-product locks in the same sequence and cannot
          // deadlock — the same discipline checkout completion uses.
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${productStockAdvisoryLockKey(
            scopedTenantId,
            line.productId,
          )}))::text`;
          // READ ONLY. The projection is evidence here, never a target.
          const level = await tx.inventoryLevel.findFirst({
            where: {
              tenantId: scopedTenantId,
              locationId: count.locationId,
              productId: line.productId,
            },
            select: { quantity: true },
          });
          const replay = await tx.inventoryMovement.aggregate({
            where: {
              tenantId: scopedTenantId,
              locationId: count.locationId,
              productId: line.productId,
            },
            _sum: { quantityDelta: true },
          });
          const comparison = compareCount({
            countedQuantity: line.countedQuantity,
            systemQuantity: level?.quantity ?? 0,
            ledgerQuantity: replay._sum.quantityDelta ?? 0,
          });

          let movementId: string | null = null;
          if (comparison.movementType !== null) {
            try {
              const applied = await this.inventoryRepository.applyMovement(tx, {
                tenantId: scopedTenantId,
                locationId: count.locationId,
                productId: line.productId,
                quantityDelta: comparison.varianceQuantity,
                movementType: comparison.movementType,
                reason: `Cycle count ${count.reference} variance`,
                referenceType: MOVEMENT_REFERENCE_TYPE.CYCLE_COUNT,
                referenceId: count.id,
                createdById: actorId,
              });
              movementId = applied.movement.id;
              await this.auditLog.record(
                builders.varianceCorrected(applied.movement, applied.level, line),
                tx,
              );
            } catch (error) {
              if (error instanceof AdjustmentRejected) {
                throw new CountReconcileRejected(error.reason, line.productId);
              }
              throw error;
            }
          }
          await tx.cycleCountLine.update({
            // Composite key: the tenant is IN the write predicate.
            where: {
              id_tenantId: { id: line.id, tenantId: scopedTenantId },
            },
            data: {
              systemQuantity: level?.quantity ?? 0,
              ledgerQuantity: replay._sum.quantityDelta ?? 0,
              varianceQuantity: comparison.varianceQuantity,
              ledgerDriftQuantity: comparison.ledgerDriftQuantity,
              movementId,
            },
          });
        }

        const after = await tx.cycleCount.update({
          where: {
            id_tenantId: { id: cycleCountId, tenantId: scopedTenantId },
          },
          data: {
            status: CycleCountStatus.RECONCILED,
            reconciledAt: new Date(),
            reconciledById: actorId,
          },
        });
        await this.auditLog.record(
          builders.countReconciled(count, after),
          tx,
        );
        return tx.cycleCount.findUniqueOrThrow({
          where: {
            id_tenantId: { id: cycleCountId, tenantId: scopedTenantId },
          },
          include: CYCLE_COUNT_DETAIL_INCLUDE,
        });
      })
      .catch((error: unknown) => {
        if (error instanceof CountReconcileRejected) {
          return error;
        }
        throw error;
      });
  }

  /** Abandons an open count. It never touched stock, so nothing is reversed. */
  cancel(
    tenantId: string,
    cycleCountId: string,
    buildAuditEntry: (before: CycleCount, after: CycleCount) => AuditEntry,
  ): Promise<CycleCountDetail | CycleCountRejection | null> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${cycleCountAdvisoryLockKey(
        scopedTenantId,
        cycleCountId,
      )}))::text`;
      const before = await tx.cycleCount.findFirst({
        where: { id: cycleCountId, tenantId: scopedTenantId },
      });
      if (!before) {
        return null;
      }
      if (before.status !== CycleCountStatus.OPEN) {
        return 'not-open' as const;
      }
      const after = await tx.cycleCount.update({
        where: { id_tenantId: { id: cycleCountId, tenantId: scopedTenantId } },
        data: {
          status: CycleCountStatus.CANCELLED,
          cancelledAt: new Date(),
        },
      });
      await this.auditLog.record(buildAuditEntry(before, after), tx);
      return tx.cycleCount.findUniqueOrThrow({
        where: { id_tenantId: { id: cycleCountId, tenantId: scopedTenantId } },
        include: CYCLE_COUNT_DETAIL_INCLUDE,
      });
    });
  }

  findById(tenantId: string, id: string): Promise<CycleCountDetail | null> {
    return this.prisma.cycleCount.findFirst({
      where: this.scope(tenantId, { id }),
      include: CYCLE_COUNT_DETAIL_INCLUDE,
    });
  }

  async search(
    tenantId: string,
    filters: { locationId?: string; skip?: number; take?: number },
  ): Promise<{ items: CycleCountDetail[]; total: number }> {
    const where: Prisma.CycleCountWhereInput = this.scope(tenantId);
    if (filters.locationId) {
      where.locationId = filters.locationId;
    }
    const [items, total] = await Promise.all([
      this.prisma.cycleCount.findMany({
        where,
        include: CYCLE_COUNT_DETAIL_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: filters.skip ?? 0,
        take: filters.take ?? 25,
      }),
      this.prisma.cycleCount.count({ where }),
    ]);
    return { items, total };
  }
}
