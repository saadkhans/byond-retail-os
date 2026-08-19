import {
  Body,
  Controller,
  Get,
  Module,
  Param,
  Patch,
  Post,
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
import { CameraReplayService } from './camera-replay.service';
import { CameraSourcesService } from './camera-sources.service';
import { CreateCameraSourceDto } from './dto/create-camera-source.dto';
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
  ],
  providers: [
    CameraSourcesService,
    CameraReplayService,
    LiveSessionService,
    RtspFrameSampler,
  ],
})
export class CameraModule {}
