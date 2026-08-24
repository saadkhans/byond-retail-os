import { Body, Controller, Get, Module, Param, Post } from '@nestjs/common';
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
import { JourneyModule } from '../journey/journey.module';
import { PilotEvaluationModule } from '../pilot-evaluation/pilot-evaluation.module';
import { PlatformModulesModule } from '../platform-modules/platform-modules.module';
import { BootstrapReviewDto } from './one-sku-bootstrap.dto';
import {
  OneSkuBootstrapReport,
  OneSkuBootstrapService,
} from './one-sku-bootstrap.service';

/**
 * One-SKU bootstrap — guidance for proving out a single SKU before
 * scaling. The report is READ-ONLY; the two mutating routes delegate to
 * the existing Phase 15/journey shadow services (append-only reviews and
 * shadow journey events — the Phase 18 candidate source) and NEVER go
 * near the basket-affecting vision-event review path. No raw Prisma
 * write exists in this module (see shadow-mode.spec.ts).
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
      'and crop-quality warnings, reviewed-example counts, the linked ' +
      'bootstrap evaluation run (the Phase 18 candidate source), common ' +
      'failure reasons, and the dataset-improvement gate checklist ' +
      '(guidance only — never blocks any workflow)',
  })
  report(
    @CurrentTenantId() tenantId: string,
    @Param('productId') productId: string,
  ): Promise<OneSkuBootstrapReport> {
    return this.bootstrap.report(tenantId, productId);
  }

  @Post(':productId/evaluation-run')
  @RequirePermissions('vision:review')
  @ApiOperation({
    summary:
      'Find-or-create the per-SKU bootstrap PilotEvaluationRun — the ' +
      'Phase 15 container whose reviews Phase 18 dataset improvement ' +
      'refreshes candidates from. Idempotent by deterministic run name.',
  })
  ensureEvaluationRun(
    @CurrentTenantId() tenantId: string,
    @Param('productId') productId: string,
    @CurrentUser() actor: RequestContext,
  ) {
    return this.bootstrap.ensureEvaluationRun(
      tenantId,
      productId,
      actor.userId,
    );
  }

  @Post(':productId/videos/:videoAssetId/review')
  @RequirePermissions('vision:review')
  @ApiOperation({
    summary:
      'Record ONE bootstrap correction as Phase 18-compatible evidence: ' +
      'imports the clip’s latest fusion run as a shadow journey event ' +
      'and appends a pilot review against it. Session-bound clips are ' +
      'refused — this path can never mutate a checkout basket.',
  })
  reviewClip(
    @CurrentTenantId() tenantId: string,
    @Param('productId') productId: string,
    @Param('videoAssetId') videoAssetId: string,
    @Body() body: BootstrapReviewDto,
    @CurrentUser() actor: RequestContext,
  ) {
    return this.bootstrap.reviewClip(
      tenantId,
      productId,
      videoAssetId,
      {
        verdict: body.verdict,
        expectedAction: body.expectedAction,
        expectedProductId: body.expectedProductId ?? null,
        notes: body.notes ?? null,
      },
      actor.userId,
    );
  }
}

@Module({
  imports: [PlatformModulesModule, PilotEvaluationModule, JourneyModule],
  controllers: [OneSkuBootstrapController],
  providers: [OneSkuBootstrapService],
})
export class OneSkuBootstrapModule {}
