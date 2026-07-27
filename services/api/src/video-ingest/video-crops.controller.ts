import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
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
import { InferenceJobDetail } from '../inference/inference-jobs.repository';
import { CreateInferenceJobFromCropDto } from './dto/create-inference-job-from-crop.dto';
import { VideoAssetsService } from './video-assets.service';
import { VideoArtifactView } from './video-assets.repository';

@ApiTags('video-ingest')
@ApiBearerAuth()
@TenantOnly()
@RequireModule('video-ingest')
@Controller('video-crops')
export class VideoCropsController {
  constructor(private readonly assetsService: VideoAssetsService) {}

  @Get(':id')
  @RequirePermissions('video-asset:read')
  @ApiOperation({
    summary: 'Get a frame/crop artifact (internal reference only)',
  })
  @ApiNotFoundResponse({ description: 'Not found in this tenant' })
  findById(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
  ): Promise<VideoArtifactView> {
    return this.assetsService.findArtifactById(tenantId, id);
  }

  @Post(':id/inference-job')
  @RequirePermissions('video-asset:process')
  @ApiOperation({
    summary: 'Create a Phase 9 inference job from a CROP artifact',
    description:
      'Builds a SAFE input descriptor (artifact/asset ids, timestamp, crop ' +
      'box — opaque references only; the Phase 9 media policy screens it ' +
      'again) and enqueues through the EXISTING inference contract. ' +
      'One-shot: the crop links to its job once; retries replay the linked ' +
      'job. Requires the inference module enabled.',
  })
  @ApiCreatedResponse({ description: 'Job queued (or replayed)' })
  @ApiNotFoundResponse({ description: 'Artifact not found in this tenant' })
  @ApiConflictResponse({ description: 'Artifact is not a CROP / asset deleted' })
  @ApiForbiddenResponse({ description: 'Inference module not enabled' })
  createInferenceJob(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Body() dto: CreateInferenceJobFromCropDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<{
    artifact: VideoArtifactView;
    job: InferenceJobDetail;
    replayed: boolean;
  }> {
    return this.assetsService.createInferenceJobFromCrop(tenantId, id, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }
}
