import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PlatformModulesService } from '../platform-modules/platform-modules.service';
import {
  DEFAULT_BALANCE_ROWS,
  DEFAULT_WINDOW_DAYS,
  MAX_SALES_PRICE_POINTS,
  provenance,
  ReportProvenance,
} from './reporting.constants';
import {
  QueryBalancesReportDto,
  QueryCvAccuracyReportDto,
  QueryInventoryReportDto,
  QuerySalesReportDto,
  QueryShrinkReportDto,
} from './reporting.dto';
import {
  BalanceReportBody,
  buildBalances,
  buildCountReconciliation,
  buildCvAccuracy,
  buildShrinkReport,
  checkOrderLine,
  CountReconciliationReport,
  CvAccuracyReportBody,
  MovementSummary,
  resolveWindow,
  rollUpSales,
  SalesRollup,
  ShrinkReportBody,
  summariseMovements,
} from './reporting.logic';
import { ReportingRepository } from './reporting.repository';

export interface ReportWindow {
  from: string;
  to: string;
}

export interface Viewer {
  /** Permission codes the caller actually holds, from the request context. */
  permissions: readonly string[];
}

/**
 * Phase 30 — sales, inventory, shrink and CV-accuracy reporting.
 *
 * THE INVARIANT: reporting reads. It never writes domain data and it never
 * becomes a second source of truth.
 *
 * Concretely, in this file:
 *  - every number is derived on read from the append-only ledger, the order
 *    lines with their price/promotion provenance, the cycle-count records, or
 *    the evaluation tables. Nothing is cached, materialised or scheduled, so
 *    `stale` is structurally false rather than hopefully false;
 *  - a report can only show what the caller could already read row by row:
 *    each route demands the domain permission as well as `report:read`, and
 *    this service additionally requires the SOURCE module to be enabled for
 *    the tenant. Enabling `reporting` therefore grants nothing new;
 *  - where the platform already draws a boundary, the report draws the same
 *    one. The CV-accuracy report applies the video boundary the pilot
 *    observation route applies, and projects counts only — never evidence;
 *  - where two numbers mean different things they stay apart. Projection
 *    drift is never folded into cycle-count variance, and a damaged return
 *    is never folded into shrink.
 */
@Injectable()
export class ReportingService {
  constructor(
    private readonly repository: ReportingRepository,
    private readonly platformModules: PlatformModulesService,
  ) {}

  // -------------------------------------------------------------------------
  // Sales
  // -------------------------------------------------------------------------

  async salesReport(
    tenantId: string,
    query: QuerySalesReportDto,
  ): Promise<{
    window: ReportWindow;
    filters: { locationId: string | null; productId: string | null };
    scope: string;
    totals: SalesRollup;
    crossCheck: {
      netSalesMinorFromOrderLines: number;
      unitsFromOrderLines: number;
      lines: number;
      reconciled: boolean;
    };
    provenance: ReportProvenance;
  }> {
    await this.requireSourceModule(tenantId, 'checkout');
    const window = this.window(query);
    const filter = {
      from: window.from,
      to: window.to,
      locationId: query.locationId,
      productId: query.productId,
    };
    const [pricePoints, totals] = await Promise.all([
      // One row more than the cap: enough to KNOW the breakdown was
      // incomplete, which is the only honest thing to do with it.
      this.repository.salesPricePoints(tenantId, {
        ...filter,
        take: MAX_SALES_PRICE_POINTS + 1,
      }),
      this.repository.salesTotals(tenantId, filter),
    ]);
    if (pricePoints.length > MAX_SALES_PRICE_POINTS) {
      throw new BadRequestException(
        `This window rolls up more than ${MAX_SALES_PRICE_POINTS} price points. ` +
          'Narrow the window, the store or the product — a truncated ' +
          'breakdown would understate revenue.',
      );
    }
    const rolled = rollUpSales(pricePoints);
    const netFromPricePoints = rolled.byCurrency.reduce(
      (sum, row) => sum + row.netSalesMinor,
      0,
    );
    return {
      window: this.serialiseWindow(window),
      filters: {
        locationId: query.locationId ?? null,
        productId: query.productId ?? null,
      },
      scope:
        'CONFIRMED orders placed in the window. A cancelled order is not ' +
        'revenue and a draft never happened.',
      totals: rolled,
      crossCheck: {
        netSalesMinorFromOrderLines: totals.netSalesMinor,
        unitsFromOrderLines: totals.units,
        lines: totals.lines,
        // The grouped roll-up and an independent ungrouped SUM over the same
        // predicate must agree. If they ever do not, the report says so
        // rather than choosing a favourite.
        reconciled: netFromPricePoints === totals.netSalesMinor,
      },
      provenance: provenance([
        'Order',
        'OrderLine',
        'PriceBookVersion',
        'PromotionVersion',
      ]),
    };
  }

