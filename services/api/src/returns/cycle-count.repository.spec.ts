import { CycleCountStatus, InventoryMovementType } from '@prisma/client';
import { AdjustmentRejected } from '../inventory/inventory.repository';
import {
  CountReconcileRejected,
  CycleCountRepository,
} from './cycle-count.repository';

/**
 * A cycle count is the single most tempting place in the whole system to
 * write `inventoryLevel.update({ quantity: counted })`. It is also the place
 * where doing so would quietly destroy the ledger's authority: stock would
 * have a value nothing in its history explains.
 *
 * So the projection is handed to this repository as a Proxy that allows
 * exactly ONE property — `findFirst`. Reading the projection is the whole
 * point of reconciling (it is the thing being compared). Writing it, in any
 * form, throws with a message naming the method.
 */
function readOnlyProjection(quantity: number | null): Record<string, unknown> {
  return new Proxy(
    {
      findFirst: jest.fn(async () =>
        quantity === null ? null : { quantity },
      ),
    } as Record<string, unknown>,
    {
      get(target, property) {
        if (property === 'findFirst') {
          return target.findFirst;
        }
        throw new Error(
          `a cycle count must never write the stock projection ` +
            `(inventoryLevel.${String(property)}); a variance becomes a ` +
            `ledger movement, never an assigned level`,
        );
      },
    },
  );
}

const COUNT = {
  id: 'cc-1',
  tenantId: 'tenant-a',
  locationId: 'store-1',
  reference: 'CC-2026-01',
  status: CycleCountStatus.OPEN,
  lines: [
    {
      id: 'ccl-1',
      tenantId: 'tenant-a',
      cycleCountId: 'cc-1',
      productId: 'prod-1',
      countedQuantity: 12,
    },
  ],
};

function buildHarness(
  options: {
    count?: Record<string, unknown> | null;
    projected?: number | null;
    ledgerSum?: number | null;
    applyMovement?: jest.Mock;
  } = {},
) {
  const applyMovement =
    options.applyMovement ??
    jest.fn(async (_tx: unknown, input: { quantityDelta: number }) => ({
      movement: {
        id: 'mv-1',
        quantityDelta: input.quantityDelta,
        productId: input.quantityDelta > 0 ? 'prod-1' : 'prod-1',
      },
      level: { quantity: 12 },
    }));
  const tx = {
    $queryRaw: jest.fn(async () => []),
    inventoryLevel: readOnlyProjection(
      options.projected === undefined ? 10 : options.projected,
    ),
    inventoryMovement: {
      aggregate: jest.fn(async () => ({
        _sum: {
          quantityDelta:
            options.ledgerSum === undefined ? 10 : options.ledgerSum,
        },
      })),
    },
    cycleCount: {
      findFirst: jest.fn(async () =>
        options.count === undefined ? COUNT : options.count,
      ),
      update: jest.fn(async () => ({
        ...COUNT,
        status: CycleCountStatus.RECONCILED,
      })),
      findUniqueOrThrow: jest.fn(async () => ({
        ...COUNT,
        status: CycleCountStatus.RECONCILED,
      })),
      create: jest.fn(async () => COUNT),
    },
    cycleCountLine: {
      update: jest.fn(async () => ({ id: 'ccl-1' })),
      upsert: jest.fn(async () => ({ id: 'ccl-1' })),
      count: jest.fn(async () => 0),
      findFirst: jest.fn(async () => null),
    },
    location: { findFirst: jest.fn(async () => ({ id: 'store-1' })) },
    product: { findFirst: jest.fn(async () => ({ id: 'prod-1' })) },
  };
  const prisma = {
    $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) =>
      fn(tx),
    ),
  };
  const audit = { record: jest.fn(async () => undefined) };
  const repository = new CycleCountRepository(
    prisma as never,
    audit as never,
    { applyMovement } as never,
  );
  return { repository, tx, audit, applyMovement };
}

const builders = {
  varianceCorrected: () => ({}) as never,
  countReconciled: () => ({}) as never,
};

