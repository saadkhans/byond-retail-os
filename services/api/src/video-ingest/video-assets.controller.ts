import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiConsumes,
  ApiCreatedResponse,
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
import { CreateVideoCropDto } from './dto/create-video-crop.dto';
import { ExtractFramesDto } from './dto/extract-frames.dto';
import { QueryVideoAssetsDto } from './dto/query-video-assets.dto';
import { ScreenVideoAssetDto } from './dto/screen-video-asset.dto';
import { UploadVideoAssetDto } from './dto/upload-video-asset.dto';
import {
  ScreeningPreviewResult,
  UploadedVideoFile,
  VideoAssetsService,
} from './video-assets.service';
import {
  VideoArtifactView,
  VideoAssetView,
} from './video-assets.repository';

@ApiTags('video-ingest')
@ApiBearerAuth()
@TenantOnly()
@RequireModule('video-ingest')
@Controller('video-assets')
export class VideoAssetsController {
  constructor(private readonly assetsService: VideoAssetsService) {}

  @Post()
  @RequirePermissions('video-asset:manage')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Upload a controlled test video',
    description:
      'Multipart upload (`file` part) with optional store/unit/device/' +
      'session binding. Allowlisted container types only (extension + MIME ' +
      '+ magic bytes), conservative size limit, filename traversal ' +
      'rejection, SHA-256 checksum. Bytes land in LOCAL/DEV storage behind ' +
      'a server-generated internal key — no public URLs, no client-supplied ' +
      'paths, no media in the database. The asset lands QUARANTINED and is ' +
      'not processable until an audited screening decision approves it.',
  })
  @ApiCreatedResponse({
    description: 'Asset created (QUARANTINED pending screening)',
  })
  upload(
    @CurrentTenantId() tenantId: string,
    @UploadedFile() file: UploadedVideoFile | undefined,
    @Body() dto: UploadVideoAssetDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<VideoAssetView> {
    return this.assetsService.upload(tenantId, file, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }

  @Get()
  @RequirePermissions('video-asset:read')
  @ApiOperation({
    summary: 'List video assets in the caller’s tenant',
    description:
      'Filters: status, session, store. Deterministic ordering (newest ' +
      'first, id tie-breaker), paginated via skip/take. Deleted assets are ' +
      'never listed.',
  })
  list(
    @CurrentTenantId() tenantId: string,
    @Query() query: QueryVideoAssetsDto,
  ): Promise<{
    items: VideoAssetView[];
    total: number;
    skip: number;
    take: number;
  }> {
    return this.assetsService.list(tenantId, query);
  }

  @Get(':id')
  @RequirePermissions('video-asset:read')
  @ApiOperation({
    summary: 'Get a video asset (metadata only — no bytes on this route)',
    description:
      'Metadata only. Media bytes are never served by this module EXCEPT ' +
      'through the audited quarantine screening preview (frames only, ' +
      'never the video container or original bytes — the video file itself ' +
      'is never downloadable).',
  })
  @ApiNotFoundResponse({ description: 'Not found in this tenant' })
  findById(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
  ): Promise<VideoAssetView> {
    return this.assetsService.findById(tenantId, id);
  }

  @Get(':id/artifacts')
  @RequirePermissions('video-asset:read')
  @ApiOperation({
    summary: 'List frame/crop artifacts extracted from this asset',
  })
  @ApiNotFoundResponse({ description: 'Asset not found in this tenant' })
  listArtifacts(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
  ): Promise<VideoArtifactView[]> {
    return this.assetsService.listArtifacts(tenantId, id);
  }

  @Post(':id/screening-preview')
  @RequirePermissions('video-asset:screen')
  @ApiOperation({
    summary:
      'Serve in-memory sample frames of a QUARANTINED upload for screening',
    description:
      'The audited inspection path behind the screening decision — and the ' +
      'module’s ONE deliberate exception to "bytes are never served": ' +
      'up to 6 sample frames, evenly spaced across the probed duration, ' +
      'extracted IN MEMORY and returned base64-encoded with timestamps. ' +
      'Frames are NEVER persisted (no artifact rows, no storage writes) ' +
      'and the video container / original bytes are never downloadable. ' +
      'Only while the asset is QUARANTINED (409 otherwise). POST, not GET: ' +
      'every served preview writes an audit entry (module idiom for ' +
      'audited actions). Extractor unavailable or infrastructure trouble ' +
      'is a retryable 503; unreadable content is a controlled 400 with NO ' +
      'status transition — the screening decision stays open.',
  })
  @ApiCreatedResponse({
    description: 'Sample frames returned (base64, in-memory only)',
  })
  @ApiNotFoundResponse({ description: 'Asset not found in this tenant' })
  @ApiConflictResponse({ description: 'Asset is not QUARANTINED' })
  screeningPreview(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @CurrentUser() actor: RequestContext,
  ): Promise<ScreeningPreviewResult> {
    return this.assetsService.screeningPreview(tenantId, id, {
      id: actor.userId,
      email: actor.email,
    });
  }

  @Post(':id/screening')
  @RequirePermissions('video-asset:screen')
  @ApiOperation({
    summary: 'Record the audited frame-content screening decision',
    description:
      'QUARANTINED → UPLOADED (APPROVE: released for processing) or ' +
      'QUARANTINED → REJECTED (REJECT: stored media removed, metadata row ' +
      'kept as evidence). The upload attestation is defense-in-depth only — ' +
      'this audited decision is the enforced control before ANY processing. ' +
      'Decisions on non-QUARANTINED assets are controlled 409s.',
  })
  @ApiCreatedResponse({ description: 'Screening decision recorded' })
  @ApiNotFoundResponse({ description: 'Asset not found in this tenant' })
  @ApiConflictResponse({ description: 'Asset is not QUARANTINED' })
  screen(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Body() dto: ScreenVideoAssetDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<VideoAssetView> {
    return this.assetsService.screen(tenantId, id, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }

  @Post(':id/validate')
  @RequirePermissions('video-asset:process')
  @ApiOperation({
    summary: 'Probe the video and record its real metadata',
    description:
      'UPLOADED → VALIDATED (duration/dimensions/fps recorded) or REJECTED ' +
      'with a stable error code when the container is unreadable. ' +
      'Idempotent for already-validated assets.',
  })
  @ApiCreatedResponse({ description: 'Asset validated (or rejected)' })
  @ApiNotFoundResponse({ description: 'Asset not found in this tenant' })
  @ApiConflictResponse({ description: 'Asset status does not allow validation' })
  validate(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @CurrentUser() actor: RequestContext,
  ): Promise<VideoAssetView> {
    return this.assetsService.validate(tenantId, id, {
      id: actor.userId,
      email: actor.email,
    });
  }

  @Post(':id/extract-frames')
  @RequirePermissions('video-asset:process')
  @ApiOperation({
    summary: 'Extract FRAME artifacts (single timestamp or bounded sampling)',
    description:
      'Requires a VALIDATED asset. Artifacts are INTERNAL references ' +
      '(metadata + checksum) — no bytes, keys, paths, or URLs in the ' +
      'response. Marks the asset READY.',
  })
  @ApiCreatedResponse({ description: 'Frames extracted; artifacts returned' })
  @ApiNotFoundResponse({ description: 'Asset not found in this tenant' })
  @ApiConflictResponse({ description: 'Asset is not validated / extraction failed' })
  extractFrames(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Body() dto: ExtractFramesDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<{
    asset: VideoAssetView;
    artifacts: VideoArtifactView[];
    replayed: boolean;
  }> {
    return this.assetsService.extractFrames(tenantId, id, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }

  @Post(':id/crops')
  @RequirePermissions('video-asset:process')
  @ApiOperation({
    summary: 'Extract one CROP artifact from a manual crop box',
    description:
      'Timestamp must be inside the probed duration and the box inside the ' +
      'probed dimensions (controlled 400s). Reason is a closed vocabulary — ' +
      'no free text.',
  })
  @ApiCreatedResponse({ description: 'Crop extracted; artifact returned' })
  @ApiNotFoundResponse({ description: 'Asset not found in this tenant' })
  @ApiConflictResponse({ description: 'Asset is not validated / extraction failed' })
  createCrop(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Body() dto: CreateVideoCropDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<{
    asset: VideoAssetView;
    artifact: VideoArtifactView;
    replayed: boolean;
  }> {
    return this.assetsService.createCrop(tenantId, id, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }

  @Delete(':id')
  @RequirePermissions('video-asset:delete')
  @ApiOperation({
    summary: 'Delete a video asset',
    description:
      'Removes the LOCAL media files (original + extracted artifacts) and ' +
      'soft-deletes the metadata row (kept for audit lineage; artifacts are ' +
      'append-only). Deleted assets 404 on every read.',
  })
  @ApiNotFoundResponse({ description: 'Asset not found in this tenant' })
  delete(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @CurrentUser() actor: RequestContext,
  ): Promise<{ deleted: true }> {
    return this.assetsService.delete(tenantId, id, {
      id: actor.userId,
      email: actor.email,
    });
  }
}
