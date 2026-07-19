import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
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
import { AuthorizeIntentDto } from './dto/authorize-intent.dto';
import { BindIntentDto } from './dto/bind-intent.dto';
import { CancelIntentDto } from './dto/cancel-intent.dto';
import { CaptureIntentDto } from './dto/capture-intent.dto';
import { CreatePaymentIntentDto } from './dto/create-payment-intent.dto';
import { FailIntentDto } from './dto/fail-intent.dto';
import { QueryCapturesDto } from './dto/query-captures.dto';
import { QueryPaymentIntentsDto } from './dto/query-payment-intents.dto';
import {
  CaptureWithIntent,
  PaymentIntentDetail,
  PaymentIntentWithRefs,
} from './payments.repository';
import { PaymentsService } from './payments.service';

/**
 * Provider-abstract payment intents. NO live payment gateway is integrated in
 * this phase — authorization and capture are SIMULATED through the internal
 * state machine, and provider references are opaque. No raw card data is ever
 * accepted or stored. Real gateway adapters arrive in a later phase.
 */
@ApiTags('payments')
@ApiBearerAuth()
@TenantOnly()
@RequireModule('payments')
@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post('intents')
  @RequirePermissions('payment:manage')
  @ApiOperation({
    summary: 'Create a provider-abstract payment intent (simulated)',
    description:
      'Creates a payment intent in state CREATED. May be linked to an order ' +
      'and/or checkout session of the caller’s tenant, or created standalone ' +
      '(walk-out: payment association happens before/during checkout). Only ' +
      'opaque provider references and SAFE card metadata (brand, last4, ' +
      'expiry, wallet) are accepted — raw card numbers/CVV/PIN/tokens are ' +
      'rejected. Retrying with the same idempotencyKey returns the original ' +
      'intent. This does NOT contact a real gateway.',
  })
  @ApiCreatedResponse({ description: 'Intent created (or replayed by key)' })
  create(
    @CurrentTenantId() tenantId: string,
    @Body() dto: CreatePaymentIntentDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<PaymentIntentDetail> {
    return this.paymentsService.create(tenantId, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }

  @Get('intents')
  @RequirePermissions('payment:read')
  @ApiOperation({
    summary: 'List payment intents in the caller’s tenant',
    description:
      'Filters: status, provider, linked order, linked session. ' +
      'Deterministic ordering (newest first, id tie-breaker), paginated.',
  })
  search(
    @CurrentTenantId() tenantId: string,
    @Query() query: QueryPaymentIntentsDto,
  ): Promise<{
    items: PaymentIntentWithRefs[];
    total: number;
    skip: number;
    take: number;
  }> {
    return this.paymentsService.search(tenantId, query);
  }

  @Get('captures')
  @RequirePermissions('payment:read')
  @ApiOperation({
    summary: 'List simulated captures (reconciliation foundation)',
    description:
      'Deterministic ordering (newest first, id tie-breaker), paginated. ' +
      'Captures are read-only records — money movement is simulated.',
  })
  searchCaptures(
    @CurrentTenantId() tenantId: string,
    @Query() query: QueryCapturesDto,
  ): Promise<{
    items: CaptureWithIntent[];
    total: number;
    skip: number;
    take: number;
  }> {
    return this.paymentsService.searchCaptures(tenantId, query);
  }

  @Get('intents/:id')
  @RequirePermissions('payment:read')
  @ApiOperation({
    summary: 'Get a payment intent with its authorizations, captures & events',
  })
  @ApiNotFoundResponse({ description: 'Not found in this tenant' })
  findById(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
  ): Promise<PaymentIntentDetail> {
    return this.paymentsService.findById(tenantId, id);
  }

  @Post('intents/:id/authorize')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('payment:simulate')
  @ApiOperation({
    summary: 'Simulate authorization (provider-abstract, no live gateway)',
    description:
      'Legal only from CREATED/REQUIRES_AUTHORIZATION → AUTHORIZED. Records a ' +
      'simulated authorization hold. Idempotent by key. This is NOT a live ' +
      'payment authorization.',
  })
  @ApiOkResponse({ description: 'Intent authorized (simulated)' })
  @ApiNotFoundResponse({ description: 'Not found in this tenant' })
  @ApiConflictResponse({ description: 'Illegal transition, terminal state, or key conflict' })
  authorize(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Body() dto: AuthorizeIntentDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<PaymentIntentDetail> {
    return this.paymentsService.authorize(tenantId, id, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }

  @Post('intents/:id/capture')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('payment:simulate')
  @ApiOperation({
    summary: 'Simulate capture (provider-abstract, no live gateway)',
    description:
      'Legal only from AUTHORIZED/CAPTURE_PENDING → CAPTURED. Records a ' +
      'simulated capture, seeds a PENDING reconciliation record, and marks a ' +
      'linked order PAID — the ONLY path that marks an order paid. Duplicate ' +
      'captures with the same idempotencyKey never move money twice. This is ' +
      'NOT a live payment capture.',
  })
  @ApiOkResponse({ description: 'Intent captured (simulated)' })
  @ApiNotFoundResponse({ description: 'Not found in this tenant' })
  @ApiConflictResponse({ description: 'Illegal transition, terminal state, or key conflict' })
  capture(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Body() dto: CaptureIntentDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<PaymentIntentDetail> {
    return this.paymentsService.capture(tenantId, id, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }

  @Post('intents/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('payment:simulate')
  @ApiOperation({
    summary: 'Cancel a pre-auth intent or void an authorized one (simulated)',
    description:
      'CREATED/REQUIRES_AUTHORIZATION → CANCELLED; AUTHORIZED → VOIDED (voids ' +
      'the authorization hold and projects VOIDED onto a linked order, never ' +
      'a PAID one). CAPTURE_PENDING and terminal intents are rejected.',
  })
  @ApiOkResponse({ description: 'Intent cancelled/voided (simulated)' })
  @ApiNotFoundResponse({ description: 'Not found in this tenant' })
  @ApiConflictResponse({ description: 'Illegal transition or terminal state' })
  cancel(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Body() dto: CancelIntentDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<PaymentIntentDetail> {
    return this.paymentsService.cancel(tenantId, id, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }

  @Post('intents/:id/fail')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('payment:simulate')
  @ApiOperation({
    summary: 'Simulate a payment failure/decline',
    description:
      'Non-terminal intent → FAILED. A linked order projects PAYMENT_FAILED — ' +
      'never PAID: a payment failure can never mark an order paid.',
  })
  @ApiOkResponse({ description: 'Intent failed (simulated)' })
  @ApiNotFoundResponse({ description: 'Not found in this tenant' })
  @ApiConflictResponse({ description: 'Intent already terminal' })
  fail(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Body() dto: FailIntentDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<PaymentIntentDetail> {
    return this.paymentsService.fail(tenantId, id, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }

  @Patch('intents/:id/bind')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('payment:manage')
  @ApiOperation({
    summary: 'Bind an unlinked intent to an order and/or checkout session',
    description:
      'Associates a standalone (or session-only) intent with an order/session ' +
      'of the caller’s tenant AFTER creation — the walk-out flow: pay first, ' +
      'associate to the eventual order later. Binding to an order projects the ' +
      'intent’s current state onto it (a CAPTURED intent marks the order PAID). ' +
      'Re-binding to the same target replays; a different order/session is a ' +
      '409 conflict.',
  })
  @ApiOkResponse({ description: 'Intent bound (and order projected if linked)' })
  @ApiNotFoundResponse({ description: 'Not found in this tenant' })
  @ApiConflictResponse({
    description: 'Already bound elsewhere, or the linked order is paid/cancelled',
  })
  bind(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Body() dto: BindIntentDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<PaymentIntentDetail> {
    return this.paymentsService.bind(tenantId, id, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }
}
