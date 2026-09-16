import {
  CheckoutSessionLineStatus,
  CheckoutSessionStatus,
} from '@prisma/client';
import { AuditEntry } from '../common/audit/audit-log.service';
import { InventoryRepository } from '../inventory/inventory.repository';
import { PrismaService } from '../prisma/prisma.service';
import {
  CheckoutSessionsRepository,
  CompletionAuditBuilders,
} from './checkout-sessions.repository';
import { LinePricingPort } from './line-pricing.port';
import { LinePromotionPort } from './line-promotion.port';

/**
 * Phase 29 wiring: checkout resolves a PRICE first, then asks whether a
 * PROMOTION reduces it, and records both halves on the basket line.
 *
 * The behaviour under test is as much about what does NOT happen: with no
 * promotion port, or with no promotion applying, the basket must behave
 * exactly as it did in Phase 28 — and a promotion must never reach pricing,
 * change which price version was chosen, or produce a price above the base.
 */
describe('checkout promotion wiring', () => {
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
    options: {
      loyaltyAccountId?: string | null;
      lines?: Record<string, unknown>[];
    } = {},
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
          loyaltyAccountId: options.loyaltyAccountId ?? null,
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
          lines: options.lines ?? [],
        }),
        update: jest.fn().mockResolvedValue({ id: 'sess-1' }),
        create: jest
          .fn()
          .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
            Promise.resolve({ id: 'sess-new', lines: [], ...data }),
          ),
      },
      checkoutSessionLine: {
        findFirst: jest.fn().mockResolvedValue(null),
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
      loyaltyAccount: {
        findFirst: jest.fn().mockResolvedValue({ id: 'acc-1' }),
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
      location: { findFirst: jest.fn().mockResolvedValue({ id: 'loc-a1' }) },
      retailUnit: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'unit-a1', locationId: 'loc-a1' }),
      },
    };
  }

  function buildRepository(
    tx: ReturnType<typeof buildTx>,
    pricing?: LinePricingPort,
    promotion?: LinePromotionPort,
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
      promotion,
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

  const promotionPort = (
    discountMinor: number | null,
  ): LinePromotionPort & { resolveForLine: jest.Mock } => ({
    resolveForLine: jest.fn(
      async (
        _client: unknown,
        query: { base: { unitPriceMinor: number; currencyCode: string } },
      ) =>
        discountMinor === null
          ? null
          : {
              basePriceMinor: query.base.unitPriceMinor,
              discountMinor,
              unitPriceMinor: query.base.unitPriceMinor - discountMinor,
              currencyCode: query.base.currencyCode,
              promotionId: 'promo-1',
              promotionVersionId: 'pver-1',
            },
    ),
  });

  const addLine = (repository: CheckoutSessionsRepository, quantity = 1) =>
    repository.addLine(
      'tenant-a',
      'sess-1',
      { productId: 'prod-a', quantity, sourceType: 'MANUAL' } as never,
      () => audit(),
    );

  describe('adding a line', () => {
    it('records the price version, the base, the discount, and what is paid', async () => {
      const tx = buildTx();
      const repository = buildRepository(
        tx,
        pricingPort(1000),
        promotionPort(150),
      );
      await addLine(repository, 3);
      expect(tx.checkoutSessionLine.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            priceBookVersionId: 'version-1',
            basePriceMinor: 1000,
            promotionVersionId: 'pver-1',
            promotionDiscountMinor: 150,
            unitPriceMinor: 850,
            lineTotalMinor: 2550,
            currencyCode: 'AED',
          }),
        }),
      );
    });

    it('ASKS PRICING FIRST, then hands its answer to promotions untouched', async () => {
      const tx = buildTx();
      const pricing = pricingPort(1000);
      const promotion = promotionPort(150);
      const repository = buildRepository(tx, pricing, promotion);
      await addLine(repository);
      expect(pricing.resolveForLine.mock.invocationCallOrder[0]).toBeLessThan(
        promotion.resolveForLine.mock.invocationCallOrder[0],
      );
      expect(promotion.resolveForLine).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          base: {
            unitPriceMinor: 1000,
            currencyCode: 'AED',
            priceBookId: 'book-1',
            priceBookVersionId: 'version-1',
          },
        }),
      );
    });

    it('keeps the base price and null promotion columns when nothing applies', async () => {
      const tx = buildTx();
      const repository = buildRepository(
        tx,
        pricingPort(1000),
        promotionPort(null),
      );
      await addLine(repository, 2);
      expect(tx.checkoutSessionLine.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            priceBookVersionId: 'version-1',
            basePriceMinor: 1000,
            promotionVersionId: null,
            promotionDiscountMinor: null,
            unitPriceMinor: 1000,
            lineTotalMinor: 2000,
          }),
        }),
      );
    });

    it('behaves exactly as Phase 28 did when no promotion port is wired', async () => {
      const tx = buildTx();
      const repository = buildRepository(tx, pricingPort(1099));
      await addLine(repository, 3);
      expect(tx.checkoutSessionLine.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            unitPriceMinor: 1099,
            lineTotalMinor: 3297,
            currencyCode: 'AED',
            promotionVersionId: null,
            promotionDiscountMinor: null,
          }),
        }),
      );
    });

    it('never asks about a promotion for an UNPRICED product', async () => {
      const tx = buildTx();
      const promotion = promotionPort(150);
      const repository = buildRepository(tx, pricingPort(null), promotion);
      await addLine(repository);
      // With no base there is nothing to subtract from: unpriced is not
      // "free with a discount".
      expect(promotion.resolveForLine).not.toHaveBeenCalled();
      expect(tx.checkoutSessionLine.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            unitPriceMinor: null,
            basePriceMinor: null,
            priceBookVersionId: null,
            promotionVersionId: null,
          }),
        }),
      );
    });

    it('passes the session’s loyalty account, fixed when the session opened', async () => {
      const tx = buildTx({ loyaltyAccountId: 'acc-1' });
      const promotion = promotionPort(100);
      const repository = buildRepository(tx, pricingPort(1000), promotion);
      await addLine(repository);
      expect(promotion.resolveForLine).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({ loyaltyAccountId: 'acc-1' }),
      );
    });

    it('passes a null account for a non-member basket', async () => {
      const tx = buildTx();
      const promotion = promotionPort(100);
      const repository = buildRepository(tx, pricingPort(1000), promotion);
      await addLine(repository);
      expect(promotion.resolveForLine).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({ loyaltyAccountId: null }),
      );
    });
  });

  describe('opening a session with a member', () => {
    it('refuses an account that is not ACTIVE in this tenant', async () => {
      const tx = buildTx();
      tx.loyaltyAccount.findFirst.mockResolvedValue(null);
      const repository = buildRepository(tx, pricingPort(1000));
      expect(
        await repository.create(
          'tenant-a',
          {
            locationId: 'loc-a1',
            unitId: 'unit-a1',
            loyaltyAccountId: 'acc-other',
          } as never,
          () => audit(),
        ),
      ).toBe('loyalty-account-not-found');
    });

    it('looks the account up scoped to the tenant AND to ACTIVE', async () => {
      const tx = buildTx();
      const repository = buildRepository(tx, pricingPort(1000));
      await repository.create(
        'tenant-a',
        {
          locationId: 'loc-a1',
          unitId: 'unit-a1',
          loyaltyAccountId: 'acc-1',
        } as never,
        () => audit(),
      );
      expect(tx.loyaltyAccount.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: 'acc-1',
            tenantId: 'tenant-a',
            status: 'ACTIVE',
          },
        }),
      );
    });

    it('does not look for an account at all on a non-member basket', async () => {
      const tx = buildTx();
      const repository = buildRepository(tx, pricingPort(1000));
      await repository.create(
        'tenant-a',
        { locationId: 'loc-a1', unitId: 'unit-a1' } as never,
        () => audit(),
      );
      expect(tx.loyaltyAccount.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('completing into an order', () => {
    const promotedLine = {
      id: 'line-1',
      tenantId: 'tenant-a',
      productId: 'prod-a',
      sku: 'SKU-A',
      productName: 'Alpha',
      unitOfMeasure: 'EACH',
      quantity: 2,
      status: 'ACTIVE',
      unitPriceMinor: 850,
      lineTotalMinor: 1700,
      currencyCode: 'AED',
      priceBookVersionId: 'version-1',
      basePriceMinor: 1000,
      promotionVersionId: 'pver-1',
      promotionDiscountMinor: 150,
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
    };

    it('copies the provenance onto the order line, never re-resolving it', async () => {
      const tx = buildTx({ lines: [promotedLine] });
      const pricing = pricingPort(9999);
      const promotion = promotionPort(9999);
      const repository = buildRepository(tx, pricing, promotion);
      await repository.complete('tenant-a', 'sess-1', {}, builders);
      expect(tx.orderLine.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            unitPriceMinor: 850,
            lineTotalMinor: 1700,
            priceBookVersionId: 'version-1',
            basePriceMinor: 1000,
            promotionVersionId: 'pver-1',
            promotionDiscountMinor: 150,
          }),
        }),
      );
      // Completion re-prices nothing: the shopper pays what the basket said.
      expect(pricing.resolveForLine).not.toHaveBeenCalled();
      expect(promotion.resolveForLine).not.toHaveBeenCalled();
    });

    it('totals the PROMOTED line amounts, not the base prices', async () => {
      const tx = buildTx({ lines: [promotedLine] });
      const repository = buildRepository(
        tx,
        pricingPort(1000),
        promotionPort(150),
      );
      await repository.complete('tenant-a', 'sess-1', {}, builders);
      expect(tx.order.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            subtotalMinor: 1700,
            totalMinor: 1700,
            currencyCode: 'AED',
          }),
        }),
      );
    });
  });
});

