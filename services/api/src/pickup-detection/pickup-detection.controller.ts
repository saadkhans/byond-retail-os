import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
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
import { UpsertGroundTruthDto } from './dto/upsert-ground-truth.dto';
import {
  PickupDetectionService,
  PickupDetectionState,
} from './pickup-detection.service';
import {
  GroundTruthView,
  PickupValidationService,
  ValidationSummary,
} from './pickup-validation.service';

/**
 * Read/trigger surface for the Phase 10 pickup-detection MVP. Lives under
 * the video-ingest module gate (detection is a property OF an uploaded
 * test video) with the same read/process permission split as the asset
 * endpoints it complements.
 */
@ApiTags('video-ingest')
@ApiBearerAuth()
@TenantOnly()
@RequireModule('video-ingest')
@Controller('video-assets')
export class PickupDetectionController {
  constructor(
    private readonly detection: PickupDetectionService,
    private readonly validation: PickupValidationService,
  ) {}

  @Get(':id/pickup-detection')
  @RequirePermissions('video-asset:read')
  @ApiOperation({
    summary:
      'Pickup-detection state for one asset: latest job, result, and the ' +
      'PRODUCT_PICKUP vision event detail (or null when never attempted).',
  })
  getState(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
  ): Promise<PickupDetectionState> {
    return this.detection.getState(tenantId, id);
  }

  @Post(':id/pickup-detection/run')
  @RequirePermissions('video-asset:process')
  @ApiOperation({
    summary:
      'Run (or re-run after a failure) pickup detection for a VALIDATED ' +
      'asset. Idempotent: an in-flight attempt is returned, a SUCCEEDED ' +
      'attempt is never silently repeated.',
  })
  run(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
  ): Promise<PickupDetectionState> {
    return this.detection.detectForAsset(tenantId, id, { force: true });
  }

  @Get(':id/ground-truth')
  @RequirePermissions('video-asset:read')
  @ApiOperation({
    summary: 'Operator-entered ground truth for this test video (or null)',
  })
  groundTruth(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
  ): Promise<GroundTruthView | null> {
    return this.validation.groundTruth(tenantId, id);
  }

  @Put(':id/ground-truth')
  @RequirePermissions('video-asset:process')
  @ApiOperation({
    summary:
      'Record what ACTUALLY happens in this test video (upsert): actual ' +
      'product, actual pickup instant, pickup/return/none, quantity. The ' +
      'validation dashboard scores detections against this.',
  })
  upsertGroundTruth(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Body() dto: UpsertGroundTruthDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<GroundTruthView> {
    return this.validation.upsertGroundTruth(
      tenantId,
      id,
      {
        eventKind: dto.eventKind,
        productId: dto.productId ?? null,
        actualTimestampMs: dto.actualTimestampMs ?? null,
        quantity: dto.quantity,
        note: dto.note ?? null,
      },
      actor.userId,
    );
  }
}

/** Validation dashboard read surface. */
@ApiTags('video-ingest')
@ApiBearerAuth()
@TenantOnly()
@RequireModule('video-ingest')
@Controller('pickup-validation')
export class PickupValidationController {
  constructor(private readonly validation: PickupValidationService) {}

  @Get('summary')
  @RequirePermissions('video-asset:read')
  @ApiOperation({
    summary:
      'Validation results over every reviewed test video: actual vs ' +
      'predicted, match score, timestamp error, outcomes, FP/FN totals, ' +
      'and the per-SKU confusion matrix (unlocked at 50 reviewed videos).',
  })
  summary(@CurrentTenantId() tenantId: string): Promise<ValidationSummary> {
    return this.validation.summary(tenantId);
  }
}
