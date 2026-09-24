import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  REQUIRED_MODULE_KEY,
  REQUIRED_PERMISSIONS_KEY,
  TENANT_ONLY_KEY,
} from '../auth/decorators/access-policy.decorators';
import { CreatePurchaseOrderDto } from './dto/create-purchase-order.dto';
import { CreateSupplierDto } from './dto/create-supplier.dto';
import { PostGoodsReceiptDto } from './dto/post-goods-receipt.dto';
import {
  GoodsReceiptsController,
  PurchaseOrdersController,
  SupplierProductsController,
  SuppliersController,
} from './procurement.controller';

/**
 * Access-policy pin for the procurement surface. Receiving is the only route
 * in this module that moves stock, so its permission is asserted separately
 * from the read and ordering permissions rather than assumed.
 */
describe('procurement controllers access policy', () => {
  it.each([
    ['SuppliersController', SuppliersController],
    ['SupplierProductsController', SupplierProductsController],
    ['PurchaseOrdersController', PurchaseOrdersController],
    ['GoodsReceiptsController', GoodsReceiptsController],
  ])('%s is tenant-only and gated on the procurement module', (_n, target) => {
    expect(Reflect.getMetadata(TENANT_ONLY_KEY, target)).toBe(true);
    expect(Reflect.getMetadata(REQUIRED_MODULE_KEY, target)).toBe(
      'procurement',
    );
  });

  it.each([
    ['list', ['supplier:read']],
    ['findOne', ['supplier:read']],
    ['create', ['supplier:manage']],
    ['update', ['supplier:manage']],
    ['upsertProduct', ['supplier:manage']],
  ] as const)('gates SuppliersController.%s', (handler, expected) => {
    expect(
      Reflect.getMetadata(
        REQUIRED_PERMISSIONS_KEY,
        SuppliersController.prototype[handler],
      ),
    ).toEqual(expected);
  });

  it.each([
    ['list', ['purchase-order:read']],
    ['findOne', ['purchase-order:read']],
    ['create', ['purchase-order:manage']],
    ['submit', ['purchase-order:manage']],
    ['cancel', ['purchase-order:manage']],
  ] as const)('gates PurchaseOrdersController.%s', (handler, expected) => {
    expect(
      Reflect.getMetadata(
        REQUIRED_PERMISSIONS_KEY,
        PurchaseOrdersController.prototype[handler],
      ),
    ).toEqual(expected);
  });

  it('gates receiving behind its own permission, not the ordering one', () => {
    expect(
      Reflect.getMetadata(
        REQUIRED_PERMISSIONS_KEY,
        PurchaseOrdersController.prototype.receive,
      ),
    ).toEqual(['goods-receipt:manage']);
  });

  it('gates receipt reads behind goods-receipt:read', () => {
    for (const handler of ['list', 'movements'] as const) {
      expect(
        Reflect.getMetadata(
          REQUIRED_PERMISSIONS_KEY,
          GoodsReceiptsController.prototype[handler],
        ),
      ).toEqual(['goods-receipt:read']);
    }
  });
});

