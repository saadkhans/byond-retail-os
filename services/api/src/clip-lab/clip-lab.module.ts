import { Controller, Get, Module, Param, Post } from '@nestjs/common';
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
import { PickupDetectionModule } from '../pickup-detection/pickup-detection.module';
import { PickupFusionModule } from '../pickup-fusion/pickup-fusion.module';
import { PlatformModulesModule } from '../platform-modules/platform-modules.module';
import { PretrainedVisionModule } from '../pretrained-vision/pretrained-vision.module';
import { VideoIngestModule } from '../video-ingest/video-ingest.module';
import { ClipLabService } from './clip-lab.service';
import { ClipLabReport } from './clip-lab.types';

/**
 * Phase 22 — Clip Lab: one-click analysis of a test clip. Shadow-only:
 * the run orchestrates the existing stages (validate, v1 detection,
 * fusion v2, pretrained evaluation) with the planogram binding stored on
 * the asset and returns ONE consolidated, review-required report. The
 * video-asset read boundary (video-ingest module + video-asset:read) is
 * enforced in the service on top of the cv module and vision
 * permissions here. Screening approval stays a separate, audited human
 * decision.
 */
@ApiTags('clip-lab')
@ApiBearerAuth()
@TenantOnly()
@RequireModule('cv')
@Controller('video-assets')
export class ClipLabController {
  constructor(private readonly lab: ClipLabService) {}

  @Post(':id/lab-run')
  @RequirePermissions('vision:review')
  @ApiOperation({
    summary:
      'Run the full shadow analysis for one clip (validate → detection → ' +
      'fusion v2 → pretrained evaluation) using the planogram binding ' +
      'stored on the asset, and return one consolidated report.',
  })
  run(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @CurrentUser() actor: RequestContext,
  ): Promise<ClipLabReport> {
    return this.lab.run(
      tenantId,
      id,
      { id: actor.userId, email: actor.email },
      { hasVideoAssetReadPermission: actor.permissions.includes('video-asset:read') },
    );
  }

  @Get(':id/lab-report')
  @RequirePermissions('vision:read')
  @ApiOperation({ summary: 'The consolidated Clip Lab report from stored results — read-only.' })
  report(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @CurrentUser() actor: RequestContext,
  ): Promise<ClipLabReport> {
    return this.lab.report(tenantId, id, {
      hasVideoAssetReadPermission: actor.permissions.includes('video-asset:read'),
    });
  }
}

@Module({
  imports: [
    VideoIngestModule,
    PickupDetectionModule,
    PickupFusionModule,
    PretrainedVisionModule,
    PlatformModulesModule,
  ],
  controllers: [ClipLabController],
  providers: [ClipLabService],
})
export class ClipLabModule {}
