import { Body, Controller, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Supplier, SupplierProduct } from '@prisma/client';
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
import { CancelPurchaseOrderDto } from './dto/cancel-purchase-order.dto';
import { CreatePurchaseOrderDto } from './dto/create-purchase-order.dto';
import { CreateSupplierDto } from './dto/create-supplier.dto';
import { PostGoodsReceiptDto } from './dto/post-goods-receipt.dto';
import {
  QueryGoodsReceiptsDto,
  QueryPurchaseOrdersDto,
  QuerySupplierProductsDto,
  QuerySuppliersDto,
} from './dto/query-procurement.dto';
import { SubmitPurchaseOrderDto } from './dto/submit-purchase-order.dto';
import { UpdateSupplierDto } from './dto/update-supplier.dto';
import { UpsertSupplierProductDto } from './dto/upsert-supplier-product.dto';
import { PROCUREMENT_MODULE_CODE } from './procurement.constants';
import {
  GoodsReceiptDetail,
  SupplierProductWithRefs,
} from './procurement.repository';
import { ProcurementService, PurchaseOrderView } from './procurement.service';

// Tenant context comes exclusively from the authenticated user via
// @CurrentTenantId(); a tenantId in the body is rejected by the global
// whitelist ValidationPipe.

@ApiTags('procurement')
@ApiBearerAuth()
@TenantOnly()
@RequireModule(PROCUREMENT_MODULE_CODE)
@Controller('suppliers')
export class SuppliersController {
  constructor(private readonly procurement: ProcurementService) {}

  @Get()
  @RequirePermissions('supplier:read')
  @ApiOperation({ summary: 'List suppliers in the caller tenant' })
  list(
    @CurrentTenantId() tenantId: string,
    @Query() query: QuerySuppliersDto,
  ): Promise<{ items: Supplier[]; total: number }> {
    return this.procurement.findSuppliers(tenantId, query);
  }

