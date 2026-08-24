import { Controller, Get, Module, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  RequireModule,
  RequirePermissions,
  TenantOnly,
} from '../auth/decorators/access-policy.decorators';
import { CurrentTenantId } from '../auth/decorators/request-context.decorators';
import { PlatformModulesModule } from '../platform-modules/platform-modules.module';
import {
  OneSkuBootstrapReport,
  OneSkuBootstrapService,
} from './one-sku-bootstrap.service';

/**
 * One-SKU bootstrap — READ-ONLY guidance for proving out a single SKU
 * before scaling. All actions (reference upload, reindex, video upload,
 * ground truth, detection/fusion runs, corrections, dataset runs) go
 * through their existing endpoints; this module only aggregates their
 * results into one guided readiness report. Writes nothing (see
 * shadow-mode.spec.ts).
 */
@ApiTags('one-sku-bootstrap')
@ApiBearerAuth()
@TenantOnly()
@RequireModule('cv')
@Controller('one-sku-bootstrap')
export class OneSkuBootstrapController {
  constructor(private readonly bootstrap: OneSkuBootstrapService) {}

  @Get(':productId/report')
  @RequirePermissions('vision:read')
  @ApiOperation({
    summary:
      'One-SKU readiness report: reference/embedding counts, inventory ' +
      'on hand, ground-truthed test clips with latest shadow predictions ' +
      'and crop-quality warnings, reviewed-example counts, common failure ' +
      'reasons, and the dataset-improvement gate checklist (guidance ' +
      'only — never blocks any workflow)',
  })
  report(
    @CurrentTenantId() tenantId: string,
    @Param('productId') productId: string,
  ): Promise<OneSkuBootstrapReport> {
    return this.bootstrap.report(tenantId, productId);
  }
}

@Module({
  imports: [PlatformModulesModule],
  controllers: [OneSkuBootstrapController],
  providers: [OneSkuBootstrapService],
})
export class OneSkuBootstrapModule {}
