import {
  InventoryMovementType,
  OrderReturnKind,
  OrderReturnStatus,
  OrderStatus,
  RefundSkipReason,
  UnitOfMeasure,
} from '@prisma/client';
import { AdjustmentRejected } from '../inventory/inventory.repository';
import { ReturnsRepository, ReturnStockRejected } from './returns.repository';

/**
 * The ledger invariant, enforced structurally.
 *
 * `tx.inventoryLevel` is a Proxy that THROWS on any property access. So if
 * this repository ever reaches for the stock projection — to read it, to
 * compute a new quantity from it, or (the real danger) to write one — the test
 * fails with a message naming the property, rather than passing because the
 * mock happened to return undefined. The only way stock may come back is
 * `InventoryRepository.applyMovement`, which is injected and asserted on.
 */
function forbiddenProjection(): Record<string, unknown> {
  return new Proxy(
    {},
    {
      get(_target, property) {
        throw new Error(
          `returns must never touch the stock projection directly ` +
            `(inventoryLevel.${String(property)}); stock changes only through ` +
            `the append-only ledger`,
        );
      },
    },
  );
}

const ORDER_LINE = {
  id: 'ol-1',
  productId: 'prod-1',
  sku: 'SKU-1',
  productName: 'Water 500ml',
  unitOfMeasure: UnitOfMeasure.EACH,
  quantity: 3,
  unitPriceMinor: 250,
  currencyCode: 'SAR',
};

const ORDER = {
  id: 'order-1',
  tenantId: 'tenant-a',
  orderNumber: 'ORD-000001',
  locationId: 'store-1',
  status: OrderStatus.CONFIRMED,
  lines: [ORDER_LINE],
};

function buildHarness(
  options: {
    order?: Record<string, unknown> | null;
    existingReturn?: Record<string, unknown> | null;
    priorReturns?: { orderLineId: string; _sum: { quantity: number } }[];
    applyMovement?: jest.Mock;
    cancelCount?: number;
  } = {},
) {
  const created = {
    id: 'ret-1',
    tenantId: 'tenant-a',
    orderId: 'order-1',
    status: OrderReturnStatus.RECORDED,
  };
  const applyMovement =
    options.applyMovement ??
    jest.fn(async (_tx: unknown, input: { quantityDelta: number }) => ({
      movement: {
        id: `mv-${input.quantityDelta}`,
        quantityDelta: input.quantityDelta,
        productId: 'prod-1',
      },
      level: { quantity: 10 },
    }));
  const tx = {
    $queryRaw: jest.fn(async () => []),
    inventoryLevel: forbiddenProjection(),
    orderReturn: {
      findFirst: jest.fn(async () => options.existingReturn ?? null),
      create: jest.fn(async () => created),
      findUniqueOrThrow: jest.fn(async () => ({ ...created, lines: [] })),
      update: jest.fn(async () => created),
    },
    orderReturnLine: {
      groupBy: jest.fn(async () => options.priorReturns ?? []),
      create: jest.fn(async () => ({ id: 'rl-1' })),
    },
    order: {
      findFirst: jest.fn(async () =>
        options.order === undefined ? ORDER : options.order,
      ),
      updateMany: jest.fn(async () => ({
        count: options.cancelCount ?? 1,
      })),
      findFirstOrThrow: jest.fn(async () => ({
        id: 'order-1',
        status: OrderStatus.CANCELLED,
      })),
    },
  };
  const prisma = {
    $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) =>
      fn(tx),
    ),
  };
  const audit = { record: jest.fn(async () => undefined) };
  const inventory = { applyMovement };
  const repository = new ReturnsRepository(
    prisma as never,
    audit as never,
    inventory as never,
  );
  return { repository, tx, audit, applyMovement };
}

const builders = {
  returnRecorded: () => ({}) as never,
  stockReturned: () => ({}) as never,
  orderCancelled: () => ({}) as never,
};