  /**
   * One sale, explained: for every line, which price-book version set the
   * base price, which promotion version took the discount off it, and whether
   * the arithmetic in between actually holds.
   */
  async explainOrder(tenantId: string, orderId: string) {
    await this.requireSourceModule(tenantId, 'checkout');
    const order = await this.repository.orderWithProvenance(tenantId, orderId);
    if (!order) {
      throw new NotFoundException('No such order in this tenant');
    }
    const lines = order.lines.map((line) => ({
      orderLineId: line.id,
      productId: line.productId,
      sku: line.sku,
      productName: line.productName,
      quantity: line.quantity,
      currencyCode: line.currencyCode,
      basePriceMinor: line.basePriceMinor,
      promotionDiscountMinor: line.promotionDiscountMinor,
      unitPriceMinor: line.unitPriceMinor,
      lineTotalMinor: line.lineTotalMinor,
      priceBookVersion: line.priceBookVersion
        ? {
            id: line.priceBookVersion.id,
            versionNumber: line.priceBookVersion.versionNumber,
            status: line.priceBookVersion.status,
            reason: line.priceBookVersion.reason,
            effectiveFrom: line.priceBookVersion.effectiveFrom,
            effectiveTo: line.priceBookVersion.effectiveTo,
            activatedAt: line.priceBookVersion.activatedAt,
            priceBookId: line.priceBookVersion.priceBook.id,
            priceBookCode: line.priceBookVersion.priceBook.code,
            priceBookName: line.priceBookVersion.priceBook.name,
          }
        : null,
      promotionVersion: line.promotionVersion
        ? {
            id: line.promotionVersion.id,
            versionNumber: line.promotionVersion.versionNumber,
            status: line.promotionVersion.status,
            reason: line.promotionVersion.reason,
            effectiveFrom: line.promotionVersion.effectiveFrom,
            effectiveTo: line.promotionVersion.effectiveTo,
            activatedAt: line.promotionVersion.activatedAt,
            promotionId: line.promotionVersion.promotion.id,
            promotionCode: line.promotionVersion.promotion.code,
            promotionName: line.promotionVersion.promotion.name,
            audience: line.promotionVersion.promotion.audience,
          }
        : null,
      checks: checkOrderLine(line),
    }));
    const rolled = rollUpSales(
      order.lines.map((line) => ({
        productId: line.productId,
        sku: line.sku,
        productName: line.productName,
        currencyCode: line.currencyCode,
        priceBookVersionId: line.priceBookVersion?.id ?? null,
        promotionVersionId: line.promotionVersion?.id ?? null,
        basePriceMinor: line.basePriceMinor,
        promotionDiscountMinor: line.promotionDiscountMinor,
        unitPriceMinor: line.unitPriceMinor,
        units: line.quantity,
        lineTotalMinor: line.lineTotalMinor,
        lines: 1,
      })),
    );
    const net = rolled.byCurrency.reduce((sum, row) => sum + row.netSalesMinor, 0);
    return {
      orderId: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      paymentStatus: order.paymentStatus,
      placedAt: order.placedAt,
      locationId: order.locationId,
      lines,
      totals: rolled.byCurrency,
      orderSnapshot: {
        totalQuantity: order.totalQuantity,
        subtotalMinor: order.subtotalMinor,
        totalMinor: order.totalMinor,
        currencyCode: order.currencyCode,
      },
      // The order header carries its own snapshotted total. Recomputing it
      // from the lines and comparing is the point of the endpoint.
      reconciled: order.totalMinor === null ? null : order.totalMinor === net,
      provenance: provenance([
        'Order',
        'OrderLine',
        'PriceBookVersion',
        'PromotionVersion',
      ]),
    };
  }

  // -------------------------------------------------------------------------
  // Inventory
  // -------------------------------------------------------------------------

  async movementReport(
    tenantId: string,
    query: QueryInventoryReportDto,
  ): Promise<{
    window: ReportWindow;
    filters: { locationId: string | null; productId: string | null };
    movements: MovementSummary;
    provenance: ReportProvenance;
  }> {
    await this.requireSourceModule(tenantId, 'inventory');
    const window = this.window(query);
    const groups = await this.repository.movementSummary(tenantId, {
      from: window.from,
      to: window.to,
      locationId: query.locationId,
      productId: query.productId,
    });
    return {
      window: this.serialiseWindow(window),
      filters: {
        locationId: query.locationId ?? null,
        productId: query.productId ?? null,
      },
      movements: summariseMovements(groups),
      provenance: provenance(['InventoryMovement']),
    };
  }

  async balanceReport(
    tenantId: string,
    query: QueryBalancesReportDto,
  ): Promise<
    BalanceReportBody & {
      filters: { locationId: string | null; productId: string | null };
      page: { skip: number; take: number };
      balanceSource: string;
      provenance: ReportProvenance;
    }
  > {
    await this.requireSourceModule(tenantId, 'inventory');
    const skip = query.skip ?? 0;
    const take = query.take ?? DEFAULT_BALANCE_ROWS;
    const ledger = await this.repository.ledgerBalances(tenantId, {
      locationId: query.locationId,
      productId: query.productId,
      skip,
      take,
    });
    const projection = await this.repository.projectedBalances(
      tenantId,
      ledger.map((row) => ({
        locationId: row.locationId,
        productId: row.productId,
      })),
    );
    return {
      ...buildBalances(ledger, projection),
      filters: {
        locationId: query.locationId ?? null,
        productId: query.productId ?? null,
      },
      page: { skip, take },
      balanceSource:
        'SUM(quantityDelta) over the append-only ledger. The InventoryLevel ' +
        'projection is shown only as a cross-check and is never the answer.',
      provenance: provenance(['InventoryMovement', 'InventoryLevel']),
    };
  }