describe('procurement controllers delegate with the caller tenant', () => {
  const procurement = {
    findSuppliers: jest.fn(async () => ({ items: [], total: 0 })),
    createSupplier: jest.fn(async () => ({ id: 'supplier-1' })),
    postGoodsReceipt: jest.fn(async () => ({ id: 'receipt-1' })),
  };
  const suppliers = new SuppliersController(procurement as never);
  const orders = new PurchaseOrdersController(procurement as never);

  beforeEach(() => jest.clearAllMocks());

  it('passes the authenticated tenant, never one from the body', async () => {
    await suppliers.list('tenant-1', {});
    expect(procurement.findSuppliers).toHaveBeenCalledWith('tenant-1', {});
  });

  it('passes the authenticated actor to mutations', async () => {
    await suppliers.create(
      'tenant-1',
      { code: 'ACME', name: 'Acme' },
      { userId: 'user-9', email: 'ops@example.com' } as never,
    );
    expect(procurement.createSupplier).toHaveBeenCalledWith(
      'tenant-1',
      { code: 'ACME', name: 'Acme' },
      { id: 'user-9', email: 'ops@example.com' },
    );
  });

  it('routes receiving through the order it belongs to', async () => {
    await orders.receive(
      'tenant-1',
      'order-1',
      { lines: [{ purchaseOrderLineId: 'line-1', quantityReceived: 1 }] },
      { userId: 'user-9', email: 'ops@example.com' } as never,
    );
    expect(procurement.postGoodsReceipt).toHaveBeenCalledWith(
      'tenant-1',
      'order-1',
      { lines: [{ purchaseOrderLineId: 'line-1', quantityReceived: 1 }] },
      { id: 'user-9', email: 'ops@example.com' },
    );
  });
});

describe('procurement DTO validation', () => {
  async function errors(cls: never, payload: unknown): Promise<string[]> {
    const instance = plainToInstance(cls, payload);
    const result = await validate(instance as object, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    return result.flatMap((error) => [
      error.property,
      ...(error.children ?? []).flatMap((child) =>
        (child.children ?? []).map((grand) => grand.property),
      ),
    ]);
  }

  it('accepts a well-formed supplier', async () => {
    expect(
      await errors(CreateSupplierDto as never, {
        code: 'ACME',
        name: 'Acme Trading',
        contactEmail: 'orders@acme.example',
        leadTimeDays: 5,
      }),
    ).toEqual([]);
  });

  it('rejects a supplier code with illegal characters', async () => {
    expect(
      await errors(CreateSupplierDto as never, {
        code: 'ACME CORP!',
        name: 'Acme',
      }),
    ).toContain('code');
  });

  it('rejects a tenantId smuggled into the body', async () => {
    expect(
      await errors(CreateSupplierDto as never, {
        code: 'ACME',
        name: 'Acme',
        tenantId: 'tenant-2',
      }),
    ).toContain('tenantId');
  });

  it('requires at least one line on a purchase order', async () => {
    expect(
      await errors(CreatePurchaseOrderDto as never, {
        supplierId: 's1',
        locationId: 'l1',
        currencyCode: 'AED',
        lines: [],
      }),
    ).toContain('lines');
  });

  it('rejects a zero-quantity order line', async () => {
    expect(
      await errors(CreatePurchaseOrderDto as never, {
        supplierId: 's1',
        locationId: 'l1',
        currencyCode: 'AED',
        lines: [{ productId: 'p1', quantityOrdered: 0 }],
      }),
    ).toContain('quantityOrdered');
  });

  it('rejects a currency code that is not three letters', async () => {
    expect(
      await errors(CreatePurchaseOrderDto as never, {
        supplierId: 's1',
        locationId: 'l1',
        currencyCode: 'AEDX',
        lines: [{ productId: 'p1', quantityOrdered: 1 }],
      }),
    ).toContain('currencyCode');
  });

  it('accepts a receipt line that received nothing', async () => {
    expect(
      await errors(PostGoodsReceiptDto as never, {
        lines: [{ purchaseOrderLineId: 'line-1', quantityReceived: 0 }],
      }),
    ).toEqual([]);
  });

  it('rejects a negative received quantity', async () => {
    expect(
      await errors(PostGoodsReceiptDto as never, {
        lines: [{ purchaseOrderLineId: 'line-1', quantityReceived: -1 }],
      }),
    ).toContain('quantityReceived');
  });

  it('rejects a discrepancy outside the closed vocabulary', async () => {
    expect(
      await errors(PostGoodsReceiptDto as never, {
        lines: [
          {
            purchaseOrderLineId: 'line-1',
            quantityReceived: 1,
            discrepancy: 'LOST_AT_SEA',
          },
        ],
      }),
    ).toContain('discrepancy');
  });
});
