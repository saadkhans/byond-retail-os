import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CycleCountLine, ShrinkEvent } from '@prisma/client';
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
import { CycleCountDetail } from './cycle-count.repository';
import { CycleCountService } from './cycle-count.service';
import {
  CancelCycleCountDto,
  OpenCycleCountDto,
  QueryCycleCountsDto,
  QueryReturnsDto,
  QueryShrinkDto,
  RecordCountLineDto,
  RecordReturnDto,
  RecordShrinkDto,
} from './returns.dto';
import { OrderReturnDetail } from './returns.repository';
import { ReturnsService } from './returns.service';
import { ShrinkService } from './shrink.service';

/** The actor shape the audit trail wants, from the request context. */
function actorOf(user: RequestContext): { id: string; email: string } {
  return { id: user.userId, email: user.email };
}

/**
 * Phase 27 — returns, cancellations and the refunds they trigger.
 *
 * Reads need `return:read`; recording a return or a cancellation-with-reversal
 * needs `return:manage`. Default deny applies throughout, and the whole
 * controller is gated on the `returns` module.
 *
 * There is deliberately no PATCH or DELETE here. A return is an append-only
 * account of what came off the shelf; correcting one means recording another,
 * so the history of the goods never gets rewritten.
 */
@ApiTags('returns')
@ApiBearerAuth()
@TenantOnly()
@RequireModule('returns')
@Controller('returns')
export class ReturnsController {
  constructor(private readonly returns: ReturnsService) {}

  @Get()
  @RequirePermissions('return:read')
  @ApiOperation({
    summary: 'List returns and cancellations in the caller’s tenant',
    description:
      'Newest first with an id tie-breaker, paginated. Each return carries ' +
      'the lines that came back, the ledger movement each line produced, and ' +
      'the refund it triggered (or why there was none).',
  })
  search(
    @CurrentTenantId() tenantId: string,
    @Query() query: QueryReturnsDto,
  ): Promise<{
    items: OrderReturnDetail[];
    total: number;
    skip: number;
    take: number;
  }> {
    return this.returns.search(tenantId, query);
  }

