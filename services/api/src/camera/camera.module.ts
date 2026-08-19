import {
  Body,
  Controller,
  Delete,
  Get,
  Module,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
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
import { PickupDetectionModule } from '../pickup-detection/pickup-detection.module';
import { PickupFusionModule } from '../pickup-fusion/pickup-fusion.module';
import { PlatformModulesModule } from '../platform-modules/platform-modules.module';
import { VideoIngestModule } from '../video-ingest/video-ingest.module';
import { CameraCalibrationService } from './camera-calibration.service';
import { CameraReplayService } from './camera-replay.service';
import { CameraSourcesService } from './camera-sources.service';
import {
  CreateCalibrationProfileDto,
  CreateCalibrationZoneDto,
  UpdateCalibrationProfileDto,
  UpdateCalibrationZoneDto,
} from './dto/camera-calibration.dto';
import { CreateCameraSourceDto } from './dto/create-camera-source.dto';
import { PilotTestDto } from './dto/pilot-test.dto';
import { ReplayRunDto } from './dto/replay-run.dto';
import { StartLiveSessionDto } from './dto/start-live-session.dto';
import { UpdateCameraSourceDto } from './dto/update-camera-source.dto';
import { LiveSessionService } from './live-session.service';
import { RtspFrameSampler } from './rtsp/rtsp-frame-sampler';

/**
 * Phase 12 — camera source registry + FILE_REPLAY pilot runtime, SHADOW
 * ONLY. Sources carry no secrets (credentialRef is a slot NAME and every
 * response redacts it to hasCredentialRef); the replay run drives the
 * EXISTING pickup/fusion/journey pipeline and records an auditable
 * CameraPilotRun row. No route here touches checkout, orders, payments,
 * or inventory.
 */
@ApiTags('camera')
@ApiBearerAuth()
@TenantOnly()
@RequireModule('cv')
@Controller('camera-sources')
export class CameraSourcesController {
  constructor(
    private readonly sources: CameraSourcesService,
    private readonly replay: CameraReplayService,
    private readonly live: LiveSessionService,
    private readonly calibration: CameraCalibrationService,
  ) {}

  @Post()
  @RequirePermissions('vision:ingest')
  @ApiOperation({
    summary:
      'Register a camera source (FILE_REPLAY functional; RTSP/webcam ' +
      'register as DISABLED placeholders). No URL or secret is stored.',
  })
  create(
    @CurrentTenantId() tenantId: string,
    @Body() body: CreateCameraSourceDto,
    @CurrentUser() actor: RequestContext,
  ) {
    return this.sources.create(tenantId, body, actor.userId);
  }

  @Get()
  @RequirePermissions('vision:read')
  @ApiOperation({ summary: 'List camera sources (credentialRef redacted)' })
  list(@CurrentTenantId() tenantId: string) {
    return this.sources.list(tenantId);
  }

  @Get(':id')
  @RequirePermissions('vision:read')
  @ApiOperation({ summary: 'Camera source detail (credentialRef redacted)' })
  byId(@CurrentTenantId() tenantId: string, @Param('id') id: string) {
    return this.sources.byId(tenantId, id);
  }

  @Patch(':id')
  @RequirePermissions('vision:ingest')
  @ApiOperation({
    summary:
      'Update a camera source. Placeholder types can never become ACTIVE.',
  })
  update(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Body() body: UpdateCameraSourceDto,
  ) {
    return this.sources.update(tenantId, id, body);
  }

  @Post(':id/replay-run')
  @RequirePermissions('video-asset:process')
  @ApiOperation({
    summary:
      'Replay a validated test video through this FILE_REPLAY source as ' +
      'if it were a camera stream: event windows → pickup detection → ' +
      'fusion → shadow journey. Records ONE auditable CameraPilotRun; ' +
      'idempotencyKey makes retries return the existing run.',
  })
  replayRun(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Body() body: ReplayRunDto,
    @CurrentUser() actor: RequestContext,
  ) {
    // Whitelisted forwarding — provenance fields (journeyId, counters)
    // are runtime-owned, never caller-supplied.
    return this.replay.replayRun(
      tenantId,
      id,
      {
        videoAssetId: body.videoAssetId,
        frameIntervalMs: body.frameIntervalMs,
        idempotencyKey: body.idempotencyKey,
      },
      actor.userId,
    );
  }

  @Post(':id/live-session')
  @RequirePermissions('vision:ingest')
  @ApiOperation({
    summary:
      'Start ONE live RTSP shadow session on this source (Phase 13). ' +
      'Idempotent-safe: an already-active session for the source is ' +
      'returned instead of starting a second. The stream URL is resolved ' +
      'server-side from the credential slot and never stored or returned.',
  })
  startLiveSession(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Body() body: StartLiveSessionDto,
    @CurrentUser() actor: RequestContext,
  ) {
    // Whitelisted forwarding — provenance (journeyId, counters, lease)
    // is runtime-owned, never caller-supplied.
    return this.live.start(
      tenantId,
      id,
      { frameIntervalMs: body.frameIntervalMs },
      actor.userId,
    );
  }

  @Get(':id/live-test-preflight')
  @RequirePermissions('vision:read')
  @ApiOperation({
    summary:
      'Phase 16 real-footage test preflight: source/config/ffmpeg/' +
      'fast-mode/pilot-runner/active-session readiness as controlled ' +
      'booleans — no URL, path, or credential material. Optional ' +
      '?evaluationRunId= existence check.',
  })
  liveTestPreflight(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Query('evaluationRunId') evaluationRunId?: string,
    @Query('fastModeExpected') fastModeExpected?: string,
    @Query('requirePilotRunner') requirePilotRunner?: string,
  ) {
    return this.live.liveTestPreflight(tenantId, id, evaluationRunId || null, {
      fastModeExpected:
        fastModeExpected === 'true'
          ? true
          : fastModeExpected === 'false'
            ? false
            : null,
      requirePilotRunner: requirePilotRunner === 'true',
    });
  }

  @Get(':id/calibration-readiness')
  @RequirePermissions('vision:read')
  @ApiOperation({
    summary:
      'Phase 17 calibration readiness for this camera source: controlled ' +
      'booleans/enums/counts plus a controlled warning list — no URL, ' +
      'path, or credential material.',
  })
  calibrationReadiness(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
  ) {
    return this.calibration.calibrationReadiness(tenantId, id);
  }

  @Get(':id/pilot-hardening-report')
  @RequirePermissions('vision:read')
  @ApiOperation({
    summary:
      'Phase 17 pilot hardening report: source status, calibration ' +
      'readiness, zone/product coverage, latest live session + ' +
      'performance (null when absent, never fabricated), and a ' +
      'controlled next-action list. No URL, path, or credential material.',
  })
  pilotHardeningReport(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
  ) {
    return this.calibration.pilotHardeningReport(tenantId, id);
  }

  @Post(':id/pilot-test')
  @RequirePermissions('vision:ingest')
  @ApiOperation({
    summary:
      'Phase 14 DEV/ADMIN pilot test: start a live session on this ' +
      'source, sample up to the frame/time budget, stop, and return a ' +
      'controlled speed summary (timings, review counts, zero-mutation ' +
      'safety proof). Gated by CV_LIVE_PILOT_RUNNER_ENABLED; no URL or ' +
      'credential material in the response.',
  })
  pilotTest(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Body() body: PilotTestDto,
    @CurrentUser() actor: RequestContext,
  ) {
    return this.live.runPilotTest(
      tenantId,
      id,
      {
        frameIntervalMs: body.frameIntervalMs,
        maxFrames: body.maxFrames,
        maxSeconds: body.maxSeconds,
      },
      actor.userId,
    );
  }
}

@ApiTags('camera')
@ApiBearerAuth()
@TenantOnly()
@RequireModule('cv')
@Controller('live-sessions')
export class LiveSessionsController {
  constructor(private readonly live: LiveSessionService) {}

  @Get()
  @RequirePermissions('vision:read')
  @ApiOperation({
    summary:
      'Live shadow sessions (newest first). No URL or credential ' +
      'material in any response.',
  })
  list(@CurrentTenantId() tenantId: string) {
    return this.live.list(tenantId);
  }

  @Get(':id')
  @RequirePermissions('vision:read')
  @ApiOperation({
    summary: 'Live session detail: counters, event windows, error code',
  })
  byId(@CurrentTenantId() tenantId: string, @Param('id') id: string) {
    return this.live.byId(tenantId, id);
  }

  @Get(':id/performance')
  @RequirePermissions('vision:read')
  @ApiOperation({
    summary:
      'Phase 14 performance report: per-stage timing statistics ' +
      '(p50/p95/max), slowest stage, fast-mode flag, and a zero-mutation ' +
      'safety summary. Controlled JSON only — no URL or credential ' +
      'material.',
  })
  performance(@CurrentTenantId() tenantId: string, @Param('id') id: string) {
    return this.live.performance(tenantId, id);
  }

  @Post(':id/stop')
  @RequirePermissions('vision:ingest')
  @ApiOperation({
    summary:
      'Stop a live session — safe even if the sampling loop already ' +
      'died: the journey is exited/reconciled and the session settles ' +
      'STOPPED. Idempotent on terminal sessions.',
  })
  stop(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @CurrentUser() actor: RequestContext,
  ) {
    return this.live.stop(tenantId, id, actor.userId);
  }
}

@ApiTags('camera')
@ApiBearerAuth()
@TenantOnly()
@RequireModule('cv')
@Controller('pilot-runs')
export class PilotRunsController {
  constructor(private readonly replay: CameraReplayService) {}

  @Get()
  @RequirePermissions('vision:read')
  @ApiOperation({ summary: 'Pilot runs with per-stage counters (newest first)' })
  list(@CurrentTenantId() tenantId: string) {
    return this.replay.list(tenantId);
  }

  @Get(':id')
  @RequirePermissions('vision:read')
  @ApiOperation({
    summary: 'Pilot run detail: event windows, stage timings, error codes',
  })
  byId(@CurrentTenantId() tenantId: string, @Param('id') id: string) {
    return this.replay.byId(tenantId, id);
  }
}

/**
 * Phase 17 — camera calibration profiles + zones (SHADOW ONLY).
 * Calibration is setup metadata for reliable live TESTING: normalized
 * zones and safe structured fields only. No RTSP URL, file path,
 * credential slot, raw frame, or raw video is ever stored or returned,
 * and no route here touches checkout, orders, payments, or inventory.
 */
@ApiTags('camera')
@ApiBearerAuth()
@TenantOnly()
@RequireModule('cv')
@Controller('camera-calibration-profiles')
export class CameraCalibrationController {
  constructor(private readonly calibration: CameraCalibrationService) {}

  @Post()
  @RequirePermissions('vision:ingest')
  @ApiOperation({
    summary:
      'Create a calibration profile (DRAFT) for a camera source. Safe ' +
      'structured metadata only; notes are screened free text.',
  })
  create(
    @CurrentTenantId() tenantId: string,
    @Body() body: CreateCalibrationProfileDto,
    @CurrentUser() actor: RequestContext,
  ) {
    return this.calibration.createProfile(tenantId, body, actor.userId);
  }

  @Get()
  @RequirePermissions('vision:read')
  @ApiOperation({
    summary:
      'List calibration profiles (newest first), optionally filtered by ' +
      '?cameraSourceId=',
  })
  list(
    @CurrentTenantId() tenantId: string,
    @Query('cameraSourceId') cameraSourceId?: string,
  ) {
    return this.calibration.listProfiles(tenantId, cameraSourceId || null);
  }

  @Get(':id')
  @RequirePermissions('vision:read')
  @ApiOperation({ summary: 'Calibration profile detail with its zones' })
  byId(@CurrentTenantId() tenantId: string, @Param('id') id: string) {
    return this.calibration.profileById(tenantId, id);
  }

  @Patch(':id')
  @RequirePermissions('vision:ingest')
  @ApiOperation({
    summary:
      'Update calibration metadata (DRAFT/ACTIVE only — an ARCHIVED ' +
      'profile is immutable).',
  })
  update(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Body() body: UpdateCalibrationProfileDto,
  ) {
    return this.calibration.updateProfile(tenantId, id, body);
  }

  @Post(':id/activate')
  @RequirePermissions('vision:ingest')
  @ApiOperation({
    summary:
      'EXPLICIT activation: requires at least one active SHELF_ZONE and ' +
      'one active INTERACTION_ZONE; archives the source\'s current ' +
      'ACTIVE profile (one ACTIVE per camera source).',
  })
  activate(@CurrentTenantId() tenantId: string, @Param('id') id: string) {
    return this.calibration.activateProfile(tenantId, id);
  }

  @Post(':id/archive')
  @RequirePermissions('vision:ingest')
  @ApiOperation({ summary: 'Archive a calibration profile (terminal)' })
  archive(@CurrentTenantId() tenantId: string, @Param('id') id: string) {
    return this.calibration.archiveProfile(tenantId, id);
  }

  @Post(':id/zones')
  @RequirePermissions('vision:ingest')
  @ApiOperation({
    summary:
      'Add a zone (normalized 0..1 polygon, 3..20 points). Expected ' +
      'products are SHELF_ZONE-only and tenant-scoped.',
  })
  addZone(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Body() body: CreateCalibrationZoneDto,
  ) {
    return this.calibration.addZone(tenantId, id, body);
  }

  @Patch(':id/zones/:zoneId')
  @RequirePermissions('vision:ingest')
  @ApiOperation({
    summary:
      'Update a zone; expectedProductIds uses REPLACE-ALL semantics.',
  })
  updateZone(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Param('zoneId') zoneId: string,
    @Body() body: UpdateCalibrationZoneDto,
  ) {
    return this.calibration.updateZone(tenantId, id, zoneId, body);
  }

  @Delete(':id/zones/:zoneId')
  @RequirePermissions('vision:ingest')
  @ApiOperation({ summary: 'Delete a zone (and its expected products)' })
  deleteZone(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Param('zoneId') zoneId: string,
  ) {
    return this.calibration.deleteZone(tenantId, id, zoneId);
  }
}

@Module({
  imports: [
    PlatformModulesModule,
    VideoIngestModule,
    PickupDetectionModule,
    PickupFusionModule,
    JourneyModule,
  ],
  controllers: [
    CameraSourcesController,
    PilotRunsController,
    LiveSessionsController,
    CameraCalibrationController,
  ],
  providers: [
    CameraSourcesService,
    CameraReplayService,
    LiveSessionService,
    RtspFrameSampler,
    CameraCalibrationService,
  ],
})
export class CameraModule {}
