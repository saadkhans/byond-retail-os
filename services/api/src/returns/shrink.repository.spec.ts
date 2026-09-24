import {
  InventoryMovementType,
  OrderStatus,
  ShrinkSource,
  VisionEventStatus,
  VisionEventType,
} from '@prisma/client';
import { AdjustmentRejected } from '../inventory/inventory.repository';
import { ShrinkRepository, ShrinkStockRejected } from './shrink.repository';

/** Same structural rule as every other reverse-flow path: no projection writes. */
function forbiddenProjection(): Record<string, unknown> {
  return new Proxy(
    {},
    {
      get(_target, property) {
        throw new Error(
          `a write-off must never touch the stock projection directly ` +
            `(inventoryLevel.${String(property)}); it appends a SHRINK ` +
            `movement to the ledger`,
        );
      },
    },
  );
}

const OBSERVATION = {
  id: 've-1',
  locationId: 'store-1',
  sessionId: null as string | null,
  type: VisionEventType.PRODUCT_PICKUP,
  status: VisionEventStatus.APPROVED,
  quantity: 2,
  candidates: [{ productId: 'prod-1' }],
};

function buildHarness(
  options: {
    observation?: Record<string, unknown> | null;
    existing?: Record<string, unknown> | null;
    order?: Record<string, unknown> | null;
    applyMovement?: jest.Mock;
  } = {},
) {
  const applyMovement =
    options.applyMovement ??
    jest.fn(async (_tx: unknown, input: { quantityDelta: number }) => ({
      movement: {
        id: 'mv-shrink',
        quantityDelta: input.quantityDelta,
        productId: 'prod-1',
      },
      level: { quantity: 3 },
    }));
  const tx = {
    $queryRaw: jest.fn(async () => []),
    inventoryLevel: forbiddenProjection(),
    shrinkEvent: {
      findFirst: jest.fn(async () => options.existing ?? null),
      create: jest.fn(async () => ({ id: 'sh-1', movementId: 'mv-shrink' })),
    },
    visionEvent: {
      findFirst: jest.fn(async () =>
        options.observation === undefined ? OBSERVATION : options.observation,
      ),
    },
    order: {
      findFirst: jest.fn(async () => options.order ?? null),
    },
  };
  const prisma = {
    $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) =>
      fn(tx),
    ),
  };
  const audit = { record: jest.fn(async () => undefined) };
  const repository = new ShrinkRepository(
    prisma as never,
    audit as never,
    { applyMovement } as never,
  );
  return { repository, tx, audit, applyMovement };
}

const builders = {
  stockWrittenOff: () => ({}) as never,
  shrinkRecorded: () => ({}) as never,
};

const input = {
  visionEventId: 've-1',
  productId: 'prod-1',
  quantity: 2,
  reason: 'Walked out of the gate without paying',
};

