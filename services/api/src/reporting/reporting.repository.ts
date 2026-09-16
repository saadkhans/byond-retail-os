import { Injectable } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  DamagedReturnGroup,
  LedgerBalanceRow,
  MovementGroup,
  ProjectedBalanceRow,
  SalesPricePoint,
  ShrinkGroup,
  VerdictGroup,
} from './reporting.logic';

/**
 * Phase 30 — every database read reporting makes, and nothing else.
 *
 * Three properties hold for every method in this file, and `read-only.spec.ts`
 * enforces them over the whole directory:
 *
 *  1. IT NEVER WRITES. There is no create/update/upsert/delete anywhere in
 *     this module. Reporting reads; it is not a second source of truth, so it
 *     has nothing to persist.
 *  2. EVERY READ CARRIES `tenantId` IN ITS OWN PREDICATE — including the
 *     relation filters, which repeat the tenant rather than trusting the
 *     parent join, and the raw query, which parameterises it.
 *  3. THE DATABASE DOES THE ARITHMETIC. Order lines are collapsed into price
 *     points, movements into signed sums per type, reviews into verdict
 *     counts. Nothing loads a ledger into memory to add it up.
 */
@Injectable()
export class ReportingRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Sales, collapsed by the database into PRICE POINTS.
   *
   * One row per (product, currency, price-book version, promotion version,
   * base price, discount, unit price) — the grain at which a sale is
   * explainable. `take` is a REFUSAL threshold, not a page: the service asks
   * for one more row than it will accept and rejects the request rather than
   * return a total that silently omits revenue.
   */
  async salesPricePoints(
    tenantId: string,
    filter: {
      from: Date;
      to: Date;
      locationId?: string;
      productId?: string;
      take: number;
    },
  ): Promise<SalesPricePoint[]> {
    const groups = await this.prisma.orderLine.groupBy({
      by: [
        'productId',
        'sku',
        'productName',
        'currencyCode',
        'priceBookVersionId',
        'promotionVersionId',
        'basePriceMinor',
        'promotionDiscountMinor',
        'unitPriceMinor',
      ],
      where: this.salesWhere(tenantId, filter),
      _sum: { quantity: true, lineTotalMinor: true },
      _count: { _all: true },
      orderBy: [{ productId: 'asc' }, { unitPriceMinor: 'asc' }],
      take: filter.take,
    });
    return groups.map((group) => ({
      productId: group.productId,
      sku: group.sku,
      productName: group.productName,
      currencyCode: group.currencyCode,
      priceBookVersionId: group.priceBookVersionId,
      promotionVersionId: group.promotionVersionId,
      basePriceMinor: group.basePriceMinor,
      promotionDiscountMinor: group.promotionDiscountMinor,
      unitPriceMinor: group.unitPriceMinor,
      units: group._sum.quantity ?? 0,
      lineTotalMinor: group._sum.lineTotalMinor,
      lines: group._count._all,
    }));
  }

  /**
   * The same window aggregated WITHOUT grouping: an independent total the
   * rolled-up price points are checked against. If the two disagree the
   * report says so instead of picking one.
   */
  async salesTotals(
    tenantId: string,
    filter: { from: Date; to: Date; locationId?: string; productId?: string },
  ): Promise<{ units: number; netSalesMinor: number; lines: number }> {
    const totals = await this.prisma.orderLine.aggregate({
      where: this.salesWhere(tenantId, filter),
      _sum: { quantity: true, lineTotalMinor: true },
      _count: { _all: true },
    });
    return {
      units: totals._sum.quantity ?? 0,
      netSalesMinor: totals._sum.lineTotalMinor ?? 0,
      lines: totals._count._all,
    };
  }

  /**
   * Only CONFIRMED orders are sales. A cancelled order is not revenue, and a
   * draft never happened. `tenantId` is named on the line AND repeated inside
   * the order filter so neither side can be reached cross-tenant.
   */
  private salesWhere(
    tenantId: string,
    filter: { from: Date; to: Date; locationId?: string; productId?: string },
  ) {
    return {
      tenantId,
      ...(filter.productId ? { productId: filter.productId } : {}),
      order: {
        is: {
          tenantId,
          status: OrderStatus.CONFIRMED,
          placedAt: { gte: filter.from, lt: filter.to },
          ...(filter.locationId ? { locationId: filter.locationId } : {}),
        },
      },
    };
  }

  /**
   * One order with the price and promotion provenance of each line.
   *
   * `select` is explicit and narrow on purpose: an order line also carries CV
   * evidence lineage (evidence bundle, vision event, evidence score), and a
   * sales report is not a place for any of it.
   */
  orderWithProvenance(tenantId: string, orderId: string) {
    return this.prisma.order.findFirst({
      where: { id: orderId, tenantId },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        paymentStatus: true,
        placedAt: true,
        locationId: true,
        totalQuantity: true,
        subtotalMinor: true,
        totalMinor: true,
        currencyCode: true,
        lines: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            productId: true,
            sku: true,
            productName: true,
            quantity: true,
            unitPriceMinor: true,
            lineTotalMinor: true,
            currencyCode: true,
            basePriceMinor: true,
            promotionDiscountMinor: true,
            priceBookVersion: {
              select: {
                id: true,
                versionNumber: true,
                status: true,
                effectiveFrom: true,
                effectiveTo: true,
                activatedAt: true,
                reason: true,
                priceBook: {
                  select: { id: true, code: true, name: true, currencyCode: true },
                },
              },
            },
            promotionVersion: {
              select: {
                id: true,
                versionNumber: true,
                status: true,
                effectiveFrom: true,
                effectiveTo: true,
                activatedAt: true,
                reason: true,
                promotion: {
                  select: { id: true, code: true, name: true, audience: true },
                },
              },
            },
          },
        },
      },
    });
  }

  /** Signed net change per movement type over the window. */
  async movementSummary(
    tenantId: string,
    filter: { from: Date; to: Date; locationId?: string; productId?: string },
  ): Promise<MovementGroup[]> {
    const groups = await this.prisma.inventoryMovement.groupBy({
      by: ['movementType'],
      where: {
        tenantId,
        createdAt: { gte: filter.from, lt: filter.to },
        ...(filter.locationId ? { locationId: filter.locationId } : {}),
        ...(filter.productId ? { productId: filter.productId } : {}),
      },
      _sum: { quantityDelta: true },
      _count: { _all: true },
    });
    return groups.map((group) => ({
      movementType: group.movementType,
      quantityDeltaSum: group._sum.quantityDelta ?? 0,
      movements: group._count._all,
    }));
  }

  /**
   * Balances DERIVED from the ledger: SUM(quantityDelta) per
   * (location, product), summed by the database over the whole history.
   *
   * This is the balance the report publishes. The projection is fetched
   * separately and only ever shown beside it.
   */
  async ledgerBalances(
    tenantId: string,
    filter: {
      locationId?: string;
      productId?: string;
      skip: number;
      take: number;
    },
  ): Promise<LedgerBalanceRow[]> {
    const groups = await this.prisma.inventoryMovement.groupBy({
      by: ['locationId', 'productId'],
      where: {
        tenantId,
        ...(filter.locationId ? { locationId: filter.locationId } : {}),
        ...(filter.productId ? { productId: filter.productId } : {}),
      },
      _sum: { quantityDelta: true },
      _count: { _all: true },
      orderBy: [{ locationId: 'asc' }, { productId: 'asc' }],
      skip: filter.skip,
      take: filter.take,
    });
    return groups.map((group) => ({
      locationId: group.locationId,
      productId: group.productId,
      ledgerQuantity: group._sum.quantityDelta ?? 0,
      movements: group._count._all,
    }));
  }

  /** The projection rows for exactly the pairs on this page. */
  async projectedBalances(
    tenantId: string,
    pairs: readonly { locationId: string; productId: string }[],
  ): Promise<ProjectedBalanceRow[]> {
    if (pairs.length === 0) {
      return [];
    }
    const levels = await this.prisma.inventoryLevel.findMany({
      where: {
        tenantId,
        OR: pairs.map((pair) => ({
          locationId: pair.locationId,
          productId: pair.productId,
        })),
      },
      select: { locationId: true, productId: true, quantity: true },
    });
    return levels;
  }

  /**
   * Cycle-count reconciliation totals.
   *
   * Variance and ledger drift are summed in the SAME query but kept in
   * SEPARATE aggregates, and the line counts are taken separately too. There
   * is deliberately no query anywhere that adds them together.
   */
  async countReconciliation(
    tenantId: string,
    filter: { from: Date; to: Date; locationId?: string; productId?: string },
  ): Promise<{
    lines: number;
    varianceQuantitySum: number;
    varianceLines: number;
    ledgerDriftQuantitySum: number;
    ledgerDriftLines: number;
  }> {
    // Named for the guarantee it carries: `read-only.spec.ts` checks that a
    // reused read predicate is tenant-scoped AND says so in its name.
    const tenantScopedWhere = {
      tenantId,
      ...(filter.productId ? { productId: filter.productId } : {}),
      cycleCount: {
        is: {
          tenantId,
          status: 'RECONCILED' as const,
          reconciledAt: { gte: filter.from, lt: filter.to },
          ...(filter.locationId ? { locationId: filter.locationId } : {}),
        },
      },
    };
    // `not: 0` on a nullable column is ambiguous about NULLs; an explicit
    // "greater or less than zero" is not.
    const nonZero = [{ gt: 0 }, { lt: 0 }];
    const [totals, varianceLines, ledgerDriftLines] = await Promise.all([
      this.prisma.cycleCountLine.aggregate({
        where: tenantScopedWhere,
        _sum: { varianceQuantity: true, ledgerDriftQuantity: true },
        _count: { _all: true },
      }),
      this.prisma.cycleCountLine.count({
        where: {
          ...tenantScopedWhere,
          OR: nonZero.map((cmp) => ({ varianceQuantity: cmp })),
        },
      }),
      this.prisma.cycleCountLine.count({
        where: {
          ...tenantScopedWhere,
          OR: nonZero.map((cmp) => ({ ledgerDriftQuantity: cmp })),
        },
      }),
    ]);
    return {
      lines: totals._count._all,
      varianceQuantitySum: totals._sum.varianceQuantity ?? 0,
      varianceLines,
      ledgerDriftQuantitySum: totals._sum.ledgerDriftQuantity ?? 0,
      ledgerDriftLines,
    };
  }

  /** Recorded write-offs, grouped by product and by where the decision came from. */
  async shrinkGroups(
    tenantId: string,
    filter: { from: Date; to: Date; locationId?: string },
  ): Promise<ShrinkGroup[]> {
    const groups = await this.prisma.shrinkEvent.groupBy({
      by: ['productId', 'source'],
      where: {
        tenantId,
        createdAt: { gte: filter.from, lt: filter.to },
        ...(filter.locationId ? { locationId: filter.locationId } : {}),
      },
      _sum: { quantity: true },
      _count: { _all: true },
    });
    return groups.map((group) => ({
      productId: group.productId,
      source: group.source,
      units: group._sum.quantity ?? 0,
      events: group._count._all,
    }));
  }

  /** The SHRINK movements the ledger itself carries in the same window. */
  async shrinkLedgerTotals(
    tenantId: string,
    filter: { from: Date; to: Date; locationId?: string },
  ): Promise<{ quantityDeltaSum: number; movements: number }> {
    const totals = await this.prisma.inventoryMovement.aggregate({
      where: {
        tenantId,
        movementType: 'SHRINK',
        createdAt: { gte: filter.from, lt: filter.to },
        ...(filter.locationId ? { locationId: filter.locationId } : {}),
      },
      _sum: { quantityDelta: true },
      _count: { _all: true },
    });
    return {
      quantityDeltaSum: totals._sum.quantityDelta ?? 0,
      movements: totals._count._all,
    };
  }

  /**
   * Returned goods that did NOT go back on the shelf.
   *
   * Counted here so the shrink report can show them NEXT TO shrink and say
   * they are not the same thing. `restocked: false` lines deliberately have
   * no ledger movement, which is exactly why they can never be shrink.
   */
  async damagedReturnGroups(
    tenantId: string,
    filter: { from: Date; to: Date; locationId?: string },
  ): Promise<DamagedReturnGroup[]> {
    const groups = await this.prisma.orderReturnLine.groupBy({
      by: ['productId'],
      where: {
        tenantId,
        restocked: false,
        return: {
          is: {
            tenantId,
            createdAt: { gte: filter.from, lt: filter.to },
            ...(filter.locationId
              ? { order: { is: { tenantId, locationId: filter.locationId } } }
              : {}),
          },
        },
      },
      _sum: { quantity: true },
      _count: { _all: true },
    });
    return groups.map((group) => ({
      productId: group.productId,
      units: group._sum.quantity ?? 0,
      lines: group._count._all,
    }));
  }

  /** Does this evaluation run exist in this tenant? */
  async evaluationRunExists(
    tenantId: string,
    evaluationRunId: string,
  ): Promise<boolean> {
    const run = await this.prisma.pilotEvaluationRun.findFirst({
      where: { id: evaluationRunId, tenantId },
      select: { id: true },
    });
    return run !== null;
  }

  /**
   * The LATEST verdict per observation, grouped into counts — computed
   * entirely in Postgres.
   *
   * Reviews are append-only: an observation can carry several, and only the
   * newest one counts. `DISTINCT ON` is the one thing Prisma's query builder
   * cannot express, so this is the module's single raw statement. It is a
   * fixed string with bound parameters — nothing is concatenated in.
   *
   * What it selects is as important as how:
   *  - it returns COUNTS of verdicts, actions and catalog SKUs. No evidence
   *    bundle, vision event, media key, storage path, crop artifact or
   *    reviewer note is projected, so a CV-accuracy report cannot become a
   *    side channel for raw observation evidence;
   *  - REVIEW_REQUIRED observations are excluded, matching the pilot
   *    summary — a true-negative rejection is dataset evidence, not an
   *    accuracy judgment;
   *  - FUSION_SHADOW (video-backed) observations are included ONLY when the
   *    caller cleared the same video boundary the pilot observation route
   *    checks. Without it the report sees live observations only, exactly as
   *    that route does.
   */
  async latestVerdictGroups(
    tenantId: string,
    evaluationRunId: string,
    options: { includeVideoObservations: boolean },
  ): Promise<VerdictGroup[]> {
    const includeVideo = options.includeVideoObservations;
    const rows = await this.prisma.$queryRaw<
      {
        verdict: string;
        predictedAction: string | null;
        expectedAction: string;
        predictedSku: string | null;
        expectedSku: string | null;
        count: bigint;
      }[]
    >`
      SELECT
        latest."verdict"         AS "verdict",
        latest."predictedAction" AS "predictedAction",
        latest."expectedAction"  AS "expectedAction",
        latest."predictedSku"    AS "predictedSku",
        latest."expectedSku"     AS "expectedSku",
        COUNT(*)                 AS "count"
      FROM (
        SELECT DISTINCT ON (COALESCE(r."journeyEventId", r."id"))
          r."verdict"::text          AS "verdict",
          r."predictedAction"::text  AS "predictedAction",
          r."expectedAction"::text   AS "expectedAction",
          r."predictedSku"           AS "predictedSku",
          r."expectedSku"            AS "expectedSku"
        FROM "PilotObservationReview" r
        LEFT JOIN "CustomerJourneyEvent" e
          ON e."id" = r."journeyEventId" AND e."tenantId" = ${tenantId}
        WHERE r."tenantId" = ${tenantId}
          AND r."evaluationRunId" = ${evaluationRunId}
          AND (e."id" IS NULL OR e."eventType" <> 'REVIEW_REQUIRED')
          AND (
            e."id" IS NULL
            OR e."sourceType" <> 'FUSION_SHADOW'
            OR ${includeVideo}::boolean
          )
        ORDER BY
          COALESCE(r."journeyEventId", r."id"),
          r."createdAt" DESC,
          r."id" DESC
      ) latest
      GROUP BY 1, 2, 3, 4, 5
    `;
    return rows.map((row) => ({
      verdict: row.verdict,
      predictedAction: row.predictedAction,
      expectedAction: row.expectedAction,
      predictedSku: row.predictedSku,
      expectedSku: row.expectedSku,
      count: Number(row.count),
    }));
  }
}
