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
import { UploadVideoAssetDto } from './dto/upload-video-asset.dto';
import {
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
      'paths, no media in the database.',
  })
  @ApiCreatedResponse({ description: 'Asset created (UPLOADED)' })
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
  @ApiOperation({ summary: 'Get a video asset (metadata only — never bytes)' })
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
  ): Promise<{ asset: VideoAssetView; artifacts: VideoArtifactView[] }> {
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
  ): Promise<{ asset: VideoAssetView; artifact: VideoArtifactView }> {
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
