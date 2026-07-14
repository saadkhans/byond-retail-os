import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CheckoutSessionLine } from '@prisma/client';
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
  CheckoutSessionDetail,
  CheckoutSessionWithRefs,
  CompletedOrder,
} from './checkout-sessions.repository';
import { CheckoutSessionsService } from './checkout-sessions.service';
import { AddSessionLineDto } from './dto/add-session-line.dto';
import { CompleteSessionDto } from './dto/complete-session.dto';
import { CreateCheckoutSessionDto } from './dto/create-checkout-session.dto';
import { QueryCheckoutSessionsDto } from './dto/query-checkout-sessions.dto';
import { UpdateSessionStatusDto } from './dto/update-session-status.dto';
import { UpdateSessionLineDto } from './dto/update-session-line.dto';

@ApiTags('checkout-sessions')
@ApiBearerAuth()
@TenantOnly()
@RequireModule('checkout')
@Controller('checkout-sessions')
export class CheckoutSessionsController {
  constructor(private readonly sessionsService: CheckoutSessionsService) {}

  @Post()
  @RequirePermissions('checkout:manage')
  @ApiOperation({
    summary: 'Open a checkout session on a store/unit',
    description:
      'The unit must belong to the store, both in the caller’s tenant. ' +
      'Evidence/source fields are vendor-neutral placeholders for future ' +
      'CV/VLM adapters. Retrying with the same idempotencyKey returns the ' +
      'original session.',
  })
  @ApiCreatedResponse({ description: 'Session opened (status OPEN)' })
  create(
    @CurrentTenantId() tenantId: string,
    @Body() dto: CreateCheckoutSessionDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<CheckoutSessionDetail> {
    return this.sessionsService.create(tenantId, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }

  @Get()
  @RequirePermissions('checkout:read')
  @ApiOperation({
    summary: 'List checkout sessions in the caller’s tenant',
    description:
      'Filters: status, store, unit. Deterministic ordering (newest first, ' +
      'id tie-breaker), paginated via skip/take.',
  })
  search(
    @CurrentTenantId() tenantId: string,
    @Query() query: QueryCheckoutSessionsDto,
  ): Promise<{
    items: CheckoutSessionWithRefs[];
    total: number;
    skip: number;
    take: number;
  }> {
    return this.sessionsService.search(tenantId, query);
  }

  @Get(':id')
  @RequirePermissions('checkout:read')
  @ApiOperation({
    summary: 'Get a checkout session with its basket lines',
    description:
      'Includes the order reference once the session has been completed.',
  })
  @ApiNotFoundResponse({ description: 'Not found in this tenant' })
  findById(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
  ): Promise<CheckoutSessionDetail> {
    return this.sessionsService.findById(tenantId, id);
  }

  @Patch(':id/status')
  @RequirePermissions('checkout:manage')
  @ApiOperation({
    summary: 'Transition a session’s lifecycle status',
    description:
      'Legal transitions: OPEN → ACTIVE/PENDING_REVIEW, ACTIVE ↔ ' +
      'PENDING_REVIEW, and any non-terminal state → CANCELLED/EXPIRED. ' +
      'COMPLETED is only reachable via /complete. Terminal sessions reject ' +
      'every transition.',
  })
  @ApiNotFoundResponse({ description: 'Not found in this tenant' })
  @ApiConflictResponse({ description: 'Illegal transition or terminal state' })
  updateStatus(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Body() dto: UpdateSessionStatusDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<CheckoutSessionDetail> {
    return this.sessionsService.updateStatus(tenantId, id, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }

  @Post(':id/lines')
  @RequirePermissions('checkout:manage')
  @ApiOperation({
    summary: 'Add a basket line to a session',
    description:
      'The product must be ACTIVE in the caller’s tenant; its SKU, name, ' +
      'and unit of measure are snapshotted onto the line. One line per ' +
      'product per session — update the existing line to change quantity. ' +
      'Pricing fields remain null until the pricing/payment phases.',
  })
  @ApiCreatedResponse({ description: 'Line added' })
  @ApiNotFoundResponse({ description: 'Session or product not found' })
  @ApiConflictResponse({
    description: 'Terminal session, duplicate product line, or non-ACTIVE product',
  })
  addLine(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Body() dto: AddSessionLineDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<CheckoutSessionLine> {
    return this.sessionsService.addLine(tenantId, id, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }

  @Patch(':id/lines/:lineId')
  @RequirePermissions('checkout:manage')
  @ApiOperation({
    summary: 'Update a basket line (quantity and/or evidence references)',
  })
  @ApiNotFoundResponse({ description: 'Session or line not found' })
  @ApiConflictResponse({ description: 'Session is in a terminal state' })
  updateLine(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body() dto: UpdateSessionLineDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<CheckoutSessionLine> {
    return this.sessionsService.updateLine(tenantId, id, lineId, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }

  @Delete(':id/lines/:lineId')
  @HttpCode(204)
  @RequirePermissions('checkout:manage')
  @ApiOperation({ summary: 'Remove a basket line from a session' })
  @ApiNoContentResponse({ description: 'Line removed' })
  @ApiNotFoundResponse({ description: 'Session or line not found' })
  @ApiConflictResponse({ description: 'Session is in a terminal state' })
  async removeLine(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @CurrentUser() actor: RequestContext,
  ): Promise<void> {
    await this.sessionsService.removeLine(tenantId, id, lineId, {
      id: actor.userId,
      email: actor.email,
    });
  }

  @Post(':id/complete')
  @RequirePermissions('checkout:manage')
  @ApiOperation({
    summary: 'Complete a session into a CONFIRMED order, consuming inventory',
    description:
      'Atomic: the order, its snapshot lines, one SALE ledger movement per ' +
      'line (referenceType "Order"), the stock decrements, and the session ' +
      'flip to COMPLETED commit or roll back together — insufficient stock ' +
      'on any line rejects the whole completion and no order is created. ' +
      'CONFIRMED does NOT mean paid: payment capture arrives in a later ' +
      'phase. Retrying with the same idempotencyKey returns the same order ' +
      'without consuming inventory again.',
  })
  @ApiCreatedResponse({ description: 'Order created (or replayed by key)' })
  @ApiNotFoundResponse({ description: 'Session not found in this tenant' })
  @ApiConflictResponse({
    description:
      'Insufficient stock, empty basket, terminal session, or duplicate completion without the original key',
  })
  complete(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Body() dto: CompleteSessionDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<CompletedOrder> {
    return this.sessionsService.complete(tenantId, id, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }
}
