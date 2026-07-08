import { AuditLogService } from '../common/audit/audit-log.service';
import { TenantIdRequiredError } from '../common/errors/domain.errors';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryRepository } from './inventory.repository';

describe('InventoryRepository.adjust', () => {
  const auditLog = { record: jest.fn().mockResolvedValue(undefined) };

  function buildTx(overrides: Record<string, unknown> = {}) {
    return {
      location: {
        findFirst: jest.fn().mockResolvedValue({ id: 'loc-1' }),
      },
      product: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'prod-1', status: 'ACTIVE' }),
      },
      inventoryLevel: {
        upsert: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: 'level-1',
          tenantId: 'tenant-a',
          locationId: 'loc-1',
          productId: 'prod-1',
          quantity: 6,
        }),
      },
      inventoryMovement: {
        create: jest.fn().mockImplementation(({ data }) =>
          Promise.resolve({ id: 'move-1', ...data }),
        ),
      },
      ...overrides,
    };
  }

  function buildRepository(tx: ReturnType<typeof buildTx>) {
    const prisma = {
      $transaction: (callback: (client: unknown) => unknown) => callback(tx),
    } as unknown as PrismaService;
    return new InventoryRepository(
      prisma,
      auditLog as unknown as AuditLogService,
    );
  }

  const input = {
    locationId: 'loc-1',
    productId: 'prod-1',
    quantityDelta: -4,
    reason: 'Damaged cans',
    createdById: 'user-1',
  };
  const buildAuditEntry = jest.fn().mockReturnValue({
    tenantId: 'tenant-a',
    actorEmail: 'jane@tenant-a.example',
    action: 'STOCK_ADJUSTMENT',
    entityType: 'InventoryMovement',
  });

  it('throws on a missing tenant id — never a wildcard query', () => {
    const repository = buildRepository(buildTx());
    expect(() => repository.adjust('', input, buildAuditEntry)).toThrow(
      TenantIdRequiredError,
    );
  });

  it('resolves location and product with TENANT-SCOPED lookups', async () => {
    const tx = buildTx();
    const repository = buildRepository(tx);
    await repository.adjust('tenant-a', input, buildAuditEntry);
    expect(tx.location.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'loc-1', tenantId: 'tenant-a' },
      }),
    );
    expect(tx.product.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'prod-1', tenantId: 'tenant-a' },
      }),
    );
  });

  it.each([
    ['location', { location: { findFirst: jest.fn().mockResolvedValue(null) } }, 'location-not-found'],
    ['product', { product: { findFirst: jest.fn().mockResolvedValue(null) } }, 'product-not-found'],
  ] as const)(
    'returns a sentinel when the %s is not in this tenant',
    async (_entity, overrides, expected) => {
      const tx = buildTx(overrides);
      const repository = buildRepository(tx);
      await expect(
        repository.adjust('tenant-a', input, buildAuditEntry),
      ).resolves.toBe(expected);
      expect(tx.inventoryMovement.create).not.toHaveBeenCalled();
      expect(auditLog.record).not.toHaveBeenCalled();
    },
  );

  it('refuses adjustments on ARCHIVED products', async () => {
    const tx = buildTx({
      product: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'prod-1', status: 'ARCHIVED' }),
      },
    });
    const repository = buildRepository(tx);
    await expect(
      repository.adjust('tenant-a', input, buildAuditEntry),
    ).resolves.toBe('product-archived');
  });

  it('changes stock ONLY via a conditional atomic increment', async () => {
    const tx = buildTx();
    const repository = buildRepository(tx);
    await repository.adjust('tenant-a', input, buildAuditEntry);
    expect(tx.inventoryLevel.updateMany).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant-a',
        locationId: 'loc-1',
        productId: 'prod-1',
        // -(-4) = 4: the increment only matches when quantity >= 4, so the
        // result can never go negative — even under concurrency.
        quantity: { gte: 4 },
      },
      data: { quantity: { increment: -4 } },
    });
    // Never a direct `quantity = X` assignment from user input.
    const updateData = tx.inventoryLevel.updateMany.mock.calls[0][0].data;
    expect(updateData.quantity).toEqual({ increment: -4 });
  });

  it('positive deltas require no minimum stock', async () => {
    const tx = buildTx();
    const repository = buildRepository(tx);
    await repository.adjust(
      'tenant-a',
      { ...input, quantityDelta: 10 },
      buildAuditEntry,
    );
    expect(
      tx.inventoryLevel.updateMany.mock.calls[0][0].where.quantity,
    ).toEqual({ gte: 0 });
  });

  it('reports insufficient stock without appending a movement', async () => {
    const tx = buildTx({
      inventoryLevel: {
        upsert: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findUniqueOrThrow: jest.fn(),
      },
    });
    const repository = buildRepository(tx);
    await expect(
      repository.adjust('tenant-a', input, buildAuditEntry),
    ).resolves.toBe('insufficient-stock');
    expect(tx.inventoryMovement.create).not.toHaveBeenCalled();
    expect(auditLog.record).not.toHaveBeenCalled();
  });

  it('appends the ledger row with the post-adjustment snapshot and audits in the SAME transaction', async () => {
    const tx = buildTx();
    const repository = buildRepository(tx);
    const result = await repository.adjust('tenant-a', input, buildAuditEntry);

    expect(tx.inventoryMovement.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: 'tenant-a',
        locationId: 'loc-1',
        productId: 'prod-1',
        movementType: 'ADJUSTMENT',
        quantityDelta: -4,
        quantityAfter: 6,
        reason: 'Damaged cans',
        createdById: 'user-1',
      }),
    });
    // The audit row is written through the SAME tx client — atomic with the
    // movement and the level change.
    expect(auditLog.record).toHaveBeenCalledWith(expect.any(Object), tx);
    expect(result).toEqual(
      expect.objectContaining({
        level: expect.objectContaining({ quantity: 6 }),
        movement: expect.objectContaining({ quantityAfter: 6 }),
      }),
    );
  });
});

describe('InventoryRepository reads', () => {
  const auditLog = { record: jest.fn() };

  it('always scopes level and movement queries by tenant', async () => {
    const prisma = {
      inventoryLevel: { findMany: jest.fn().mockResolvedValue([]) },
      inventoryMovement: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
    } as unknown as PrismaService;
    const repository = new InventoryRepository(
      prisma,
      auditLog as unknown as AuditLogService,
    );

    await repository.findLevels('tenant-a', { locationId: 'loc-1' });
    expect(
      (prisma.inventoryLevel.findMany as jest.Mock).mock.calls[0][0].where,
    ).toEqual(expect.objectContaining({ tenantId: 'tenant-a' }));

    await repository.findMovements('tenant-a', {});
    expect(
      (prisma.inventoryMovement.findMany as jest.Mock).mock.calls[0][0].where,
    ).toEqual(expect.objectContaining({ tenantId: 'tenant-a' }));

    expect(() => repository.findLevels('', {})).toThrow(
      TenantIdRequiredError,
    );
  });
});