  @Post()
  @RequirePermissions('supplier:manage')
  @ApiOperation({ summary: 'Create a supplier' })
  @ApiCreatedResponse({ description: 'Supplier created' })
  @ApiConflictResponse({ description: 'The code is already used' })
  create(
    @CurrentTenantId() tenantId: string,
    @Body() dto: CreateSupplierDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<Supplier> {
    return this.procurement.createSupplier(tenantId, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }

  @Get(':id')
  @RequirePermissions('supplier:read')
  @ApiOperation({ summary: 'Read one supplier' })
  @ApiNotFoundResponse({ description: 'No such supplier in this tenant' })
  findOne(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
  ): Promise<Supplier> {
    return this.procurement.findSupplierById(tenantId, id);
  }

  @Patch(':id')
  @RequirePermissions('supplier:manage')
  @ApiOperation({
    summary: 'Update a supplier, or archive it',
    description:
      'Archiving is a status change, not a delete: existing purchase orders ' +
      'keep pointing at the supplier, but no new order may be raised on it.',
  })
  update(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Body() dto: UpdateSupplierDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<Supplier> {
    return this.procurement.updateSupplier(tenantId, id, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }

  @Put(':id/products')
  @RequirePermissions('supplier:manage')
  @ApiOperation({
    summary: 'Set what this supplier charges for a product',
    description:
      'Changing a cost appends a history row rather than overwriting the ' +
      'old figure, so purchase cost is auditable the way retail price is.',
  })
  upsertProduct(
    @CurrentTenantId() tenantId: string,
    @Param('id') supplierId: string,
    @Body() dto: UpsertSupplierProductDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<SupplierProduct> {
    return this.procurement.upsertSupplierProduct(tenantId, supplierId, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }
}

@ApiTags('procurement')
@ApiBearerAuth()
@TenantOnly()
@RequireModule(PROCUREMENT_MODULE_CODE)
@Controller('supplier-products')
export class SupplierProductsController {
  constructor(private readonly procurement: ProcurementService) {}

  @Get()
  @RequirePermissions('supplier:read')
  @ApiOperation({ summary: 'List supplier product links and their costs' })
  list(
    @CurrentTenantId() tenantId: string,
    @Query() query: QuerySupplierProductsDto,
  ): Promise<{ items: SupplierProductWithRefs[]; total: number }> {
    return this.procurement.findSupplierProducts(tenantId, query);
  }
}

@ApiTags('procurement')
@ApiBearerAuth()
@TenantOnly()
@RequireModule(PROCUREMENT_MODULE_CODE)
@Controller('purchase-orders')
export class PurchaseOrdersController {
  constructor(private readonly procurement: ProcurementService) {}

  @Get()
  @RequirePermissions('purchase-order:read')
  @ApiOperation({
    summary: 'List purchase orders',
    description:
      'Every line carries what has actually arrived, derived from the goods ' +
      'receipts posted against it — there is no stored received counter.',
  })
  list(
    @CurrentTenantId() tenantId: string,
    @Query() query: QueryPurchaseOrdersDto,
  ): Promise<{ items: PurchaseOrderView[]; total: number }> {
    return this.procurement.findPurchaseOrders(tenantId, query);
  }

  @Post()
  @RequirePermissions('purchase-order:manage')
  @ApiOperation({ summary: 'Create a DRAFT purchase order' })
  @ApiCreatedResponse({ description: 'Purchase order created' })
  create(
    @CurrentTenantId() tenantId: string,
    @Body() dto: CreatePurchaseOrderDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<PurchaseOrderView> {
    return this.procurement.createPurchaseOrder(tenantId, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }

  @Get(':id')
  @RequirePermissions('purchase-order:read')
  @ApiOperation({ summary: 'Read one purchase order with its receipts' })
  @ApiNotFoundResponse({ description: 'No such order in this tenant' })
  findOne(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
  ): Promise<PurchaseOrderView> {
    return this.procurement.findPurchaseOrderById(tenantId, id);
  }

  @Post(':id/submit')
  @RequirePermissions('purchase-order:manage')
  @ApiOperation({
    summary: 'Send a DRAFT order to its supplier',
    description:
      'The supplier adapter runs before anything is written, so a rejected ' +
      'order stays in DRAFT where it can be corrected and resent.',
  })
  @ApiConflictResponse({
    description: 'The order is not DRAFT, or the supplier rejected it',
  })
  submit(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Body() dto: SubmitPurchaseOrderDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<PurchaseOrderView> {
    return this.procurement.submitPurchaseOrder(tenantId, id, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }

  @Post(':id/cancel')
  @RequirePermissions('purchase-order:manage')
  @ApiOperation({
    summary: 'Cancel an order that has not been fully received',
    description:
      'Stock already received stays received: the ledger is append-only, so ' +
      'a cancellation closes the order without unwinding any movement.',
  })
  cancel(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Body() dto: CancelPurchaseOrderDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<PurchaseOrderView> {
    return this.procurement.cancelPurchaseOrder(tenantId, id, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }

  @Post(':id/receipts')
  @RequirePermissions('goods-receipt:manage')
  @ApiOperation({
    summary: 'Record what physically arrived',
    description:
      'Every accepted unit becomes a RECEIPT movement on the append-only ' +
      'inventory ledger inside one transaction. Supply an idempotency key ' +
      'so a retried post returns the original receipt instead of stocking ' +
      'the delivery twice.',
  })
  @ApiCreatedResponse({ description: 'Goods receipt posted' })
  @ApiConflictResponse({
    description:
      'The order cannot receive goods, the key was reused, or the ledger ' +
      'rejected the movement',
  })
  receive(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Body() dto: PostGoodsReceiptDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<GoodsReceiptDetail> {
    return this.procurement.postGoodsReceipt(tenantId, id, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }
}

@ApiTags('procurement')
@ApiBearerAuth()
@TenantOnly()
@RequireModule(PROCUREMENT_MODULE_CODE)
@Controller('goods-receipts')
export class GoodsReceiptsController {
  constructor(private readonly procurement: ProcurementService) {}

  @Get()
  @RequirePermissions('goods-receipt:read')
  @ApiOperation({ summary: 'List goods receipts' })
  list(
    @CurrentTenantId() tenantId: string,
    @Query() query: QueryGoodsReceiptsDto,
  ): Promise<{ items: GoodsReceiptDetail[]; total: number }> {
    return this.procurement.findGoodsReceipts(tenantId, query);
  }

  @Get(':id/movements')
  @RequirePermissions('goods-receipt:read')
  @ApiOperation({
    summary: 'Ledger movements this receipt produced',
    description:
      'Read straight from the inventory ledger, so what the UI shows cannot ' +
      'disagree with what actually moved.',
  })
  movements(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
  ): Promise<
    {
      id: string;
      productId: string;
      quantityDelta: number;
      quantityAfter: number;
      createdAt: Date;
    }[]
  > {
    return this.procurement.findReceiptMovements(tenantId, id);
  }
}
