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
import { PlatformModulesModule } from '../platform-modules/platform-modules.module';
import { AppendJourneyEventDto } from './dto/append-journey-event.dto';
import { CreateJourneyDto } from './dto/create-journey.dto';
import { FromFusionRunDto } from './dto/from-fusion-run.dto';
import { ReviewJourneyEventDto } from './dto/review-journey-event.dto';
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
    @Body() body: CreateJourneyDto,
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
    @Body() body: AppendJourneyEventDto,
    @CurrentUser() actor: RequestContext,
  ) {
    // Forward ONLY the manual-event fields. Provenance (sourceType,
    // videoAssetId, fusionRunId, matchScore) is never caller-supplied
    // here — the fusion-run import endpoint below sets it after
    // resolving the asset and run within this tenant.
    return this.journeys.appendEvent(
      tenantId,
      id,
      {
        eventType: body.eventType,
        occurredAt: body.occurredAt,
        productId: body.productId,
        quantity: body.quantity,
        note: body.note,
      },
      actor.userId,
    );
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
    @Body() body: FromFusionRunDto,
    @CurrentUser() actor: RequestContext,
  ) {
    return this.journeys.appendFromFusionRun(
      tenantId,
      id,
      body.videoAssetId,
      actor.userId,
    );
  }

  @Post(':id/events/:eventId/review')
  // vision:review, matching the vision-event review endpoint: deciding an
  // observation is a reviewer action, and a least-privilege reviewer does
  // not hold the adapter-facing ingest permission.
  @RequirePermissions('vision:review')
  @ApiOperation({
    summary:
      'Review one observation (APPROVE / REJECT / CORRECT) — append-only, ' +
      'audited; corrections never rewrite the observation row and never ' +
      'touch checkout/order/payment state',
  })
  reviewEvent(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Param('eventId') eventId: string,
    @Body() body: ReviewJourneyEventDto,
    @CurrentUser() actor: RequestContext,
  ) {
    // Forward ONLY the declared review fields. Snapshot fields
    // (correctedSku, correctedProductName) are never caller-supplied —
    // the service resolves the product within this tenant and snapshots
    // them itself.
    return this.journeys.reviewEvent(
      tenantId,
      id,
      eventId,
      {
        decision: body.decision,
        reason: body.reason,
        correctedEventType: body.correctedEventType,
        correctedProductId: body.correctedProductId,
        correctedQuantity: body.correctedQuantity,
      },
      { id: actor.userId, email: actor.email },
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
