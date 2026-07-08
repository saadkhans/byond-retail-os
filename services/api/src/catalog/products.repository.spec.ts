import { AuditLogService } from '../common/audit/audit-log.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProductsRepository } from './products.repository';

describe('ProductsRepository.update (in-transaction guards)', () => {
  const auditLog = { record: jest.fn().mockResolvedValue(undefined) };
  const buildAuditEntry = jest.fn().mockReturnValue({
    tenantId: 'tenant-a',
    actorEmail: 'jane@tenant-a.example',
    action: 'UPDATE',
    entityType: 'Product',
  });

  function buildTx(overrides: Record<string, unknown> = {}) {
    return {
      // Per-product advisory lock shared with inventory adjust().
      $queryRaw: jest.fn().mockResolvedValue([1]),
      product: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'prod-1',
          tenantId: 'tenant-a',
          unitOfMeasure: 'EACH',
          status: 'ACTIVE',
        }),
        update: jest
          .fn()
          .mockImplementation(({ data }) =>
            Promise.resolve({ id: 'prod-1', ...data, barcodes: [] }),
          ),
      },
      inventoryMovement: {
        count: jest.fn().mockResolvedValue(0),
      },
      inventoryLevel: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      ...overrides,
    };
  }

  function buildRepository(tx: ReturnType<typeof buildTx>) {
    const prisma = {
      $transaction: (callback: (client: unknown) => unknown) => callback(tx),
    } as unknown as PrismaService;
    return new ProductsRepository(
      prisma,
      auditLog as unknown as AuditLogService,
    );
  }

  beforeEach(() => {
    auditLog.record.mockClear();
  });

  it('rejects a unit-of-measure change once ledger history exists', async () => {
    const tx = buildTx({
      product: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'prod-1',
          unitOfMeasure: 'EACH',
          status: 'ACTIVE',
        }),
        update: jest.fn(),
      },
      inventoryMovement: { count: jest.fn().mockResolvedValue(3) },
      inventoryLevel: { findFirst: jest.fn() },
    });
    const repository = buildRepository(tx);
    await expect(
      repository.update(
        'tenant-a',
        'prod-1',
        { unitOfMeasure: 'CASE' },
        buildAuditEntry,
      ),
    ).resolves.toBe('uom-change-blocked');
    expect(tx.product.update).not.toHaveBeenCalled();
    expect(auditLog.record).not.toHaveBeenCalled();
  });

  it('allows a unit-of-measure change when there is no ledger history', async () => {
    const tx = buildTx();
    const repository = buildRepository(tx);
    const result = await repository.update(
      'tenant-a',
      'prod-1',
      { unitOfMeasure: 'CASE' },
      buildAuditEntry,
    );
    expect(tx.inventoryMovement.count).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-a', productId: 'prod-1' },
    });
    expect(tx.product.update).toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ unitOfMeasure: 'CASE' }));
  });

  it('takes the advisory lock on ledger-dependent updates (UOM/archive)', async () => {
    const uomTx = buildTx();
    await buildRepository(uomTx).update(
      'tenant-a',
      'prod-1',
      { unitOfMeasure: 'CASE' },
      buildAuditEntry,
    );
    expect(uomTx.$queryRaw).toHaveBeenCalled();

    const archiveTx = buildTx();
    await buildRepository(archiveTx).update(
      'tenant-a',
      'prod-1',
      { status: 'ARCHIVED' },
      buildAuditEntry,
    );
    expect(archiveTx.$queryRaw).toHaveBeenCalled();
  });

  it('does NOT take the advisory lock for a plain field update', async () => {
    const tx = buildTx();
    await buildRepository(tx).update(
      'tenant-a',
      'prod-1',
      { name: 'Renamed' },
      buildAuditEntry,
    );
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(tx.product.update).toHaveBeenCalled();
  });

  it('does not re-check UOM history when the unit is unchanged', async () => {
    const tx = buildTx();
    const repository = buildRepository(tx);
    await repository.update(
      'tenant-a',
      'prod-1',
      { unitOfMeasure: 'EACH' },
      buildAuditEntry,
    );
    expect(tx.inventoryMovement.count).not.toHaveBeenCalled();
    expect(tx.product.update).toHaveBeenCalled();
  });

  it('rejects archiving a product that still has on-hand stock', async () => {
    const tx = buildTx({
      inventoryLevel: {
        findFirst: jest.fn().mockResolvedValue({ id: 'level-1' }),
      },
    });
    const repository = buildRepository(tx);
    await expect(
      repository.update(
        'tenant-a',
        'prod-1',
        { status: 'ARCHIVED' },
        buildAuditEntry,
      ),
    ).resolves.toBe('archive-blocked');
    // Only levels with quantity > 0 count as stranded stock.
    expect(tx.inventoryLevel.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'tenant-a',
          productId: 'prod-1',
          quantity: { gt: 0 },
        }),
      }),
    );
    expect(tx.product.update).not.toHaveBeenCalled();
  });

  it('allows archiving when no on-hand stock remains', async () => {
    const tx = buildTx();
    const repository = buildRepository(tx);
    const result = await repository.update(
      'tenant-a',
      'prod-1',
      { status: 'ARCHIVED' },
      buildAuditEntry,
    );
    expect(tx.product.update).toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ status: 'ARCHIVED' }));
  });

  it('404-signals (null) when the product is not in this tenant', async () => {
    const tx = buildTx({
      product: {
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
      },
    });
    const repository = buildRepository(tx);
    await expect(
      repository.update('tenant-a', 'prod-x', { name: 'X' }, buildAuditEntry),
    ).resolves.toBeNull();
    expect(tx.product.update).not.toHaveBeenCalled();
  });
});

describe('ProductsRepository.delete (barcode audit)', () => {
  const auditLog = { record: jest.fn().mockResolvedValue(undefined) };

  it('captures the removed barcodes in the delete audit snapshot', async () => {
    const existing = {
      id: 'prod-1',
      tenantId: 'tenant-a',
      sku: 'BEV-1',
      barcodes: [
        { id: 'bc-1', value: '4006381333931' },
        { id: 'bc-2', value: '5000112637922' },
      ],
    };
    const tx = {
      product: {
        findFirst: jest.fn().mockResolvedValue(existing),
        delete: jest.fn().mockResolvedValue(existing),
      },
      productBarcode: {
        deleteMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
    };
    const prisma = {
      $transaction: (callback: (client: unknown) => unknown) => callback(tx),
    } as unknown as PrismaService;
    const repository = new ProductsRepository(
      prisma,
      auditLog as unknown as AuditLogService,
    );

    const buildAuditEntry = jest.fn().mockReturnValue({ action: 'DELETE' });
    await repository.delete('tenant-a', 'prod-1', buildAuditEntry);

    // The product is loaded WITH its barcodes so the audit before-snapshot
    // records the scan identifiers being removed.
    expect(tx.product.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ include: { barcodes: true } }),
    );
    expect(buildAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        barcodes: expect.arrayContaining([
          expect.objectContaining({ value: '4006381333931' }),
          expect.objectContaining({ value: '5000112637922' }),
        ]),
      }),
    );
    expect(tx.productBarcode.deleteMany).toHaveBeenCalled();
    expect(tx.product.delete).toHaveBeenCalled();
    expect(auditLog.record).toHaveBeenCalledWith(expect.any(Object), tx);
  });
});
