import {
  CheckoutSessionStatus,
  InventoryMovementType,
  OrderStatus,
} from '@prisma/client';
import { AuditEntry } from '../common/audit/audit-log.service';
import {
  AdjustmentRejected,
  InventoryRepository,
} from '../inventory/inventory.repository';
import { PrismaService } from '../prisma/prisma.service';
import {
  CheckoutSessionsRepository,
  CompletionAuditBuilders,
  SESSION_STATUS_TRANSITIONS,
} from './checkout-sessions.repository';

describe('CheckoutSessionsRepository', () => {
  const auditEntry = (marker: string): AuditEntry => ({
    tenantId: 'tenant-a',
    actorEmail: 'jane@tenant-a.example',
    action: 'CREATE',
    entityType: marker,
  });

  const builders: CompletionAuditBuilders = {
    sessionCompleted: () => auditEntry('CheckoutSession'),
    orderCreated: () => auditEntry('Order'),
    stockConsumed: () => auditEntry('InventoryMovement'),
  };

  const lines = [
    {
      id: 'line-2',
      productId: 'prod-b',
      sku: 'SKU-B',
      productName: 'Beta',
      unitOfMeasure: 'EACH',
      quantity: 3,
      status: 'ACTIVE',
      sourceType: 'VISION',
      sourceId: 'src-1',
      evidenceBundleId: 'bundle-1',
      visionEventId: 'vision-1',
      vlmReviewId: null,
      evidenceScore: 0.9,
      evidenceQuality: 'HIGH',
      reasonCodes: ['auto-detected'],
    },
    {
      id: 'line-1',
      productId: 'prod-a',
      sku: 'SKU-A',
      productName: 'Alpha',
      unitOfMeasure: 'EACH',
      quantity: 2,
      status: 'ACTIVE',
      sourceType: 'MANUAL',
      sourceId: null,
      evidenceBundleId: null,
      visionEventId: null,
      vlmReviewId: null,
      evidenceScore: null,
      evidenceQuality: null,
      reasonCodes: [],
    },
  ];

  const session = {
    id: 'sess-1',
    tenantId: 'tenant-a',
    locationId: 'loc-a1',
    unitId: 'unit-a1',
    status: CheckoutSessionStatus.ACTIVE,
    sourceType: 'MANUAL',
    sourceId: null,
    evidenceBundleId: null,
    visionEventId: 'vision-session-1',
    vlmReviewId: null,
    evidenceScore: null,
    evidenceQuality: null,
    reasonCodes: [],
    lines,
  };

  let tx: {
    $queryRaw: jest.Mock;
    checkoutSession: { findFirst: jest.Mock; update: jest.Mock };
    order: {
      findFirst: jest.Mock;
      count: jest.Mock;
      create: jest.Mock;
      findUniqueOrThrow: jest.Mock;
    };
    orderLine: { create: jest.Mock };
  };
  let inventoryRepository: { applyMovement: jest.Mock };
  let auditLog: { record: jest.Mock };
  let repository: CheckoutSessionsRepository;

  beforeEach(() => {
    tx = {
      $queryRaw: jest.fn().mockResolvedValue(undefined),
      checkoutSession: {
        findFirst: jest.fn().mockResolvedValue(session),
        update: jest
          .fn()
          .mockResolvedValue({ ...session, status: 'COMPLETED' }),
      },
      order: {
        findFirst: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(0),
        create: jest
          .fn()
          .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
            Promise.resolve({ id: 'order-1', ...data }),
          ),
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ id: 'order-1', orderNumber: 'ORD-000001' }),
      },
      orderLine: { create: jest.fn().mockResolvedValue({}) },
    };
    inventoryRepository = {
      applyMovement: jest.fn().mockResolvedValue({
        movement: { id: 'mov-1' },
        level: { quantity: 5 },
      }),
    };
    auditLog = { record: jest.fn().mockResolvedValue(undefined) };
    const prisma = {
      $transaction: (fn: (client: unknown) => Promise<unknown>) => fn(tx),
    } as unknown as PrismaService;
    repository = new CheckoutSessionsRepository(
      prisma,
      auditLog as never,
      inventoryRepository as unknown as InventoryRepository,
    );
  });

  it('declares COMPLETED, CANCELLED, and EXPIRED as terminal', () => {
    expect(SESSION_STATUS_TRANSITIONS[CheckoutSessionStatus.COMPLETED]).toEqual(
      [],
    );
    expect(SESSION_STATUS_TRANSITIONS[CheckoutSessionStatus.CANCELLED]).toEqual(
      [],
    );
    expect(SESSION_STATUS_TRANSITIONS[CheckoutSessionStatus.EXPIRED]).toEqual(
      [],
    );
    // COMPLETED is never a PATCH target — only complete() reaches it.
    for (const targets of Object.values(SESSION_STATUS_TRANSITIONS)) {
      expect(targets).not.toContain(CheckoutSessionStatus.COMPLETED);
    }
  });

  describe('complete', () => {
    it('creates a CONFIRMED order, consuming stock per line in productId order', async () => {
      const result = await repository.complete(
        'tenant-a',
        'sess-1',
        { idempotencyKey: 'key-1', createdById: 'user-1' },
        builders,
      );

      expect(result).toEqual({
        order: { id: 'order-1', orderNumber: 'ORD-000001' },
        replayed: false,
      });
      expect(tx.order.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tenantId: 'tenant-a',
            orderNumber: 'ORD-000001',
            checkoutSessionId: 'sess-1',
            locationId: 'loc-a1',
            unitId: 'unit-a1',
            status: OrderStatus.CONFIRMED,
            totalQuantity: 5,
            visionEventId: 'vision-session-1',
            idempotencyKey: 'key-1',
            createdById: 'user-1',
          }),
        }),
      );

      // Lines decrement in productId order (deadlock-free lock ordering).
      expect(inventoryRepository.applyMovement).toHaveBeenCalledTimes(2);
      const [firstCall, secondCall] =
        inventoryRepository.applyMovement.mock.calls;
      expect(firstCall[1]).toEqual(
        expect.objectContaining({
          productId: 'prod-a',
          quantityDelta: -2,
          movementType: InventoryMovementType.SALE,
          referenceType: 'Order',
          referenceId: 'order-1',
        }),
      );
      expect(secondCall[1]).toEqual(
        expect.objectContaining({ productId: 'prod-b', quantityDelta: -3 }),
      );

      // Order lines snapshot the SESSION lines with lineage + evidence.
      expect(tx.orderLine.create).toHaveBeenCalledTimes(2);
      expect(tx.orderLine.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          orderId: 'order-1',
          sessionLineId: 'line-2',
          sku: 'SKU-B',
          productName: 'Beta',
          quantity: 3,
          visionEventId: 'vision-1',
          evidenceQuality: 'HIGH',
          reasonCodes: ['auto-detected'],
        }),
      });

      expect(tx.checkoutSession.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: CheckoutSessionStatus.COMPLETED,
            endedAt: expect.any(Date),
          }),
        }),
      );
      // 2 stock audits + session COMPLETE + order CREATE.
      expect(auditLog.record).toHaveBeenCalledTimes(4);
    });

    it('aborts the whole completion when a line has insufficient stock', async () => {
      inventoryRepository.applyMovement
        .mockResolvedValueOnce({
          movement: { id: 'mov-1' },
          level: { quantity: 0 },
        })
        .mockRejectedValueOnce(new AdjustmentRejected('insufficient-stock'));

      const result = await repository.complete(
        'tenant-a',
        'sess-1',
        {},
        builders,
      );

      expect(result).toEqual({
        stockFailure: 'insufficient-stock',
        sku: 'SKU-B',
      });
      // The throw aborted the transaction before any snapshot or flip:
      expect(tx.orderLine.create).not.toHaveBeenCalled();
      expect(tx.checkoutSession.update).not.toHaveBeenCalled();
    });

    it('replays an already-completed session when the idempotency key matches its order', async () => {
      tx.checkoutSession.findFirst.mockResolvedValue({
        ...session,
        status: CheckoutSessionStatus.COMPLETED,
      });
      const existing = { id: 'order-1', orderNumber: 'ORD-000001' };
      tx.order.findFirst.mockResolvedValue(existing);

      const result = await repository.complete(
        'tenant-a',
        'sess-1',
        { idempotencyKey: 'key-1' },
        builders,
      );

      expect(result).toEqual({ order: existing, replayed: true });
      expect(tx.order.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            tenantId: 'tenant-a',
            checkoutSessionId: 'sess-1',
            idempotencyKey: 'key-1',
          }),
        }),
      );
      // No new writes of any kind on a replay.
      expect(tx.order.create).not.toHaveBeenCalled();
      expect(inventoryRepository.applyMovement).not.toHaveBeenCalled();
      expect(auditLog.record).not.toHaveBeenCalled();
    });

    it('rejects a completed session without the matching key', async () => {
      tx.checkoutSession.findFirst.mockResolvedValue({
        ...session,
        status: CheckoutSessionStatus.COMPLETED,
      });
      await expect(
        repository.complete('tenant-a', 'sess-1', {}, builders),
      ).resolves.toBe('already-completed');
    });

    it('rejects cancelled/expired sessions and empty baskets', async () => {
      tx.checkoutSession.findFirst.mockResolvedValue({
        ...session,
        status: CheckoutSessionStatus.CANCELLED,
      });
      await expect(
        repository.complete('tenant-a', 'sess-1', {}, builders),
      ).resolves.toBe('session-terminal');

      tx.checkoutSession.findFirst.mockResolvedValue({
        ...session,
        lines: [],
      });
      await expect(
        repository.complete('tenant-a', 'sess-1', {}, builders),
      ).resolves.toBe('empty-session');
    });

    it('only loads ACTIVE lines — REMOVED tombstones never complete or consume stock', async () => {
      await repository.complete('tenant-a', 'sess-1', {}, builders);
      expect(tx.checkoutSession.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          include: {
            lines: expect.objectContaining({
              where: { status: 'ACTIVE' },
            }),
          },
        }),
      );
    });

    it('passes each line snapshot UOM to applyMovement for under-lock revalidation', async () => {
      await repository.complete('tenant-a', 'sess-1', {}, builders);
      for (const call of inventoryRepository.applyMovement.mock.calls) {
        expect(call[1]).toEqual(
          expect.objectContaining({ expectedUnitOfMeasure: 'EACH' }),
        );
      }
    });

    it('aborts the whole completion when a product UOM changed since the line snapshot', async () => {
      inventoryRepository.applyMovement.mockRejectedValueOnce(
        new AdjustmentRejected('unit-of-measure-changed'),
      );
      const result = await repository.complete(
        'tenant-a',
        'sess-1',
        {},
        builders,
      );
      expect(result).toEqual({
        stockFailure: 'unit-of-measure-changed',
        sku: 'SKU-A',
      });
      // The throw rolled the transaction back: no order snapshot, no flip.
      expect(tx.orderLine.create).not.toHaveBeenCalled();
      expect(tx.checkoutSession.update).not.toHaveBeenCalled();
    });

    it('aborts the whole completion when a product is no longer saleable', async () => {
      inventoryRepository.applyMovement.mockRejectedValueOnce(
        new AdjustmentRejected('product-not-saleable'),
      );
      const result = await repository.complete(
        'tenant-a',
        'sess-1',
        {},
        builders,
      );
      expect(result).toEqual({
        stockFailure: 'product-not-saleable',
        sku: 'SKU-A',
      });
      expect(tx.orderLine.create).not.toHaveBeenCalled();
      expect(tx.checkoutSession.update).not.toHaveBeenCalled();
    });

    it('rejects a key already used by a DIFFERENT session with a controlled conflict', async () => {
      tx.order.findFirst.mockImplementation(
        ({ where }: { where: { idempotencyKey?: string } }) =>
          Promise.resolve(
            where.idempotencyKey
              ? { id: 'order-x', checkoutSessionId: 'sess-OTHER' }
              : null,
          ),
      );
      await expect(
        repository.complete(
          'tenant-a',
          'sess-1',
          { idempotencyKey: 'key-1' },
          builders,
        ),
      ).resolves.toBe('idempotency-key-conflict');
      expect(tx.order.create).not.toHaveBeenCalled();
      expect(inventoryRepository.applyMovement).not.toHaveBeenCalled();
    });

    it('rechecks the key UNDER the order-number lock so a racing winner becomes a conflict, not a P2002', async () => {
      // Simulates the race: the pre-lock check sees nothing, the winner
      // commits while we wait on the tenant order lock, and the under-lock
      // recheck finds its order for a different session.
      let keyLookups = 0;
      tx.order.findFirst.mockImplementation(
        ({ where }: { where: { idempotencyKey?: string } }) => {
          if (!where.idempotencyKey) {
            return Promise.resolve(null);
          }
          keyLookups += 1;
          return Promise.resolve(
            keyLookups >= 2
              ? { id: 'order-winner', checkoutSessionId: 'sess-OTHER' }
              : null,
          );
        },
      );
      await expect(
        repository.complete(
          'tenant-a',
          'sess-1',
          { idempotencyKey: 'key-1' },
          builders,
        ),
      ).resolves.toBe('idempotency-key-conflict');
      expect(keyLookups).toBe(2);
      expect(tx.order.create).not.toHaveBeenCalled();
    });

    it('replays when the racing winner was THIS session', async () => {
      const winner = {
        id: 'order-1',
        orderNumber: 'ORD-000001',
        checkoutSessionId: 'sess-1',
      };
      tx.order.findFirst.mockImplementation(
        ({ where }: { where: { idempotencyKey?: string } }) =>
          Promise.resolve(where.idempotencyKey ? winner : null),
      );
      await expect(
        repository.complete(
          'tenant-a',
          'sess-1',
          { idempotencyKey: 'key-1' },
          builders,
        ),
      ).resolves.toEqual({ order: winner, replayed: true });
      expect(tx.order.create).not.toHaveBeenCalled();
      expect(inventoryRepository.applyMovement).not.toHaveBeenCalled();
    });

    it('probes past an occupied order number instead of colliding', async () => {
      tx.order.count.mockResolvedValue(2);
      // count+1 = ORD-000003 is taken (out-of-band surgery); 4 is free.
      tx.order.findFirst.mockImplementation(
        ({ where }: { where: { orderNumber?: string } }) =>
          Promise.resolve(
            where.orderNumber === 'ORD-000003' ? { id: 'other' } : null,
          ),
      );

      await repository.complete('tenant-a', 'sess-1', {}, builders);

      expect(tx.order.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ orderNumber: 'ORD-000004' }),
        }),
      );
    });
  });

  describe('addLine', () => {
    beforeEach(() => {
      (tx as Record<string, unknown>).checkoutSessionLine = {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest
          .fn()
          .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
            Promise.resolve({ id: 'line-new', ...data }),
          ),
      };
      (tx as Record<string, unknown>).product = {
        findFirst: jest.fn().mockResolvedValue({
          id: 'prod-a',
          sku: 'SKU-A',
          name: 'Alpha',
          unitOfMeasure: 'EACH',
          status: 'ACTIVE',
        }),
      };
      tx.checkoutSession.findFirst.mockResolvedValue({
        id: 'sess-1',
        status: CheckoutSessionStatus.OPEN,
      });
    });

    it('snapshots the product onto the line at add time', async () => {
      const result = await repository.addLine(
        'tenant-a',
        'sess-1',
        { productId: 'prod-a', quantity: 2, visionEventId: 'vision-9' },
        () => auditEntry('CheckoutSessionLine'),
      );
      expect(result).toEqual(
        expect.objectContaining({ replayed: false }),
      );
      const createMock = (
        tx as unknown as {
          checkoutSessionLine: { create: jest.Mock };
        }
      ).checkoutSessionLine.create;
      expect(createMock).toHaveBeenCalledWith({
        data: expect.objectContaining({
          sku: 'SKU-A',
          productName: 'Alpha',
          unitOfMeasure: 'EACH',
          quantity: 2,
          visionEventId: 'vision-9',
        }),
      });
    });

    it('rejects non-ACTIVE products as not saleable', async () => {
      (
        tx as unknown as { product: { findFirst: jest.Mock } }
      ).product.findFirst.mockResolvedValue({
        id: 'prod-a',
        sku: 'SKU-A',
        name: 'Alpha',
        unitOfMeasure: 'EACH',
        status: 'DRAFT',
      });
      await expect(
        repository.addLine(
          'tenant-a',
          'sess-1',
          { productId: 'prod-a', quantity: 1 },
          () => auditEntry('CheckoutSessionLine'),
        ),
      ).resolves.toBe('product-not-saleable');
    });

    it('rejects line mutations on terminal sessions', async () => {
      tx.checkoutSession.findFirst.mockResolvedValue({
        id: 'sess-1',
        status: CheckoutSessionStatus.COMPLETED,
      });
      await expect(
        repository.addLine(
          'tenant-a',
          'sess-1',
          { productId: 'prod-a', quantity: 1 },
          () => auditEntry('CheckoutSessionLine'),
        ),
      ).resolves.toBe('session-terminal');
    });

    it('replays an idempotent retry against the same session and ACTIVE line', async () => {
      const existing = {
        id: 'line-old',
        sessionId: 'sess-1',
        status: 'ACTIVE',
      };
      (
        tx as unknown as { checkoutSessionLine: { findFirst: jest.Mock } }
      ).checkoutSessionLine.findFirst.mockResolvedValue(existing);
      await expect(
        repository.addLine(
          'tenant-a',
          'sess-1',
          { productId: 'prod-a', quantity: 1, idempotencyKey: 'key-K' },
          () => auditEntry('CheckoutSessionLine'),
        ),
      ).resolves.toEqual({ line: existing, replayed: true });
    });

    it('never resurrects a REMOVED line: a retried key is consumed for good', async () => {
      const lineMocks = (
        tx as unknown as {
          checkoutSessionLine: { findFirst: jest.Mock; create: jest.Mock };
        }
      ).checkoutSessionLine;
      lineMocks.findFirst.mockResolvedValue({
        id: 'line-old',
        sessionId: 'sess-1',
        status: 'REMOVED',
      });
      await expect(
        repository.addLine(
          'tenant-a',
          'sess-1',
          { productId: 'prod-a', quantity: 1, idempotencyKey: 'key-K' },
          () => auditEntry('CheckoutSessionLine'),
        ),
      ).resolves.toBe('idempotency-key-consumed');
      // No new line, no replay of the tombstone, no audit row.
      expect(lineMocks.create).not.toHaveBeenCalled();
      expect(auditLog.record).not.toHaveBeenCalled();
    });
  });

  describe('removeLine', () => {
    let lineMocks: {
      findFirst: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
    };

    beforeEach(() => {
      lineMocks = {
        findFirst: jest.fn().mockResolvedValue({
          id: 'line-1',
          sessionId: 'sess-1',
          status: 'ACTIVE',
        }),
        update: jest
          .fn()
          .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
            Promise.resolve({ id: 'line-1', sessionId: 'sess-1', ...data }),
          ),
        delete: jest.fn(),
      };
      (tx as Record<string, unknown>).checkoutSessionLine = lineMocks;
      tx.checkoutSession.findFirst.mockResolvedValue({
        id: 'sess-1',
        status: CheckoutSessionStatus.OPEN,
      });
    });

    it('SOFT-deletes the line so the idempotency key stays reserved', async () => {
      const result = await repository.removeLine(
        'tenant-a',
        'sess-1',
        'line-1',
        () => auditEntry('CheckoutSessionLine'),
      );
      expect(lineMocks.update).toHaveBeenCalledWith({
        where: { id: 'line-1' },
        data: { status: 'REMOVED', removedAt: expect.any(Date) },
      });
      // Never a hard delete: the tombstone IS the key reservation.
      expect(lineMocks.delete).not.toHaveBeenCalled();
      expect(result).toEqual(
        expect.objectContaining({ status: 'REMOVED' }),
      );
    });

    it('only removes ACTIVE lines — an already-removed line is not found', async () => {
      lineMocks.findFirst.mockResolvedValue(null);
      await expect(
        repository.removeLine('tenant-a', 'sess-1', 'line-1', () =>
          auditEntry('CheckoutSessionLine'),
        ),
      ).resolves.toBe('line-not-found');
      expect(lineMocks.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: 'ACTIVE' }),
        }),
      );
      expect(lineMocks.update).not.toHaveBeenCalled();
    });
  });

  describe('create — source device binding', () => {
    let deviceMocks: { findFirst: jest.Mock };
    let createMock: jest.Mock;

    beforeEach(() => {
      (tx as Record<string, unknown>).location = {
        findFirst: jest.fn().mockResolvedValue({ id: 'loc-a1' }),
      };
      (tx as Record<string, unknown>).retailUnit = {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'unit-a1', locationId: 'loc-a1' }),
      };
      deviceMocks = {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'dev-1', unitId: 'unit-a1' }),
      };
      (tx as Record<string, unknown>).device = deviceMocks;
      createMock = jest
        .fn()
        .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ id: 'sess-new', ...data, lines: [], order: null }),
        );
      (
        tx as unknown as { checkoutSession: { create: jest.Mock } }
      ).checkoutSession.create = createMock;
    });

    const data = {
      locationId: 'loc-a1',
      unitId: 'unit-a1',
      deviceId: 'dev-1',
    };

    it('accepts a device attached to the SELECTED unit', async () => {
      const result = await repository.create('tenant-a', data, () =>
        auditEntry('CheckoutSession'),
      );
      expect(result).toEqual(
        expect.objectContaining({ replayed: false }),
      );
      expect(createMock).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ deviceId: 'dev-1' }),
        }),
      );
    });

    it('rejects a same-tenant device attached to a DIFFERENT unit', async () => {
      deviceMocks.findFirst.mockResolvedValue({
        id: 'dev-1',
        unitId: 'unit-B',
      });
      await expect(
        repository.create('tenant-a', data, () =>
          auditEntry('CheckoutSession'),
        ),
      ).resolves.toBe('device-unit-mismatch');
      expect(createMock).not.toHaveBeenCalled();
    });

    it('still rejects a cross-tenant device: the scoped lookup simply finds nothing', async () => {
      deviceMocks.findFirst.mockResolvedValue(null);
      await expect(
        repository.create('tenant-a', data, () =>
          auditEntry('CheckoutSession'),
        ),
      ).resolves.toBe('device-not-found');
      expect(deviceMocks.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'dev-1', tenantId: 'tenant-a' },
        }),
      );
      expect(createMock).not.toHaveBeenCalled();
    });
  });
});
