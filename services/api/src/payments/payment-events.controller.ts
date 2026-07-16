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
import { PaymentEventWithRefs } from './payment-events.repository';
import { PaymentEventsService } from './payment-events.service';
import { QueryPaymentEventsDto } from './dto/query-payment-events.dto';
import { SimulatePaymentEventDto } from './dto/simulate-payment-event.dto';

/**
 * Provider event / webhook INGESTION FOUNDATION. Authenticated/admin-only in
 * this phase — there is NO public webhook endpoint and NO webhook
 * signature/secret verification yet. Only normalized fields are stored (no raw
 * provider payload). Duplicate (provider, providerEventId) is idempotent.
 */
@ApiTags('payment-events')
@ApiBearerAuth()
@TenantOnly()
@RequireModule('payments')
@Controller('payment-events')
export class PaymentEventsController {
  constructor(private readonly eventsService: PaymentEventsService) {}

  @Post('simulate')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('payment:simulate')
  @ApiOperation({
    summary: 'Ingest a simulated provider event (normalized fields only)',
    description:
      'Records a normalized provider event. NO raw payload is stored and NO ' +
      'signature is verified — this is a foundation for future gateway ' +
      'adapters, not a live webhook. A duplicate (provider, providerEventId) ' +
      'replays the existing record. UNKNOWN event types are recorded IGNORED.',
  })
  @ApiCreatedResponse({ description: 'Event recorded (or replayed if duplicate)' })
  simulate(
    @CurrentTenantId() tenantId: string,
    @Body() dto: SimulatePaymentEventDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<PaymentEventWithRefs> {
    return this.eventsService.ingest(tenantId, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }

  @Get()
  @RequirePermissions('payment:read')
  @ApiOperation({
    summary: 'List payment (provider) events in the caller’s tenant',
    description:
      'Filters: status, provider, event type, intent. Deterministic ordering ' +
      '(newest received first, id tie-breaker), paginated.',
  })
  search(
    @CurrentTenantId() tenantId: string,
    @Query() query: QueryPaymentEventsDto,
  ): Promise<{
    items: PaymentEventWithRefs[];
    total: number;
    skip: number;
    take: number;
  }> {
    return this.eventsService.search(tenantId, query);
  }

  @Get(':id')
  @RequirePermissions('payment:read')
  @ApiOperation({ summary: 'Get a payment event' })
  @ApiNotFoundResponse({ description: 'Not found in this tenant' })
  findById(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
  ): Promise<PaymentEventWithRefs> {
    return this.eventsService.findById(tenantId, id);
  }
}
