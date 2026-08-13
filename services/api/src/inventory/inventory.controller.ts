import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { InventoryMovement } from '@prisma/client';
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
import { AdjustStockDto } from './dto/adjust-stock.dto';
import { RecordMovementDto } from './dto/record-movement.dto';
import { QueryLevelsDto, QueryMovementsDto } from './dto/query-inventory.dto';
import { AdjustmentResult } from './inventory.repository';
import { InventoryService, StockLevelView } from './inventory.service';

// Tenant context comes exclusively from the authenticated user via
// @CurrentTenantId(). A tenantId in the request body is rejected by the
// global whitelist ValidationPipe (forbidNonWhitelisted).
@ApiTags('inventory')
@ApiBearerAuth()
@TenantOnly()
@RequireModule('inventory')
@Controller('inventory')
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  @Get('levels')
  @RequirePermissions('inventory:read')
  @ApiOperation({
    summary: 'List stock levels in the caller’s tenant',
    description:
      'Per tenant/location/product on-hand quantities (projected from the ' +
      'append-only movement ledger). Supports location/product filters and ' +
      'lowStockOnly=true to list only levels at or below the product’s ' +
      'low-stock threshold.',
  })
  getLevels(
    @CurrentTenantId() tenantId: string,
    @Query() query: QueryLevelsDto,
  ): Promise<StockLevelView[]> {
    return this.inventoryService.getLevels(tenantId, query);
  }

  @Get('movements')
  @RequirePermissions('inventory:read')
  @ApiOperation({
    summary: 'Read the inventory movement ledger',
    description:
      'Immutable, append-only history of every stock change, newest first. ' +
      'Paginated via skip/take.',
  })
  getMovements(
    @CurrentTenantId() tenantId: string,
    @Query() query: QueryMovementsDto,
  ): Promise<{ items: InventoryMovement[]; total: number }> {
    return this.inventoryService.getMovements(tenantId, query);
  }

  @Post('adjustments')
  @RequirePermissions('inventory:adjust')
  @ApiOperation({
    summary: 'Manually adjust stock for a product at a location',
    description:
      'Appends an immutable movement to the inventory ledger and updates ' +
      'the projected stock level atomically; the adjustment is also written ' +
      'to the audit log. Stock can never go below zero.',
  })
  @ApiCreatedResponse({ description: 'Movement recorded, level updated' })
  @ApiNotFoundResponse({
    description: 'Location or product not found in this tenant',
  })
  @ApiConflictResponse({
    description: 'Would take stock below zero, or product is archived',
  })
  adjust(
    @CurrentTenantId() tenantId: string,
    @Body() dto: AdjustStockDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<AdjustmentResult> {
    return this.inventoryService.adjustStock(tenantId, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }

  @Post('movements')
  @RequirePermissions('inventory:adjust')
  @ApiOperation({
    summary:
      'Record an external inventory movement (RECEIPT / CORRECTION_IN / ' +
      'CORRECTION_OUT), idempotent by reference',
    description:
      'Appends exactly one immutable ledger movement per unique reference: ' +
      'retrying the same reference REPLAYS the recorded movement instead ' +
      'of stocking twice. Quantities are positive; the movement type ' +
      'carries the direction. Stock can never go below zero.',
  })
  @ApiCreatedResponse({ description: 'Movement recorded (or replayed)' })
  @ApiNotFoundResponse({
    description: 'Location or product not found in this tenant',
  })
  @ApiConflictResponse({
    description: 'Would take stock below zero, or product is archived',
  })
  recordMovement(
    @CurrentTenantId() tenantId: string,
    @Body() dto: RecordMovementDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<AdjustmentResult & { replayed: boolean }> {
    return this.inventoryService.recordMovement(tenantId, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }
}