const baseInput = {
  orderId: 'order-1',
  kind: OrderReturnKind.CUSTOMER_RETURN,
  reference: 'RET-1',
  reason: 'Customer changed their mind',
  lines: [{ orderLineId: 'ol-1', quantity: 2 }],
  refundRequested: true,
};

describe('ReturnsRepository.recordReturn — the ledger is the only way back', () => {
  it('puts returned goods back through a RETURN_IN ledger movement', async () => {
    const { repository, applyMovement } = buildHarness();
    const result = await repository.recordReturn(
      'tenant-a',
      baseInput,
      builders,
    );
    expect(typeof result).toBe('object');
    expect(applyMovement).toHaveBeenCalledTimes(1);
    expect(applyMovement).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tenantId: 'tenant-a',
        locationId: 'store-1',
        productId: 'prod-1',
        // POSITIVE: goods come back in. The sale took them out with a
        // negative delta through this very same method.
        quantityDelta: 2,
        movementType: InventoryMovementType.RETURN_IN,
        referenceType: 'OrderReturn',
        referenceId: 'ret-1',
      }),
    );
  });

  it('revalidates the unit of measure the order line was sold in', async () => {
    const { repository, applyMovement } = buildHarness();
    await repository.recordReturn('tenant-a', baseInput, builders);
    expect(applyMovement).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ expectedUnitOfMeasure: UnitOfMeasure.EACH }),
    );
  });

  it('records the movement id on the line so a restock cannot be unevidenced', async () => {
    const { repository, tx } = buildHarness();
    await repository.recordReturn('tenant-a', baseInput, builders);
    expect(tx.orderReturnLine.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          restocked: true,
          movementId: 'mv-2',
        }),
      }),
    );
  });

  it('writes NO movement for goods that did not go back on the shelf', async () => {
    const { repository, tx, applyMovement } = buildHarness();
    await repository.recordReturn(
      'tenant-a',
      {
        ...baseInput,
        lines: [{ orderLineId: 'ol-1', quantity: 1, restock: false }],
      },
      builders,
    );
    expect(applyMovement).not.toHaveBeenCalled();
    expect(tx.orderReturnLine.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ restocked: false, movementId: null }),
      }),
    );
  });

  it('rolls the whole return back when the ledger refuses the movement', async () => {
    const applyMovement = jest.fn(async () => {
      throw new AdjustmentRejected('product-archived');
    });
    const { repository } = buildHarness({ applyMovement });
    const result = await repository.recordReturn(
      'tenant-a',
      baseInput,
      builders,
    );
    // Returned (not thrown) so the service can map it, but it escaped the
    // transaction by THROWING — which is what rolls the return record back.
    expect(result).toBeInstanceOf(ReturnStockRejected);
    expect((result as ReturnStockRejected).failure).toBe('product-archived');
    expect((result as ReturnStockRejected).sku).toBe('SKU-1');
  });
});

