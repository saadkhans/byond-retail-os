import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiConsumes,
  ApiCreatedResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
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
  TestMediaGateGuard,
  UPLOAD_ATTESTATION_HEADERS,
} from './test-media-gate.guard';
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
  // ORDERING IS THE POINT, and it is a Nest LIFECYCLE fact, not a
  // decorator-order one: guards run BEFORE interceptors
  // (RouterExecutionContext awaits `fnCanActivate` and only then calls
  // `interceptorsConsumer.intercept`, which is what runs FileInterceptor /
  // multer). So the policy, tooling, and attestation gates below execute
  // while the multipart body is still unread — no byte of a refused upload
  // is ever buffered into process memory. The permission guard above
  // already relied on the same ordering; the multer memory limit remains
  // configured exactly as before, now as a backstop rather than the first
  // gate. Pinned by test-media-gate.guard.spec.ts.
  @UseGuards(TestMediaGateGuard)
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiHeader({
    name: 'x-controlled-test-media',
    required: true,
    description:
      'Operator DECLARATION (literal "true") that this clip is controlled ' +
      'internal test media. Read BEFORE the body is buffered; the ' +
      'matching multipart field remains the audited record.',
  })
  @ApiHeader({
    name: 'x-no-payment-cards-visible',
    required: true,
    description:
      'Operator DECLARATION (literal "true") that no payment card is ' +
      'visible in the clip. Nothing inspects the frames to confirm it.',
  })
  @ApiHeader({
    name: 'x-no-customer-pii',
    required: true,
    description:
      'Operator DECLARATION (literal "true") that the clip carries no ' +
      'customer personal data. Nothing inspects the frames to confirm it.',
  })
  @ApiHeader({
    name: 'x-attest-no-sensitive-content',
    required: true,
    description:
      'Operator DECLARATION (literal "true") that the frames carry no ' +
      'payment-card or credential content. Nothing inspects the frames to ' +
      'confirm it.',
  })
  @ApiOperation({
    summary: 'Upload a controlled test video',
    description:
      'Multipart upload (`file` part) with optional store/unit/device/' +
      'session binding. Allowlisted container types only (extension + MIME ' +
      '+ magic bytes), conservative size limit, filename traversal ' +
      'rejection, SHA-256 checksum. Bytes land in LOCAL/DEV storage behind ' +
      'a server-generated internal key — no public URLs, no client-supplied ' +
      'paths, no media in the database. **Uploads are DISABLED by ' +
      'default.** Phase 10 ingests CONTROLLED INTERNAL TEST MEDIA ONLY, ' +
      'under an explicit policy gate: `VIDEO_TEST_MEDIA_INGEST_ENABLED=' +
      'true` with `NODE_ENV` explicitly development or test (refused at ' +
      'startup anywhere else), plus the four REQUIRED operator ' +
      'attestations `controlledTestMedia`, `noPaymentCardsVisible`, ' +
      '`noCustomerPII`, and `attestNoSensitiveContent` (each the literal ' +
      '"true"; any missing/other value is a controlled 400 before any row ' +
      'or byte). Those gates are enforced by a route GUARD, which Nest ' +
      'runs BEFORE the multipart interceptor, so a refused upload is ' +
      'refused with its body still unread — nothing is buffered into ' +
      'memory. Because multipart fields do not exist before parsing, the ' +
      'attestations must ALSO be sent as request headers (' +
      UPLOAD_ATTESTATION_HEADERS.map(({ header }) => `\`${header}\``).join(
        ', ',
      ) +
      ', each "true" after trimming/lowercasing): the HEADERS are the ' +
      'pre-buffer gate, the multipart FIELDS stay required as the audited ' +
      'record the service persists and re-checks. That gate — not any ' +
      'screening result — is what ' +
      'authorizes storing a clip; without it the endpoint is a controlled ' +
      '503. The asset is then staged PENDING_MEDIA and its frames are ' +
      'text/OCR-SCREENED BEFORE any byte reaches durable storage. That ' +
      'screen is a REJECTION LAYER, not a safety verdict: a frame in ' +
      'which payment/credential text is DETECTED is a controlled 400 with ' +
      'code PRESTORE_SCREENING_REJECTED, but a screen that detects ' +
      'nothing proves nothing — recognizers miss rotated, blurred, ' +
      'stylized, occluded and low-quality digits — so it never authorizes ' +
      'anything on its own. The whole screen runs under one aggregate ' +
      'wall-clock budget (`VIDEO_SCREENING_TIMEOUT_MS`, default 30 s, ' +
      'covering decode AND recognition); an expired budget is the same ' +
      'fail-closed audited rejection, and when the screening toolchain ' +
      'cannot run at all (VIDEO_FFMPEG_ENABLED / VIDEO_OCR_ENABLED) the ' +
      'upload is refused 503 before any row or byte is accepted. Only ' +
      'once nothing was detected and the media write succeeded is the ' +
      'asset published QUARANTINED — not processable until an audited ' +
      'screening decision approves it.',
  })
  @ApiCreatedResponse({
    description: 'Asset created (QUARANTINED pending screening)',
  })
  @ApiBadRequestResponse({
    description:
      'A required attestation header is missing or is not "true" — ' +
      'refused before the upload body is read',
  })
  @ApiServiceUnavailableResponse({
    description:
      'The controlled test-media policy gate is closed, or the screening ' +
      'toolchain cannot run — refused before the upload body is read',
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

  @Get(':id/media')
  @RequirePermissions('video-asset:screen')
  @ApiOperation({
    summary: 'Serve the stored media bytes for the in-app review player',
    description:
      'DELIBERATE Phase 10 policy change for the pickup-detection MVP: ' +
      'reviewing an automatic detection requires watching the clip, so the ' +
      'bytes are served to `video-asset:screen` holders — the permission ' +
      'that already authorizes viewing footage during quarantine ' +
      'screening. Media is served ONLY for explicitly released statuses ' +
      '(UPLOADED/VALIDATED/PROCESSING/READY — an allowlist, so REJECTED ' +
      'clips are 404s even if their cleanup delete is still retrying), it ' +
      'is STREAMED (single-range `Range` requests answered 206, so a ' +
      'request never buffers the whole clip in memory), and no storage ' +
      'key, path, or URL appears anywhere in the response.',
  })
  @ApiNotFoundResponse({ description: 'Asset or media not found' })
  async serveMedia(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Headers('range') range: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    const media = await this.assetsService.getMediaStream(tenantId, id, range);
    response
      .setHeader('Content-Type', media.mimeType)
      .setHeader('Cache-Control', 'private, max-age=60')
      .setHeader('Accept-Ranges', 'bytes');
    if (media.range === null) {
      response
        .status(200)
        .setHeader('Content-Length', String(media.totalSizeBytes));
    } else {
      const { start, end } = media.range;
      response
        .status(206)
        .setHeader(
          'Content-Range',
          `bytes ${start}-${end}/${media.totalSizeBytes}`,
        )
        .setHeader('Content-Length', String(end - start + 1));
    }
    // A storage failure after the headers are committed can no longer
    // become a JSON error body — tear the connection down instead of
    // leaving the player hanging on a stalled response.
    media.stream.once('error', () => response.destroy());
    media.stream.pipe(response);
  }

  @Get(':id/artifacts/:artifactId/image')
  @RequirePermissions('video-asset:read')
  @ApiOperation({
    summary: 'Serve one FRAME/CROP artifact image (detection thumbnails)',
  })
  @ApiNotFoundResponse({ description: 'Artifact not found in this tenant' })
  async serveArtifactImage(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Param('artifactId') artifactId: string,
    @Res() response: Response,
  ): Promise<void> {
    const image = await this.assetsService.getArtifactImageBytes(
      tenantId,
      id,
      artifactId,
    );
    response
      .status(200)
      .setHeader('Content-Type', image.mimeType)
      .setHeader('Cache-Control', 'private, max-age=3600')
      .send(image.data);
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
      'audited actions). REQUIRES a byte-reading extractor ' +
      '(VIDEO_FFMPEG_ENABLED=true): under the default simulated extractor ' +
      'this route is a controlled 503 — placeholder frames would let a ' +
      'screener approve footage without ever seeing it, so informed ' +
      'screening (and any APPROVE) needs the real extractor; REJECT never ' +
      'required a preview. Decoded preview bytes are capped per response ' +
      '(16 MiB before base64), with over-budget frames skipped and ' +
      'reported. Extractor unavailable or infrastructure trouble ' +
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
      'Decisions on non-QUARANTINED assets are controlled 409s. APPROVE ' +
      'additionally REQUIRES recorded inspection evidence: a screening ' +
      'preview that actually served frames within the last 30 minutes ' +
      '(server-stamped by the audited preview itself) — approving without ' +
      'a fresh real-media inspection is a controlled 409. REJECT never ' +
      'requires a preview.',
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
      'response. Marks the asset READY. `idempotencyKey` is REQUIRED ' +
      '(controlled 400 without it, before anything is read, extracted, or ' +
      'staged): it is the identity this operation\'s artifact files are ' +
      'staged under, so a keyless request would let a later identical one ' +
      'rewrite the bytes an already-committed append-only artifact row ' +
      'recorded a checksum for. Retrying with the SAME key and identical ' +
      'parameters REPLAYS the recorded artifacts; the same key with ' +
      'changed parameters is a controlled 409.',
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
      'no free text. `idempotencyKey` is REQUIRED here for the same reason ' +
      'as on extract-frames (a keyless request would let a later identical ' +
      'one rewrite a committed artifact\'s file); a same-key retry with ' +
      'identical parameters replays the recorded artifact, and with changed ' +
      'parameters is a controlled 409.',
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