  @Get(':id')
  @RequirePermissions('return:read')
  @ApiOperation({ summary: 'Get one return with its lines and refund' })
  @ApiNotFoundResponse({ description: 'Not found in this tenant' })
  findById(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
  ): Promise<OrderReturnDetail> {
    return this.returns.findById(tenantId, id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('return:manage')
  @ApiOperation({
    summary: 'Record a return or cancel a settled order, reversing stock',
    description:
      'Goods first, money second. The returned lines go BACK into stock as ' +
      'RETURN_IN ledger movements in one transaction (never as an edit to a ' +
      'stock level); only then is a refund driven through the payment ' +
      'abstraction, bounded by what the order actually captured. ' +
      'ORDER_CANCELLATION reverses everything still outstanding and cancels ' +
      'the order — this is the path a PAID order is cancelled through. ' +
      'Idempotent by `reference`: replaying a request never reverses stock or ' +
      'refunds money twice.',
  })
  @ApiOkResponse({ description: 'Return recorded (or replayed by reference)' })
  @ApiNotFoundResponse({ description: 'Order not found in this tenant' })
  @ApiConflictResponse({
    description:
      'Order not returnable, quantity exceeds what was bought, or the ' +
      'reference was used for a different order',
  })
  record(
    @CurrentTenantId() tenantId: string,
    @Body() dto: RecordReturnDto,
    @CurrentUser() user: RequestContext,
  ): Promise<OrderReturnDetail> {
    return this.returns.recordReturn(tenantId, dto, actorOf(user));
  }
}

/**
 * Phase 27 — cycle counts and stocktakes.
 *
 * Reads need `cycle-count:read`; opening a count, recording counted
 * quantities, reconciling and abandoning all need `cycle-count:manage`.
 */
@ApiTags('cycle-counts')
@ApiBearerAuth()
@TenantOnly()
@RequireModule('returns')
@Controller('cycle-counts')
export class CycleCountController {
  constructor(private readonly cycleCounts: CycleCountService) {}

  @Get()
  @RequirePermissions('cycle-count:read')
  @ApiOperation({ summary: 'List cycle counts and stocktakes' })
  search(
    @CurrentTenantId() tenantId: string,
    @Query() query: QueryCycleCountsDto,
  ): Promise<{
    items: CycleCountDetail[];
    total: number;
    skip: number;
    take: number;
  }> {
    return this.cycleCounts.search(tenantId, query);
  }

  @Get(':id')
  @RequirePermissions('cycle-count:read')
  @ApiOperation({
    summary: 'Get one count with every counted line and its variance',
    description:
      'A reconciled line shows what was counted, what the projection said, ' +
      'what the ledger replays to, the variance between them, and the ' +
      'movement the variance became.',
  })
  @ApiNotFoundResponse({ description: 'Not found in this tenant' })
  findById(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
  ): Promise<CycleCountDetail> {
    return this.cycleCounts.findById(tenantId, id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('cycle-count:manage')
  @ApiOperation({
    summary: 'Open a cycle count or a full stocktake for a store',
    description:
      'Opening a count changes nothing. Idempotent by `reference`.',
  })
  open(
    @CurrentTenantId() tenantId: string,
    @Body() dto: OpenCycleCountDto,
    @CurrentUser() user: RequestContext,
  ): Promise<CycleCountDetail> {
    return this.cycleCounts.open(tenantId, dto, actorOf(user));
  }

  @Post(':id/lines')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('cycle-count:manage')
  @ApiOperation({
    summary: 'Record what was counted for one product',
    description:
      'Re-counting the same product overwrites the figure — a count sheet is ' +
      'a working document until it is reconciled, and nothing here touches ' +
      'stock.',
  })
  @ApiNotFoundResponse({ description: 'Count or product not found' })
  @ApiConflictResponse({ description: 'The count is no longer open' })
  recordLine(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Body() dto: RecordCountLineDto,
    @CurrentUser() user: RequestContext,
  ): Promise<CycleCountLine> {
    return this.cycleCounts.recordLine(tenantId, id, dto, actorOf(user));
  }

  @Post(':id/reconcile')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('cycle-count:manage')
  @ApiOperation({
    summary: 'Reconcile the count against the projection and the ledger',
    description:
      'For every counted product: reads the stock projection under that ' +
      'product’s lock, replays the ledger for the same store and product, and ' +
      'appends a signed CORRECTION_IN/CORRECTION_OUT movement for any ' +
      'variance. The counted figure is NEVER assigned to a stock level — a ' +
      'count changes stock only by appending to the ledger, so the ledger ' +
      'stays the only history. A count that agrees with the books writes ' +
      'nothing at all.',
  })
  @ApiOkResponse({ description: 'Count reconciled' })
  @ApiNotFoundResponse({ description: 'Not found in this tenant' })
  @ApiConflictResponse({
    description: 'Already reconciled, empty, or a variance the ledger refused',
  })
  reconcile(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @CurrentUser() user: RequestContext,
  ): Promise<CycleCountDetail> {
    return this.cycleCounts.reconcile(tenantId, id, actorOf(user));
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('cycle-count:manage')
  @ApiOperation({
    summary: 'Abandon an open count',
    description: 'It never touched stock, so there is nothing to reverse.',
  })
  cancel(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Body() dto: CancelCycleCountDto,
    @CurrentUser() user: RequestContext,
  ): Promise<CycleCountDetail> {
    return this.cycleCounts.cancel(tenantId, id, dto, actorOf(user));
  }
}

/**
 * Phase 27 — the shrink path for CV-detected loss.
 *
 * Reads need `shrink:read`; recording a write-off needs `shrink:record`, a
 * permission of its own precisely because it removes real stock from the books.
 */
@ApiTags('shrink')
@ApiBearerAuth()
@TenantOnly()
@RequireModule('returns')
@Controller('shrink-events')
export class ShrinkController {
  constructor(private readonly shrink: ShrinkService) {}

  @Get()
  @RequirePermissions('shrink:read')
  @ApiOperation({ summary: 'List recorded shrink write-offs' })
  search(
    @CurrentTenantId() tenantId: string,
    @Query() query: QueryShrinkDto,
  ): Promise<{
    items: ShrinkEvent[];
    total: number;
    skip: number;
    take: number;
  }> {
    return this.shrink.search(tenantId, query);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('shrink:record')
  @ApiOperation({
    summary: 'Write off a CV-detected loss as a SHRINK movement',
    description:
      'Turns one reviewed PRODUCT_PICKUP observation that no live order ' +
      'accounts for into a single SHRINK ledger movement plus the record of ' +
      'who decided and why. The product must be one the observation actually ' +
      'proposed, and the quantity cannot exceed what was observed. Idempotent ' +
      'per observation: one observation can be written off exactly once.',
  })
  @ApiNotFoundResponse({ description: 'Observation not found in this tenant' })
  @ApiConflictResponse({
    description:
      'Still under review, already accounted for by an order, an unobserved ' +
      'product, or no stock left to write off',
  })
  record(
    @CurrentTenantId() tenantId: string,
    @Body() dto: RecordShrinkDto,
    @CurrentUser() user: RequestContext,
  ): Promise<ShrinkEvent> {
    return this.shrink.record(tenantId, dto, actorOf(user));
  }
}