describe('ReturnsRepository.recordReturn — idempotency and tenancy', () => {
  it('replays the original return instead of reversing stock twice', async () => {
    const { repository, applyMovement, tx } = buildHarness({
      existingReturn: { id: 'ret-1', orderId: 'order-1', lines: [] },
    });
    const result = await repository.recordReturn(
      'tenant-a',
      baseInput,
      builders,
    );
    expect(result).toMatchObject({ replayed: true });
    expect(applyMovement).not.toHaveBeenCalled();
    expect(tx.orderReturn.create).not.toHaveBeenCalled();
  });

  it('refuses a reference already used for a different order', async () => {
    const { repository, applyMovement } = buildHarness({
      existingReturn: { id: 'ret-9', orderId: 'order-other', lines: [] },
    });
    const result = await repository.recordReturn(
      'tenant-a',
      baseInput,
      builders,
    );
    expect(result).toBe('reference-mismatch');
    expect(applyMovement).not.toHaveBeenCalled();
  });

  it('scopes the order lookup to the tenant and reverses nothing when absent', async () => {
    const { repository, applyMovement, tx } = buildHarness({ order: null });
    const result = await repository.recordReturn(
      'tenant-b',
      baseInput,
      builders,
    );
    expect(result).toBeNull();
    expect(tx.order.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'order-1', tenantId: 'tenant-b' },
      }),
    );
    expect(applyMovement).not.toHaveBeenCalled();
  });

  it('refuses to return an order that is not CONFIRMED', async () => {
    const { repository, applyMovement } = buildHarness({
      order: { ...ORDER, status: OrderStatus.CANCELLED },
    });
    expect(
      await repository.recordReturn('tenant-a', baseInput, builders),
    ).toBe('order-not-returnable');
    expect(applyMovement).not.toHaveBeenCalled();
  });

  it('takes the per-order reverse-flow and payment locks before deciding', async () => {
    const { repository, tx } = buildHarness();
    await repository.recordReturn('tenant-a', baseInput, builders);
    const locked = (tx.$queryRaw.mock.calls as unknown[][])
      .map((call) => String(call[1] ?? ''))
      .join('|');
    expect(locked).toContain('order-return:tenant-a:order-1');
    expect(locked).toContain('order-payment:tenant-a:order-1');
  });
});

describe('ReturnsRepository.recordReturn — cancellation', () => {
  const cancelInput = {
    ...baseInput,
    kind: OrderReturnKind.ORDER_CANCELLATION,
    lines: null,
    reference: 'CANCEL-1',
  };

  it('reverses every outstanding line and cancels the order in one transaction', async () => {
    const { repository, applyMovement, tx } = buildHarness();
    await repository.recordReturn('tenant-a', cancelInput, builders);
    expect(applyMovement).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ quantityDelta: 3 }),
    );
    expect(tx.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        // The tenant travels IN the write predicate, with the CONFIRMED guard
        // that makes the flip happen at most once.
        where: {
          id: 'order-1',
          tenantId: 'tenant-a',
          status: OrderStatus.CONFIRMED,
        },
      }),
    );
  });

  it('aborts when a concurrent cancellation already took the order', async () => {
    const { repository } = buildHarness({ cancelCount: 0 });
    expect(
      await repository.recordReturn('tenant-a', cancelInput, builders),
    ).toBe('order-cancel-conflict');
  });

  it('marks a stock-only return as NOT_REQUESTED at creation time', async () => {
    const { repository, tx } = buildHarness();
    await repository.recordReturn(
      'tenant-a',
      { ...baseInput, refundRequested: false },
      builders,
    );
    expect(tx.orderReturn.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          refundSkipReason: RefundSkipReason.NOT_REQUESTED,
        }),
      }),
    );
  });
});

describe('ReturnsRepository.linkRefund is the only update, and it is tenant-scoped', () => {
  it('writes through the id_tenantId composite key', async () => {
    const { repository, tx } = buildHarness({
      existingReturn: { id: 'ret-1', orderId: 'order-1', lines: [] },
    });
    await repository.linkRefund(
      'tenant-a',
      'ret-1',
      {
        status: OrderReturnStatus.REFUNDED,
        refundId: 'rf-1',
        refundSkipReason: null,
      },
      () => ({}) as never,
    );
    expect(tx.orderReturn.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id_tenantId: { id: 'ret-1', tenantId: 'tenant-a' } },
      }),
    );
  });

  it('a foreign tenant finds nothing and never reaches the write', async () => {
    const { repository, tx } = buildHarness();
    tx.orderReturn.findFirst.mockResolvedValueOnce(null as never);
    const result = await repository.linkRefund(
      'tenant-b',
      'ret-1',
      {
        status: OrderReturnStatus.REFUNDED,
        refundId: 'rf-1',
        refundSkipReason: null,
      },
      () => ({}) as never,
    );
    expect(result).toBeNull();
    expect(tx.orderReturn.update).not.toHaveBeenCalled();
  });
});