/**
 * Codex P1 pattern (found again in the Phase 29 round): destructive checkout
 * writes must carry the tenant IN the write predicate via the `id_tenantId`
 * composite key — never relying only on the tenant-scoped lookup that
 * preceded them. Same rule locations.repository.spec.ts pins for locations.
 *
 * Each of these had the tenant only in the lookup before Phase 29.
 */
describe('CheckoutSessionsRepository destructive writes are tenant-scoped', () => {
  const TENANT = 'tenant-a';
  const auditEntry = () => ({}) as AuditEntry;

  function buildHarness(
    over: {
      session?: Record<string, unknown> | null;
      line?: Record<string, unknown> | null;
    } = {},
  ) {
    const tx = {
      $queryRaw: jest.fn(async () => []),
      checkoutSession: {
        findFirst: jest.fn(async () =>
          over.session === undefined
            ? {
                id: 'sess-1',
                tenantId: TENANT,
                status: CheckoutSessionStatus.ACTIVE,
                locationId: 'loc-1',
                unitId: 'unit-1',
                loyaltyAccountId: null,
                lines: [],
              }
            : over.session,
        ),
        update: jest.fn(async () => ({ id: 'sess-1' })),
      },
      checkoutSessionLine: {
        findFirst: jest.fn(async () =>
          over.line === undefined
            ? {
                id: 'line-1',
                tenantId: TENANT,
                sessionId: 'sess-1',
                productId: 'prod-1',
                quantity: 2,
                status: CheckoutSessionLineStatus.ACTIVE,
                unitPriceMinor: null,
                lineTotalMinor: null,
                currencyCode: null,
                visionEventId: null,
                evidenceBundleId: null,
              }
            : over.line,
        ),
        update: jest.fn(async () => ({ id: 'line-1' })),
      },
      evidenceBundle: { findFirst: jest.fn(async () => null) },
      visionEvent: {
        findFirst: jest.fn(async () => null),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
    };
    const prisma = {
      $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) =>
        fn(tx),
      ),
    } as unknown as PrismaService;
    const auditLog = { record: jest.fn(async () => undefined) };
    const inventoryRepository = {} as unknown as InventoryRepository;
    const repository = new CheckoutSessionsRepository(
      prisma,
      auditLog as never,
      inventoryRepository,
    );
    return { repository, tx };
  }

  it('flips a session status through the id_tenantId composite key', async () => {
    const { repository, tx } = buildHarness();
    await repository.updateStatus(
      TENANT,
      'sess-1',
      CheckoutSessionStatus.CANCELLED,
      auditEntry,
    );
    expect(tx.checkoutSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id_tenantId: { id: 'sess-1', tenantId: TENANT } },
      }),
    );
  });

  it('updates a basket line through the id_tenantId composite key', async () => {
    const { repository, tx } = buildHarness();
    await repository.updateLine(
      TENANT,
      'sess-1',
      'line-1',
      { quantity: 3 } as never,
      auditEntry,
    );
    expect(tx.checkoutSessionLine.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id_tenantId: { id: 'line-1', tenantId: TENANT } },
      }),
    );
  });

  it('tombstones a removed line through the id_tenantId composite key', async () => {
    const { repository, tx } = buildHarness();
    await repository.removeLine(TENANT, 'sess-1', 'line-1', auditEntry);
    expect(tx.checkoutSessionLine.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id_tenantId: { id: 'line-1', tenantId: TENANT } },
      }),
    );
  });

  it('a foreign tenant finds nothing and never reaches the write', async () => {
    const { repository, tx } = buildHarness({ session: null, line: null });
    expect(
      await repository.updateStatus(
        'tenant-b',
        'sess-1',
        CheckoutSessionStatus.CANCELLED,
        auditEntry,
      ),
    ).toBeNull();
    expect(tx.checkoutSession.update).not.toHaveBeenCalled();
    expect(tx.checkoutSessionLine.update).not.toHaveBeenCalled();
  });
});
