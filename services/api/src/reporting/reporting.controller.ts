import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  RequireModule,
  RequirePermissions,
  TenantOnly,
} from '../auth/decorators/access-policy.decorators';
import {
  CurrentTenantId,
  CurrentUser,
} from '../auth/decorators/request-context.decorators';
import { RequestContext } from '../auth/request-context';
import {
  REPORT_READ_PERMISSION,
  REPORTING_MODULE_CODE,
} from './reporting.constants';
import {
  QueryBalancesReportDto,
  QueryCvAccuracyReportDto,
  QueryInventoryReportDto,
  QuerySalesReportDto,
  QueryShrinkReportDto,
} from './reporting.dto';
import { ReportingService } from './reporting.service';

/**
 * Phase 30 — the read-only reporting surface.
 *
 * Every route is a GET. There is no POST, PUT, PATCH or DELETE in this
 * controller and there never should be: reporting derives numbers from the
 * ledger and the evaluation tables, and writing anything from here would make
 * it a second source of truth.
 *
 * Every route demands `report:read` AND the permission that already guards
 * the rows it sums (`order:read`, `inventory:read`, `cycle-count:read`,
 * `shrink:read`, `vision:read`). @RequirePermissions is AND semantics, so a
 * report can never show a caller something they were not already allowed to
 * read one row at a time.
 */
@ApiTags('reporting')
@ApiBearerAuth()
@TenantOnly()
@RequireModule(REPORTING_MODULE_CODE)
@Controller('reports')
export class ReportingController {
  constructor(private readonly reporting: ReportingService) {}

  @Get('sales')
  @RequirePermissions(REPORT_READ_PERMISSION, 'order:read')
  @ApiOperation({
    summary: 'Sales over the order lines, by currency, product, price version and promotion',
    description:
      'Derived on read from CONFIRMED orders in the window. Gross is what ' +
      'the price versions said, discount is what the promotion versions took ' +
      'off, and net is what was charged — with an independent ungrouped SUM ' +
      'as a cross-check. Nothing is cached.',
  })
  sales(
    @CurrentTenantId() tenantId: string,
    @Query() query: QuerySalesReportDto,
  ) {
    return this.reporting.salesReport(tenantId, query);
  }

  @Get('sales/orders/:orderId')
  @RequirePermissions(REPORT_READ_PERMISSION, 'order:read')
  @ApiOperation({
    summary: 'Explain one sale: the price version and promotion behind every line',
    description:
      'Names the price-book version that set each base price and the ' +
      'promotion version that discounted it, and checks that ' +
      'base − discount = unit price and unit price × quantity = line total.',
  })
  explainOrder(
    @CurrentTenantId() tenantId: string,
    @Param('orderId') orderId: string,
  ) {
    return this.reporting.explainOrder(tenantId, orderId);
  }

  @Get('inventory/movements')
  @RequirePermissions(REPORT_READ_PERMISSION, 'inventory:read')
  @ApiOperation({
    summary: 'Signed net stock change per movement type over the window',
    description:
      'Summed by the database over the append-only ledger. The totals replay ' +
      'to exactly the change in on-hand stock across the window.',
  })
  movements(
    @CurrentTenantId() tenantId: string,
    @Query() query: QueryInventoryReportDto,
  ) {
    return this.reporting.movementReport(tenantId, query);
  }

  @Get('inventory/balances')
  @RequirePermissions(REPORT_READ_PERMISSION, 'inventory:read')
  @ApiOperation({
    summary: 'Balances derived from the ledger, with the projection beside them',
    description:
      'The balance is SUM(quantityDelta) over the movements. The ' +
      'InventoryLevel projection is shown next to it as a cross-check; a ' +
      'disagreement is reported as a platform defect, never as stock.',
  })
  balances(
    @CurrentTenantId() tenantId: string,
    @Query() query: QueryBalancesReportDto,
  ) {
    return this.reporting.balanceReport(tenantId, query);
  }

  @Get('inventory/count-reconciliation')
  @RequirePermissions(REPORT_READ_PERMISSION, 'cycle-count:read')
  @ApiOperation({
    summary: 'Cycle-count variance and projection drift, reported separately',
    description:
      'Variance (counted − projected) is a stock discrepancy an operator ' +
      'found. Drift (projected − ledger) must be zero and is a PLATFORM ' +
      'DEFECT. The two are never added together.',
  })
  countReconciliation(
    @CurrentTenantId() tenantId: string,
    @Query() query: QueryInventoryReportDto,
  ) {
    return this.reporting.countReconciliationReport(tenantId, query);
  }

  @Get('shrink')
  @RequirePermissions(REPORT_READ_PERMISSION, 'shrink:read')
  @ApiOperation({
    summary: 'Recorded shrink, reconciled against the SHRINK ledger movements',
    description:
      'Damaged returns are counted separately and never added in: a damaged ' +
      'return deliberately writes no ledger movement, so it is not shrink.',
  })
  shrink(
    @CurrentTenantId() tenantId: string,
    @Query() query: QueryShrinkReportDto,
  ) {
    return this.reporting.shrinkReport(tenantId, query);
  }

  @Get('cv-accuracy')
  @RequirePermissions(REPORT_READ_PERMISSION, 'vision:read')
  @ApiOperation({
    summary: 'Accuracy and confusion over the latest operator verdict per observation',
    description:
      'Counts of verdicts, actions and catalog SKUs only — no evidence ' +
      'bundle, vision event, media key, storage path or reviewer note is ' +
      'ever projected. Video-backed observations need video-asset:read and ' +
      'the video-ingest module, exactly as the pilot observation route does.',
  })
  cvAccuracy(
    @CurrentTenantId() tenantId: string,
    @Query() query: QueryCvAccuracyReportDto,
    @CurrentUser() actor: RequestContext,
  ) {
    return this.reporting.cvAccuracyReport(tenantId, query, {
      permissions: actor.permissions,
    });
  }
}
