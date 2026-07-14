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
import { CancelOrderDto } from './dto/cancel-order.dto';
import { QueryOrdersDto } from './dto/query-orders.dto';
import {
  OrderDetail,
  OrderWithRefs,
} from './orders.repository';
import { OrdersService } from './orders.service';

@ApiTags('orders')
@ApiBearerAuth()
@TenantOnly()
@RequireModule('checkout')
@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Get()
  @RequirePermissions('order:read')
  @ApiOperation({
    summary: 'List orders in the caller’s tenant',
    description:
      'Filters: status, store, unit, exact order number. Deterministic ' +
      'ordering (newest first, id tie-breaker), paginated via skip/take. ' +
      'Pricing/totals fields are null placeholders — Phase 5 orders carry ' +
      'no payment state.',
  })
  search(
    @CurrentTenantId() tenantId: string,
    @Query() query: QueryOrdersDto,
  ): Promise<{
    items: OrderWithRefs[];
    total: number;
    skip: number;
    take: number;
  }> {
    return this.ordersService.search(tenantId, query);
  }

  @Get(':id')
  @RequirePermissions('order:read')
  @ApiOperation({
    summary: 'Get an order with its snapshot lines',
    description:
      'Lines snapshot the product (SKU, name, unit) as it was in the ' +
      'basket, keep sessionLineId lineage back to the checkout session, ' +
      'and carry the vendor-neutral evidence references.',
  })
  @ApiNotFoundResponse({ description: 'Not found in this tenant' })
  findById(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
  ): Promise<OrderDetail> {
    return this.ordersService.findById(tenantId, id);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('order:manage')
  @ApiOperation({
    summary: 'Cancel an order (status change only)',
    description:
      'Phase 5 cancellation does NOT reverse the inventory consumed at ' +
      'completion — stock reversal ships with the returns/refunds phase.',
  })
  @ApiOkResponse({ description: 'Order cancelled' })
  @ApiNotFoundResponse({ description: 'Not found in this tenant' })
  @ApiConflictResponse({ description: 'Order is already cancelled' })
  cancel(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Body() dto: CancelOrderDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<OrderDetail> {
    return this.ordersService.cancel(tenantId, id, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }
}
