import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
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
import {
  IssueEntryTokenDto,
  PublishStoreFlowPolicyDto,
  RedeemEntryTokenDto,
  ReviewObservationDto,
  StoreFlowQueryDto,
} from './store-flow.dto';
import { StoreFlowService } from './store-flow.service';

/** The actor shape the audit trail wants, from the request context. */
function actorOf(user: RequestContext): { id: string; email: string } {
  return { id: user.userId, email: user.email };
}

/**
 * Phase 26 — the store flow.
 *
 * Reads need `store-flow:read`; changing how autonomous a store is needs
 * `store-flow:manage`; running the flow needs `store-flow:operate`; redeeming
 * an entry credential needs `store-flow:enter`; deciding a queued observation
 * needs `store-flow:review`. Default deny applies throughout, and the whole
 * controller is gated on the `store-flow` module.
 */
@ApiTags('store-flow')
@ApiBearerAuth()
@TenantOnly()
@RequireModule('store-flow')
@Controller('store-flow')
export class StoreFlowController {
  constructor(private readonly storeFlow: StoreFlowService) {}

  // ---------------------------------------------------------------- policy

  @Get('policies')
  @RequirePermissions('store-flow:read')
  @ApiOperation({
    summary:
      'The autonomy policies configured for this tenant and its stores, each ' +
      'with its full version history.',
  })
  policies(@CurrentTenantId() tenantId: string) {
    return this.storeFlow.listPolicies(tenantId);
  }

  @Get('policies/effective/:locationId')
  @RequirePermissions('store-flow:read')
  @ApiOperation({
    summary:
      'The policy actually in force at one store: its own if it has one, ' +
      'else the tenant default, else the built-in SHADOW default.',
  })
  effectivePolicy(
    @CurrentTenantId() tenantId: string,
    @Param('locationId') locationId: string,
  ) {
    return this.storeFlow.effectivePolicy(tenantId, locationId);
  }

  @Post('policies')
  @RequirePermissions('store-flow:manage')
  @ApiOperation({
    summary:
      'Publish a new immutable policy version and make it active. The ' +
      'previous version is never edited, so reverting means publishing an ' +
      'earlier version forward again.',
  })
  publishPolicy(
    @CurrentTenantId() tenantId: string,
    @Body() body: PublishStoreFlowPolicyDto,
    @CurrentUser() user: RequestContext,
  ) {
    return this.storeFlow.publishPolicy(tenantId, body, actorOf(user));
  }

  // ----------------------------------------------------------------- entry

  @Post('entry-tokens')
  @RequirePermissions('store-flow:operate')
  @ApiOperation({
    summary:
      'Issue a single-use, short-TTL store entry credential. The secret is ' +
      'returned in this response and nowhere else — only its digest is kept.',
  })
  issueEntryToken(
    @CurrentTenantId() tenantId: string,
    @Body() body: IssueEntryTokenDto,
    @CurrentUser() user: RequestContext,
  ) {
    return this.storeFlow.issueEntryToken(tenantId, body, actorOf(user));
  }

  @Get('entry-tokens')
  @RequirePermissions('store-flow:read')
  @ApiOperation({
    summary:
      'Recently issued entry credentials and their state. Digests are never ' +
      'returned.',
  })
  entryTokens(
    @CurrentTenantId() tenantId: string,
    @Query() query: StoreFlowQueryDto,
  ) {
    return this.storeFlow.listEntryTokens(tenantId, query.limit);
  }

  @Post('entry-tokens/:id/revoke')
  @RequirePermissions('store-flow:operate')
  @ApiOperation({ summary: 'Revoke an unused entry credential.' })
  revokeEntryToken(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @CurrentUser() user: RequestContext,
  ) {
    return this.storeFlow.revokeEntryToken(tenantId, id, actorOf(user));
  }

  @Post('entry')
  @RequirePermissions('store-flow:enter')
  @ApiOperation({
    summary:
      'Redeem an entry credential: burn it, open the shopper journey, and ' +
      'open the checkout session its observations will fold into.',
  })
  enter(
    @CurrentTenantId() tenantId: string,
    @Body() body: RedeemEntryTokenDto,
    @CurrentUser() user: RequestContext,
  ) {
    return this.storeFlow.redeemEntryToken(tenantId, body, actorOf(user));
  }

  // -------------------------------------------------------------- journeys

  @Get('journeys')
  @RequirePermissions('store-flow:read')
  @ApiOperation({
    summary: 'Store-flow journeys with their bound basket and settlement state.',
  })
  journeys(
    @CurrentTenantId() tenantId: string,
    @Query() query: StoreFlowQueryDto,
  ) {
    return this.storeFlow.listJourneys(tenantId, query.limit);
  }

  @Get('journeys/:id')
  @RequirePermissions('store-flow:read')
  @ApiOperation({
    summary:
      'One journey: its observations, what the bridge did with each, the ' +
      'policy in force, and the basket as it stands.',
  })
  journey(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
  ) {
    return this.storeFlow.journeyDetail(tenantId, id);
  }

  @Post('journeys/:id/sync')
  @RequirePermissions('store-flow:operate')
  @ApiOperation({
    summary:
      'Project every observation on this journey that has not been projected ' +
      'yet. Idempotent: running it twice changes nothing.',
  })
  sync(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @CurrentUser() user: RequestContext,
  ) {
    return this.storeFlow.syncJourney(tenantId, id, actorOf(user));
  }

  @Post('journeys/:id/exit')
  @RequirePermissions('store-flow:operate')
  @ApiOperation({
    summary:
      'The shopper leaves: catch up on observations, close the journey and, ' +
      'when the policy allows it and nothing awaits review, complete the ' +
      'basket into an order and settle it. Replay-safe.',
  })
  exit(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @CurrentUser() user: RequestContext,
  ) {
    return this.storeFlow.exitJourney(tenantId, id, actorOf(user));
  }

  // ----------------------------------------------------------- review queue

  @Get('review-queue')
  @RequirePermissions('store-flow:read')
  @ApiOperation({
    summary:
      'One queue over both streams: each uncertain observation with what the ' +
      'bridge did with it and the state of the vision event it produced.',
  })
  reviewQueue(@CurrentTenantId() tenantId: string) {
    return this.storeFlow.reviewQueue(tenantId);
  }

  @Post('review-queue/:eventId/decision')
  @RequirePermissions('store-flow:review')
  @ApiOperation({
    summary:
      'Decide one queued observation. The decision is recorded against the ' +
      'journey observation AND applied to the vision event, so approving ' +
      'here actually moves the basket.',
  })
  decide(
    @CurrentTenantId() tenantId: string,
    @Param('eventId') eventId: string,
    @Body() body: ReviewObservationDto,
    @CurrentUser() user: RequestContext,
  ) {
    return this.storeFlow.reviewObservation(
      tenantId,
      eventId,
      body,
      actorOf(user),
    );
  }
}