describe('ShrinkRepository.recordShrink — the CV-detected loss path', () => {
  it('writes the loss off as ONE negative SHRINK ledger movement', async () => {
    const { repository, applyMovement } = buildHarness();
    const result = await repository.recordShrink('tenant-a', input, builders);
    expect(result).toMatchObject({ replayed: false });
    expect(applyMovement).toHaveBeenCalledTimes(1);
    expect(applyMovement).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tenantId: 'tenant-a',
        // The store comes from the OBSERVATION, never from the caller: a
        // write-off cannot be aimed at a location the camera did not see.
        locationId: 'store-1',
        productId: 'prod-1',
        quantityDelta: -2,
        movementType: InventoryMovementType.SHRINK,
        referenceType: 'VisionEvent',
        referenceId: 've-1',
      }),
    );
  });

  it('records the movement id and the CV provenance on the decision', async () => {
    const { repository, tx } = buildHarness();
    await repository.recordShrink('tenant-a', input, builders);
    expect(tx.shrinkEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 'tenant-a',
          visionEventId: 've-1',
          movementId: 'mv-shrink',
          source: ShrinkSource.CV_DETECTED,
        }),
      }),
    );
  });

  it('writes off one observation at most once', async () => {
    const { repository, applyMovement } = buildHarness({
      existing: { id: 'sh-1', productId: 'prod-1', quantity: 2 },
    });
    const result = await repository.recordShrink('tenant-a', input, builders);
    expect(result).toMatchObject({ replayed: true });
    expect(applyMovement).not.toHaveBeenCalled();
  });

  it('refuses a replay that asks for a different product or quantity', async () => {
    const { repository, applyMovement } = buildHarness({
      existing: { id: 'sh-1', productId: 'prod-2', quantity: 2 },
    });
    expect(await repository.recordShrink('tenant-a', input, builders)).toBe(
      'observation-mismatch',
    );
    expect(applyMovement).not.toHaveBeenCalled();
  });

  it('takes the per-observation lock around the check-then-write', async () => {
    const { repository, tx } = buildHarness();
    await repository.recordShrink('tenant-a', input, builders);
    const locked = (tx.$queryRaw.mock.calls as unknown[][])
      .map((call) => String(call[1] ?? ''))
      .join('|');
    expect(locked).toContain('shrink-event:tenant-a:ve-1');
  });

  it('scopes the observation lookup to the caller’s tenant', async () => {
    const { repository, tx, applyMovement } = buildHarness({
      observation: null,
    });
    expect(await repository.recordShrink('tenant-b', input, builders)).toBe(
      'observation-not-found',
    );
    expect(tx.visionEvent.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 've-1', tenantId: 'tenant-b' } }),
    );
    expect(applyMovement).not.toHaveBeenCalled();
  });
});

describe('ShrinkRepository.recordShrink — the gates that stop it being a stock eraser', () => {
  it.each([
    [
      'an observation that is not a pickup',
      { ...OBSERVATION, type: VisionEventType.PRODUCT_RETURN },
      'not-a-pickup',
    ],
    [
      'an observation still queued for a human',
      { ...OBSERVATION, status: VisionEventStatus.PENDING_REVIEW },
      'observation-under-review',
    ],
    [
      'a product the camera never proposed',
      { ...OBSERVATION, candidates: [{ productId: 'prod-other' }] },
      'product-not-observed',
    ],
    [
      'more units than were observed',
      { ...OBSERVATION, quantity: 1 },
      'quantity-exceeds-observation',
    ],
  ])('refuses %s', async (_label, observation, expected) => {
    const { repository, applyMovement } = buildHarness({ observation });
    expect(await repository.recordShrink('tenant-a', input, builders)).toBe(
      expected,
    );
    expect(applyMovement).not.toHaveBeenCalled();
  });

  it('refuses goods a live order already accounts for', async () => {
    // The shopper's session became an order that was not cancelled: they paid
    // for these goods, the SALE movement already removed them, and writing
    // them off again would remove the same stock twice.
    const { repository, applyMovement } = buildHarness({
      observation: { ...OBSERVATION, sessionId: 'cs-1' },
      order: { id: 'order-1', status: OrderStatus.CONFIRMED },
    });
    expect(await repository.recordShrink('tenant-a', input, builders)).toBe(
      'loss-already-accounted',
    );
    expect(applyMovement).not.toHaveBeenCalled();
  });

  it('allows a write-off when the session’s order was cancelled', async () => {
    const { repository, applyMovement } = buildHarness({
      observation: { ...OBSERVATION, sessionId: 'cs-1' },
      order: { id: 'order-1', status: OrderStatus.CANCELLED },
    });
    expect(
      await repository.recordShrink('tenant-a', input, builders),
    ).toMatchObject({ replayed: false });
    expect(applyMovement).toHaveBeenCalledTimes(1);
  });

  it('rolls back and reports when the ledger has nothing left to write off', async () => {
    const applyMovement = jest.fn(async () => {
      throw new AdjustmentRejected('insufficient-stock');
    });
    const { repository, tx } = buildHarness({ applyMovement });
    const result = await repository.recordShrink('tenant-a', input, builders);
    expect(result).toBeInstanceOf(ShrinkStockRejected);
    expect((result as ShrinkStockRejected).failure).toBe('insufficient-stock');
    // Throwing out of the transaction is what stops a decision record
    // surviving without the movement it claims to have produced.
    expect(tx.shrinkEvent.create).not.toHaveBeenCalled();
  });
});
