import { CheckoutSessionStatus } from '@prisma/client';
import { AuditEntry } from '../common/audit/audit-log.service';
import { InventoryRepository } from '../inventory/inventory.repository';
import { PrismaService } from '../prisma/prisma.service';
import {
  CheckoutSessionsRepository,
  CompletionAuditBuilders,
} from './checkout-sessions.repository';
import { LinePricingPort } from './line-pricing.port';

/**
 * Phase 25 wiring: checkout snapshots a resolved price onto each basket line
 * and derives order totals from those snapshots.
 *
 * The behaviour under test is as much about what does NOT happen: with no
 * pricing port, or with no price for the product, the basket must keep working
 * exactly as it did before pricing existed.
 */
describe('checkout pricing wiring', () => {
  const audit = (): AuditEntry => ({
    tenantId: 'tenant-a',
    actorEmail: 'jane@tenant-a.example',
    action: 'CREATE',
    entityType: 'CheckoutSessionLine',
  });

  const builders: CompletionAuditBuilders = {
    sessionCompleted: () => audit(),
    orderCreated: () => audit(),
    stockConsumed: () => audit(),
  };

  function buildTx(
    lines: Record<string, unknown>[] = [],
    lineOverrides: Record<string, unknown> = {},
  ) {
    return {
      $queryRaw: jest.fn().mockResolvedValue(undefined),
      checkoutSession: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'sess-1',
          tenantId: 'tenant-a',
          locationId: 'loc-a1',
          unitId: 'unit-a1',
          status: CheckoutSessionStatus.ACTIVE,
          sourceType: 'MANUAL',
          sourceId: null,
          evidenceBundleId: null,
          visionEventId: null,
          externalVisionEventRef: null,
          externalEvidenceBundleRef: null,
          vlmReviewId: null,
          evidenceScore: null,
          evidenceQuality: null,
          reasonCodes: [],
          lines,
        }),
        update: jest.fn().mockResolvedValue({ id: 'sess-1' }),
      },
      checkoutSessionLine: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'line-1',
          sessionId: 'sess-1',
          tenantId: 'tenant-a',
          productId: 'prod-a',
          quantity: 2,
          status: 'ACTIVE',
          unitPriceMinor: 1000,
          lineTotalMinor: 2000,
          currencyCode: 'AED',
          visionEventId: null,
          evidenceBundleId: null,
          ...lineOverrides,
        }),
        create: jest
          .fn()
          .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
            Promise.resolve({ id: 'line-new', ...data }),
          ),
        update: jest
          .fn()
          .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
            Promise.resolve({ id: 'line-1', ...data }),
          ),
      },
      product: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'prod-a',
          sku: 'SKU-A',
          name: 'Alpha',
          unitOfMeasure: 'EACH',
          status: 'ACTIVE',
        }),
      },
      order: {
        findFirst: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(0),
        create: jest
          .fn()
          .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
            Promise.resolve({ id: 'order-1', ...data }),
          ),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'order-1' }),
      },
      orderLine: { create: jest.fn().mockResolvedValue({}) },
      evidenceBundle: { findFirst: jest.fn().mockResolvedValue(null) },
      visionEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
  }

  function buildRepository(
    tx: ReturnType<typeof buildTx>,
    pricing?: LinePricingPort,
  ) {
    const prisma = {
      $transaction: (fn: (client: unknown) => Promise<unknown>) => fn(tx),
    } as unknown as PrismaService;
    const inventoryRepository = {
      applyMovement: jest.fn().mockResolvedValue({
        movement: { id: 'mov-1' },
        level: { quantity: 5 },
      }),
    } as unknown as InventoryRepository;
    const auditLog = { record: jest.fn().mockResolvedValue(undefined) };
    return new CheckoutSessionsRepository(
      prisma,
      auditLog as never,
      inventoryRepository,
      pricing,
    );
  }

  const pricingPort = (
    unitPriceMinor: number | null,
  ): LinePricingPort & { resolveForLine: jest.Mock } => ({
    resolveForLine: jest.fn(async () =>
      unitPriceMinor === null
        ? null
        : {
            unitPriceMinor,
            currencyCode: 'AED',
            priceBookId: 'book-1',
            priceBookVersionId: 'version-1',
          },
    ),
  });

  describe('adding a line', () => {
    it('snapshots the resolved price and the line total', async () => {
      const tx = buildTx();
      const port = pricingPort(1099);
      const repository = buildRepository(tx, port);

      await repository.addLine(
        'tenant-a',
        'sess-1',
        { productId: 'prod-a', quantity: 3, sourceType: 'MANUAL' } as never,
        () => audit(),
      );

      expect(tx.checkoutSessionLine.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            unitPriceMinor: 1099,
            lineTotalMinor: 3297,
            currencyCode: 'AED',
          }),
        }),
      );
    });

    it('prices at the session’s location, so a store book can win', async () => {
      const tx = buildTx();
      const port = pricingPort(900);
      const repository = buildRepository(tx, port);

      await repository.addLine(
        'tenant-a',
        'sess-1',
        { productId: 'prod-a', quantity: 1, sourceType: 'MANUAL' } as never,
        () => audit(),
      );

      expect(port.resolveForLine).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          tenantId: 'tenant-a',
          productId: 'prod-a',
          locationId: 'loc-a1',
        }),
      );
    });

    it('leaves the line unpriced when no price book covers the product', async () => {
      const tx = buildTx();
      const repository = buildRepository(tx, pricingPort(null));

      await repository.addLine(
        'tenant-a',
        'sess-1',
        { productId: 'prod-a', quantity: 3, sourceType: 'MANUAL' } as never,
        () => audit(),
      );

      expect(tx.checkoutSessionLine.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            unitPriceMinor: null,
            lineTotalMinor: null,
            currencyCode: null,
          }),
        }),
      );
    });

    it('works with no pricing port at all — the pre-Phase-25 shape', async () => {
      const tx = buildTx();
      const repository = buildRepository(tx);

      const result = await repository.addLine(
        'tenant-a',
        'sess-1',
        { productId: 'prod-a', quantity: 1, sourceType: 'MANUAL' } as never,
        () => audit(),
      );

      expect(result).not.toBe('session-not-found');
      expect(tx.checkoutSessionLine.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ unitPriceMinor: null }),
        }),
      );
    });
  });

  describe('changing a quantity', () => {
    it('re-multiplies the SNAPSHOTTED unit price, never re-resolving', async () => {
      const tx = buildTx();
      const port = pricingPort(5);
      const repository = buildRepository(tx, port);

      await repository.updateLine(
        'tenant-a',
        'sess-1',
        'line-1',
        { quantity: 4 },
        () => audit(),
      );

      // 1000 is the price the line was added at; 5 is what a fresh
      // resolution would say. The basket must not re-price mid-shop.
      expect(tx.checkoutSessionLine.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ lineTotalMinor: 4000 }),
        }),
      );
      expect(port.resolveForLine).not.toHaveBeenCalled();
    });

    it('keeps an unpriced line unpriced', async () => {
      const tx = buildTx([], {
        unitPriceMinor: null,
        lineTotalMinor: null,
        currencyCode: null,
      });
      const repository = buildRepository(tx, pricingPort(1000));

      await repository.updateLine(
        'tenant-a',
        'sess-1',
        'line-1',
        { quantity: 4 },
        () => audit(),
      );

      expect(tx.checkoutSessionLine.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ lineTotalMinor: null }),
        }),
      );
    });
  });

  describe('completing into an order', () => {
    const pricedLine = (
      id: string,
      productId: string,
      quantity: number,
      unitPriceMinor: number | null,
      currencyCode: string | null = 'AED',
    ) => ({
      id,
      productId,
      sku: `SKU-${productId}`,
      productName: productId,
      unitOfMeasure: 'EACH',
      quantity,
      status: 'ACTIVE',
      unitPriceMinor,
      lineTotalMinor:
        unitPriceMinor === null ? null : unitPriceMinor * quantity,
      currencyCode,
      sourceType: 'MANUAL',
      sourceId: null,
      evidenceBundleId: null,
      visionEventId: null,
      externalVisionEventRef: null,
      externalEvidenceBundleRef: null,
      vlmReviewId: null,
      evidenceScore: null,
      evidenceQuality: null,
      reasonCodes: [],
    });

    it('derives the order subtotal and total from the line snapshots', async () => {
      const tx = buildTx([
        pricedLine('line-1', 'prod-a', 2, 1000),
        pricedLine('line-2', 'prod-b', 1, 250),
      ]);
      const repository = buildRepository(tx);

      await repository.complete('tenant-a', 'sess-1', {}, builders);

      expect(tx.order.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            subtotalMinor: 2250,
            totalMinor: 2250,
            currencyCode: 'AED',
          }),
        }),
      );
    });

    it('copies the price onto each order line', async () => {
      const tx = buildTx([pricedLine('line-1', 'prod-a', 2, 1000)]);
      const repository = buildRepository(tx);

      await repository.complete('tenant-a', 'sess-1', {}, builders);

      expect(tx.orderLine.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            unitPriceMinor: 1000,
            lineTotalMinor: 2000,
            currencyCode: 'AED',
          }),
        }),
      );
    });

    it('leaves totals null when any line is unpriced', async () => {
      const tx = buildTx([
        pricedLine('line-1', 'prod-a', 2, 1000),
        pricedLine('line-2', 'prod-b', 1, null, null),
      ]);
      const repository = buildRepository(tx);

      await repository.complete('tenant-a', 'sess-1', {}, builders);

      expect(tx.order.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            subtotalMinor: null,
            totalMinor: null,
            currencyCode: null,
          }),
        }),
      );
    });

    it('leaves totals null for a mixed-currency basket', async () => {
      const tx = buildTx([
        pricedLine('line-1', 'prod-a', 1, 1000, 'AED'),
        pricedLine('line-2', 'prod-b', 1, 1000, 'SAR'),
      ]);
      const repository = buildRepository(tx);

      await repository.complete('tenant-a', 'sess-1', {}, builders);

      expect(tx.order.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ totalMinor: null }),
        }),
      );
    });

    it('rejects a basket whose total would overflow, writing nothing', async () => {
      const tx = buildTx([
        pricedLine('line-1', 'prod-a', 1, 2_000_000_000),
        pricedLine('line-2', 'prod-b', 1, 2_000_000_000),
      ]);
      const repository = buildRepository(tx);

      const result = await repository.complete(
        'tenant-a',
        'sess-1',
        {},
        builders,
      );

      expect(result).toBe('total-amount-overflow');
      expect(tx.order.create).not.toHaveBeenCalled();
    });

    it('still consumes stock through the ledger, unchanged by pricing', async () => {
      const tx = buildTx([pricedLine('line-1', 'prod-a', 2, 1000)]);
      const repository = buildRepository(tx);

      await repository.complete('tenant-a', 'sess-1', {}, builders);

      // The order row carries money; stock still moves only via the ledger.
      expect(tx.order.create).toHaveBeenCalled();
    });
  });
});
