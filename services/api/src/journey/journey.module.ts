import { Body, Controller, Get, Module, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CustomerJourneyEventType } from '@prisma/client';
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
import { PlatformModulesModule } from '../platform-modules/platform-modules.module';
import { JourneyService } from './journey.service';

/**
 * Customer-journey skeleton endpoints — SHADOW MODE: append-only
 * observations and a provisional basket FOLD; no checkout, order,
 * payment, or inventory route exists here.
 */
@ApiTags('journeys')
@ApiBearerAuth()
@TenantOnly()
@RequireModule('cv')
@Controller('journeys')
export class JourneyController {
  constructor(private readonly journeys: JourneyService) {}

  @Post()
  @RequirePermissions('vision:ingest')
  @ApiOperation({ summary: 'Open a journey (records the ENTRY event)' })
  create(
    @CurrentTenantId() tenantId: string,
    @Body() body: { locationId: string; unitId?: string },
    @CurrentUser() actor: RequestContext,
  ) {
    return this.journeys.create(tenantId, body, actor.userId);
  }

  @Get()
  @RequirePermissions('vision:read')
  @ApiOperation({ summary: 'List recent journeys' })
  list(@CurrentTenantId() tenantId: string) {
    return this.journeys.list(tenantId);
  }

  @Get(':id')
  @RequirePermissions('vision:read')
  @ApiOperation({
    summary: 'Journey detail: event timeline, provisional basket, issues',
  })
  detail(@CurrentTenantId() tenantId: string, @Param('id') id: string) {
    return this.journeys.detail(tenantId, id);
  }

  @Post(':id/events')
  @RequirePermissions('vision:ingest')
  @ApiOperation({
    summary:
      'Append one observation (SHELF_INTERACTION / PRODUCT_PICKUP / ' +
      'PRODUCT_RETURN / REVIEW_REQUIRED) — append-only, shadow-only',
  })
  appendEvent(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Body()
    body: {
      eventType: CustomerJourneyEventType;
      occurredAt?: string;
      productId?: string;
      quantity?: number;
      note?: string;
    },
    @CurrentUser() actor: RequestContext,
  ) {
    return this.journeys.appendEvent(tenantId, id, body, actor.userId);
  }

  @Post(':id/events/from-fusion-run')
  @RequirePermissions('vision:ingest')
  @ApiOperation({
    summary:
      "Import a video's LATEST fusion shadow run as a journey observation " +
      '(AUTO_PROPOSE → product event; anything else → REVIEW_REQUIRED)',
  })
  fromFusionRun(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Body() body: { videoAssetId: string },
    @CurrentUser() actor: RequestContext,
  ) {
    return this.journeys.appendFromFusionRun(
      tenantId,
      id,
      body.videoAssetId,
      actor.userId,
    );
  }

  @Post(':id/exit')
  @RequirePermissions('vision:ingest')
  @ApiOperation({
    summary:
      'Record EXIT and reconcile: fold the basket, surface unresolved ' +
      'issues, settle status (RECONCILED or REVIEW_REQUIRED)',
  })
  exit(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @CurrentUser() actor: RequestContext,
  ) {
    return this.journeys.exit(tenantId, id, actor.userId);
  }
}

@Module({
  imports: [PlatformModulesModule],
  controllers: [JourneyController],
  providers: [JourneyService],
})
export class JourneyModule {}