  async countReconciliationReport(
    tenantId: string,
    query: QueryInventoryReportDto,
  ): Promise<
    CountReconciliationReport & {
      window: ReportWindow;
      filters: { locationId: string | null; productId: string | null };
      provenance: ReportProvenance;
    }
  > {
    await this.requireSourceModule(tenantId, 'returns');
    const window = this.window(query);
    const totals = await this.repository.countReconciliation(tenantId, {
      from: window.from,
      to: window.to,
      locationId: query.locationId,
      productId: query.productId,
    });
    return {
      ...buildCountReconciliation(totals),
      window: this.serialiseWindow(window),
      filters: {
        locationId: query.locationId ?? null,
        productId: query.productId ?? null,
      },
      provenance: provenance(['CycleCount', 'CycleCountLine']),
    };
  }

  // -------------------------------------------------------------------------
  // Shrink
  // -------------------------------------------------------------------------

  async shrinkReport(
    tenantId: string,
    query: QueryShrinkReportDto,
  ): Promise<
    ShrinkReportBody & {
      window: ReportWindow;
      filters: { locationId: string | null };
      provenance: ReportProvenance;
    }
  > {
    await this.requireSourceModule(tenantId, 'returns');
    const window = this.window(query);
    const filter = {
      from: window.from,
      to: window.to,
      locationId: query.locationId,
    };
    const [groups, ledger, damaged] = await Promise.all([
      this.repository.shrinkGroups(tenantId, filter),
      this.repository.shrinkLedgerTotals(tenantId, filter),
      this.repository.damagedReturnGroups(tenantId, filter),
    ]);
    return {
      ...buildShrinkReport(groups, ledger, damaged),
      window: this.serialiseWindow(window),
      filters: { locationId: query.locationId ?? null },
      provenance: provenance([
        'ShrinkEvent',
        'InventoryMovement',
        'OrderReturnLine',
      ]),
    };
  }

  // -------------------------------------------------------------------------
  // CV accuracy
  // -------------------------------------------------------------------------

  async cvAccuracyReport(
    tenantId: string,
    query: QueryCvAccuracyReportDto,
    viewer: Viewer,
  ): Promise<
    CvAccuracyReportBody & {
      evaluationRunId: string;
      scope: {
        videoBackedObservationsIncluded: boolean;
        excluded: string;
      };
      provenance: ReportProvenance;
    }
  > {
    await this.requireSourceModule(tenantId, 'cv');
    if (!(await this.repository.evaluationRunExists(tenantId, query.evaluationRunId))) {
      throw new NotFoundException('No such evaluation run in this tenant');
    }
    // The SAME boundary the pilot observation route applies. A report over the
    // evaluation tables must not become the side door around it.
    const includeVideoObservations =
      viewer.permissions.includes('video-asset:read') &&
      (await this.platformModules.isEnabledForTenant(tenantId, 'video-ingest'));
    const groups = await this.repository.latestVerdictGroups(
      tenantId,
      query.evaluationRunId,
      { includeVideoObservations },
    );
    return {
      ...buildCvAccuracy(groups),
      evaluationRunId: query.evaluationRunId,
      scope: {
        videoBackedObservationsIncluded: includeVideoObservations,
        excluded:
          'REVIEW_REQUIRED true-negative observations (dataset evidence, not ' +
          'an accuracy judgment)' +
          (includeVideoObservations
            ? ''
            : '; video-backed observations, which need video-asset:read and ' +
              'the video-ingest module'),
      },
      provenance: provenance(['PilotEvaluationRun', 'PilotObservationReview']),
    };
  }

  // -------------------------------------------------------------------------
  // Shared
  // -------------------------------------------------------------------------

  /**
   * Reporting adds no reach. A report over another module's tables is
   * refused unless that module is enabled for the tenant, so turning
   * `reporting` on can never expose data the tenant has switched off.
   */
  private async requireSourceModule(
    tenantId: string,
    moduleCode: string,
  ): Promise<void> {
    if (!(await this.platformModules.isEnabledForTenant(tenantId, moduleCode))) {
      throw new ForbiddenException(
        `This report reads the ${moduleCode} module, which is not enabled for this tenant`,
      );
    }
  }

  private window(query: { from?: string; to?: string }) {
    const resolved = resolveWindow(query, DEFAULT_WINDOW_DAYS);
    if ('error' in resolved) {
      throw new BadRequestException(resolved.error);
    }
    return resolved;
  }

  private serialiseWindow(window: { from: Date; to: Date }): ReportWindow {
    return { from: window.from.toISOString(), to: window.to.toISOString() };
  }
}
