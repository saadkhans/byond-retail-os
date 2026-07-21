import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
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
import { BindVisionEventSessionDto } from './dto/bind-vision-event-session.dto';
import { IngestVisionEventDto } from './dto/ingest-vision-event.dto';
import { QueryVisionEventsDto } from './dto/query-vision-events.dto';
import { ReviewVisionEventDto } from './dto/review-vision-event.dto';
import {
  VisionEventDetail,
  VisionEventWithRefs,
} from './vision-events.repository';
import { VisionEventsService } from './vision-events.service';

@ApiTags('vision-events')
@ApiBearerAuth()
@TenantOnly()
@RequireModule('cv')
@Controller('vision-events')
export class VisionEventsController {
  constructor(private readonly eventsService: VisionEventsService) {}

  @Post()
  @RequirePermissions('vision:ingest')
  @ApiOperation({
    summary: 'Ingest a normalized product interaction event',
    description:
      'Provider-neutral: adapters normalize their raw CV/VLM detections to ' +
      'catalog SKU candidates before ingesting, with a sourceType enum, an ' +
      'optional store/unit/device/session binding, optional ' +
      'evidenceScore/evidenceQuality/reasonCodes, and an optional inline ' +
      'evidence bundle that is a lineage-only record (sourceType plus ' +
      'captureStartedAt/captureEndedAt) created atomically with the event. ' +
      'Phase 7 does not accept evidence artifacts or external media ' +
      'references; evidence media storage is deferred to a future evidence ' +
      'storage phase. The event lands in PENDING_REVIEW and NEVER touches ' +
      'the basket or inventory by itself — only an approved review ' +
      'decision does. Retrying with the same idempotencyKey returns the ' +
      'original event.',
  })
  @ApiCreatedResponse({ description: 'Event ingested (PENDING_REVIEW)' })
  ingest(
    @CurrentTenantId() tenantId: string,
    @Body() dto: IngestVisionEventDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<VisionEventDetail> {
    return this.eventsService.ingest(tenantId, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }

  @Get()
  @RequirePermissions('vision:read')
  @ApiOperation({
    summary: 'List vision events in the caller’s tenant',
    description:
      'Filters: status, type, session, store, unit. Deterministic ordering ' +
      '(newest occurredAt first, id tie-breaker), paginated via skip/take.',
  })
  search(
    @CurrentTenantId() tenantId: string,
    @Query() query: QueryVisionEventsDto,
  ): Promise<{
    items: VisionEventWithRefs[];
    total: number;
    skip: number;
    take: number;
  }> {
    return this.eventsService.search(tenantId, query);
  }

  @Get(':id')
  @RequirePermissions('vision:read')
  @ApiOperation({
    summary: 'Get a vision event with candidates, review, and evidence',
    description:
      'Includes the ranked SKU candidates, the review decision once made, ' +
      'and the linked evidence bundle lineage record.',
  })
  @ApiNotFoundResponse({ description: 'Not found in this tenant' })
  findById(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
  ): Promise<VisionEventDetail> {
    return this.eventsService.findById(tenantId, id);
  }

  @Post(':id/session')
  // vision:review, not vision:ingest: binding is part of the REVIEW
  // workflow (a reviewer must be able to bind before approving), and a
  // least-privilege reviewer does not hold the adapter-facing ingest
  // permission. Adapters that know the session at ingest time bind it
  // there; late correlation is a reviewer action.
  @RequirePermissions('vision:review')
  @ApiOperation({
    summary: 'Bind an unbound pending event to a checkout session',
    description:
      'The audited correlation step for events ingested BEFORE the ' +
      'shopper’s session was known. Only a PENDING_REVIEW event with no ' +
      'session can be bound; the session must be on the same unit as the ' +
      'event. Binding is one-shot and never touches the basket — only a ' +
      'subsequent approved review decision does. Correcting a wrong ' +
      'binding is a REJECT + re-ingest, never a rebind.',
  })
  @ApiCreatedResponse({ description: 'Session bound; event returned' })
  @ApiNotFoundResponse({ description: 'Event not found in this tenant' })
  @ApiConflictResponse({
    description: 'Event already decided or already bound to a session',
  })
  bindSession(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Body() dto: BindVisionEventSessionDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<VisionEventDetail> {
    return this.eventsService.bindSession(tenantId, id, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }

  @Post(':id/review')
  @RequirePermissions('vision:review')
  @ApiOperation({
    summary: 'Decide a pending event (approve / reject / manual override)',
    description:
      'Decisions are terminal and atomic with their basket effect: an ' +
      'approved PRODUCT_PICKUP/CART_INSERTION adds or increases a basket ' +
      'line on the linked session; an approved PRODUCT_RETURN decreases or ' +
      'removes one; OVERRIDE applies the reviewer’s product/quantity ' +
      'instead of the top candidate; REJECT never touches the basket. ' +
      'PRODUCT_TRANSFER and EXIT_RECONCILIATION are record-only. The ' +
      'decision, the event status flip, the basket mutation, and all audit ' +
      'rows commit or roll back together.',
  })
  @ApiCreatedResponse({ description: 'Decision recorded; event returned' })
  @ApiNotFoundResponse({ description: 'Event (or override product) not found' })
  @ApiConflictResponse({
    description:
      'Already decided, no candidates, no/terminal session, product not ' +
      'saleable, nothing to decrement, or quantity overflow',
  })
  review(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Body() dto: ReviewVisionEventDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<VisionEventDetail> {
    return this.eventsService.review(tenantId, id, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }
}