describe('CycleCountRepository.reconcile — a count never sets stock', () => {
  it('turns a surplus into a CORRECTION_IN ledger movement', async () => {
    const { repository, applyMovement } = buildHarness({
      projected: 10,
      ledgerSum: 10,
    });
    await repository.reconcile('tenant-a', 'cc-1', 'user-1', builders);
    expect(applyMovement).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tenantId: 'tenant-a',
        locationId: 'store-1',
        productId: 'prod-1',
        // A signed DELTA (12 counted - 10 projected), not the counted figure.
        quantityDelta: 2,
        movementType: InventoryMovementType.CORRECTION_IN,
        referenceType: 'CycleCount',
        referenceId: 'cc-1',
      }),
    );
  });

  it('turns a shortfall into a CORRECTION_OUT ledger movement', async () => {
    const { repository, applyMovement } = buildHarness({
      projected: 15,
      ledgerSum: 15,
    });
    await repository.reconcile('tenant-a', 'cc-1', 'user-1', builders);
    expect(applyMovement).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        quantityDelta: -3,
        movementType: InventoryMovementType.CORRECTION_OUT,
      }),
    );
  });

  it('writes no movement at all when the count agrees with the books', async () => {
    const { repository, applyMovement, tx } = buildHarness({
      projected: 12,
      ledgerSum: 12,
    });
    await repository.reconcile('tenant-a', 'cc-1', 'user-1', builders);
    expect(applyMovement).not.toHaveBeenCalled();
    expect(tx.cycleCountLine.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          varianceQuantity: 0,
          movementId: null,
        }),
      }),
    );
  });

  it('records projection-vs-ledger drift instead of absorbing it', async () => {
    // The projection says 10, its own history replays to 8. The variance the
    // operator caused is still 12 - 10 = 2; the missing 2 is a PLATFORM
    // problem and is reported separately, never folded in.
    const { repository, tx, applyMovement } = buildHarness({
      projected: 10,
      ledgerSum: 8,
    });
    await repository.reconcile('tenant-a', 'cc-1', 'user-1', builders);
    expect(applyMovement).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ quantityDelta: 2 }),
    );
    expect(tx.cycleCountLine.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          systemQuantity: 10,
          ledgerQuantity: 8,
          varianceQuantity: 2,
          ledgerDriftQuantity: 2,
        }),
      }),
    );
  });

  it('treats a product with no projection row as zero on hand', async () => {
    const { repository, applyMovement } = buildHarness({
      projected: null,
      ledgerSum: null,
    });
    await repository.reconcile('tenant-a', 'cc-1', 'user-1', builders);
    expect(applyMovement).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ quantityDelta: 12 }),
    );
  });

  it('takes the count lock and the per-product stock lock before comparing', async () => {
    const { repository, tx } = buildHarness();
    await repository.reconcile('tenant-a', 'cc-1', 'user-1', builders);
    const locked = (tx.$queryRaw.mock.calls as unknown[][])
      .map((call) => String(call[1] ?? ''))
      .join('|');
    expect(locked).toContain('cycle-count:tenant-a:cc-1');
    expect(locked).toContain('product-stock:tenant-a:prod-1');
  });

  it('writes the reconciled line through the id_tenantId composite key', async () => {
    const { repository, tx } = buildHarness();
    await repository.reconcile('tenant-a', 'cc-1', 'user-1', builders);
    expect(tx.cycleCountLine.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id_tenantId: { id: 'ccl-1', tenantId: 'tenant-a' } },
      }),
    );
    expect(tx.cycleCount.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id_tenantId: { id: 'cc-1', tenantId: 'tenant-a' } },
      }),
    );
  });

  it('rolls the whole reconciliation back when the ledger refuses a correction', async () => {
    const applyMovement = jest.fn(async () => {
      throw new AdjustmentRejected('insufficient-stock');
    });
    const { repository } = buildHarness({ projected: 20, applyMovement });
    const result = await repository.reconcile(
      'tenant-a',
      'cc-1',
      'user-1',
      builders,
    );
    expect(result).toBeInstanceOf(CountReconcileRejected);
    expect((result as CountReconcileRejected).failure).toBe(
      'insufficient-stock',
    );
  });

  it.each([
    ['a count from another tenant', null, null],
    ['an already reconciled count', { ...COUNT, status: CycleCountStatus.RECONCILED }, 'not-open'],
    ['a count with nothing recorded', { ...COUNT, lines: [] }, 'no-lines'],
  ])('refuses %s without touching the ledger', async (_label, count, expected) => {
    const { repository, applyMovement } = buildHarness({
      count: count as Record<string, unknown> | null,
    });
    expect(
      await repository.reconcile('tenant-a', 'cc-1', 'user-1', builders),
    ).toBe(expected);
    expect(applyMovement).not.toHaveBeenCalled();
  });
});

describe('CycleCountRepository.recordLine', () => {
  it('upserts through a composite key that carries the tenant', async () => {
    const { repository, tx } = buildHarness();
    await repository.recordLine(
      'tenant-a',
      'cc-1',
      { productId: 'prod-1', countedQuantity: 7 },
      () => ({}) as never,
    );
    expect(tx.cycleCountLine.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId_cycleCountId_productId: {
            tenantId: 'tenant-a',
            cycleCountId: 'cc-1',
            productId: 'prod-1',
          },
        },
      }),
    );
  });

  it('refuses to record against a count that is no longer open', async () => {
    const { repository, tx } = buildHarness({
      count: { ...COUNT, status: CycleCountStatus.RECONCILED },
    });
    expect(
      await repository.recordLine(
        'tenant-a',
        'cc-1',
        { productId: 'prod-1', countedQuantity: 7 },
        () => ({}) as never,
      ),
    ).toBe('not-open');
    expect(tx.cycleCountLine.upsert).not.toHaveBeenCalled();
  });

  it('refuses a product that does not exist in this tenant', async () => {
    const { repository, tx } = buildHarness();
    tx.product.findFirst.mockResolvedValueOnce(null as never);
    expect(
      await repository.recordLine(
        'tenant-a',
        'cc-1',
        { productId: 'prod-elsewhere', countedQuantity: 7 },
        () => ({}) as never,
      ),
    ).toBe('product-not-found');
    expect(tx.cycleCountLine.upsert).not.toHaveBeenCalled();
  });
});
