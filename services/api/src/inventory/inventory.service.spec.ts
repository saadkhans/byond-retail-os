import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, InventoryLevel, InventoryMovement } from '@prisma/client';
import { AuditEntry } from '../common/audit/audit-log.service';
import {
  InventoryLevelWithRefs,
  InventoryRepository,
} from './inventory.repository';
import { InventoryService } from './inventory.service';

describe('InventoryService', () => {
  const actor = { id: 'user-1', email: 'jane@tenant-a.example' };
  const level = {
    id: 'level-1',
    tenantId: 'tenant-a',
    locationId: 'loc-1',
    productId: 'prod-1',
    quantity: 6,
  } as InventoryLevel;
  const movement = {
    id: 'move-1',
    tenantId: 'tenant-a',
    locationId: 'loc-1',
    productId: 'prod-1',
    movementType: 'ADJUSTMENT',
    quantityDelta: -4,
    quantityAfter: 6,
    reason: 'Damaged cans',
  } as InventoryMovement;

  let repository: {
    adjust: jest.Mock;
    findLevels: jest.Mock;
    findMovements: jest.Mock;
  };
  let service: InventoryService;

  beforeEach(() => {
    repository = {
      adjust: jest.fn().mockResolvedValue({ level, movement }),
      findLevels: jest.fn().mockResolvedValue([]),
      findMovements: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    };
    service = new InventoryService(
      repository as unknown as InventoryRepository,
    );
  });

  it('rejects a whitespace-only reason before touching the repository', async () => {
    await expect(
      service.adjustStock(
        'tenant-a',
        { locationId: 'loc-1', productId: 'prod-1', quantityDelta: 1, reason: '  ' },
        actor,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repository.adjust).not.toHaveBeenCalled();
  });

  it('rejects a credential-/payment-bearing reason before any ledger write', async () => {
    // The ledger is append-only, so a PAN in a reason would be permanent.
    for (const reason of [
      'refund to card 4111111111111111 cvv=123',
      'card 4111-1111-1111-1111 chargeback',
      'api_key=sk_live_abcdefgh12345678',
      // Strict free-text screen: dot/underscore-grouped PANs and
      // separator-free credential labels reject too (the weak value screen
      // only bridged space/dash and needed '='/':').
      'card 4111_1111_1111_1111 chargeback',
      'damaged cvv 123',
      'password hunter2',
    ]) {
      await expect(
        service.adjustStock(
          'tenant-a',
          { locationId: 'loc-1', productId: 'prod-1', quantityDelta: 1, reason },
          actor,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(repository.adjust).not.toHaveBeenCalled();
  });

  it('re-validates the non-zero integer delta independently of the DTO', async () => {
    for (const quantityDelta of [0, 1.5, Number.NaN]) {
      await expect(
        service.adjustStock(
          'tenant-a',
          { locationId: 'loc-1', productId: 'prod-1', quantityDelta, reason: 'x' },
          actor,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(repository.adjust).not.toHaveBeenCalled();
  });

  it.each([
    ['location-not-found', NotFoundException],
    ['product-not-found', NotFoundException],
    ['product-archived', ConflictException],
    ['insufficient-stock', ConflictException],
  ] as const)('maps the %s failure to the right HTTP error', async (failure, errorType) => {
    repository.adjust.mockResolvedValue(failure);
    await expect(
      service.adjustStock(
        'tenant-a',
        { locationId: 'loc-1', productId: 'prod-1', quantityDelta: -4, reason: 'x' },
        actor,
      ),
    ).rejects.toBeInstanceOf(errorType);
  });

  it('redacts a PAN-valued id from the 404 message instead of echoing it', async () => {
    // The DTO puts no charset on locationId/productId, and 404 bodies land
    // in logs/telemetry — a PAN smuggled as an id must echo as [REDACTED].
    for (const [failure, dto] of [
      [
        'location-not-found',
        { locationId: '4111111111111111', productId: 'prod-1' },
      ],
      [
        'product-not-found',
        { locationId: 'loc-1', productId: '4111.1111.1111.1111' },
      ],
    ] as const) {
      repository.adjust.mockResolvedValue(failure);
      const rejection = service.adjustStock(
        'tenant-a',
        { ...dto, quantityDelta: 1, reason: 'x' },
        actor,
      );
      await expect(rejection).rejects.toBeInstanceOf(NotFoundException);
      await expect(rejection).rejects.toThrow('[REDACTED]');
      await expect(rejection).rejects.not.toThrow(/4111/);
    }
  });

  it('records a STOCK_ADJUSTMENT audit entry with before/after quantities', async () => {
    await service.adjustStock(
      'tenant-a',
      {
        locationId: 'loc-1',
        productId: 'prod-1',
        quantityDelta: -4,
        reason: ' Damaged cans ',
      },
      actor,
    );
    expect(repository.adjust).toHaveBeenCalledWith(
      'tenant-a',
      expect.objectContaining({
        quantityDelta: -4,
        reason: 'Damaged cans',
        createdById: 'user-1',
      }),
      expect.any(Function),
    );
    const buildAuditEntry = repository.adjust.mock.calls[0][2] as (
      recordedMovement: InventoryMovement,
      recordedLevel: InventoryLevel,
    ) => AuditEntry;
    expect(buildAuditEntry(movement, level)).toEqual(
      expect.objectContaining({
        tenantId: 'tenant-a',
        actorId: 'user-1',
        action: AuditAction.STOCK_ADJUSTMENT,
        entityType: 'InventoryMovement',
        entityId: movement.id,
        before: { quantity: 10 },
        after: expect.objectContaining({ quantity: 6, quantityDelta: -4 }),
      }),
    );
  });

  it('computes isLowStock from the product threshold and filters lowStockOnly', async () => {
    const levels = [
      {
        id: 'level-1',
        quantity: 2,
        product: { lowStockThreshold: 5 },
      },
      {
        id: 'level-2',
        quantity: 50,
        product: { lowStockThreshold: 5 },
      },
      {
        id: 'level-3',
        quantity: 0,
        product: { lowStockThreshold: null },
      },
    ] as unknown as InventoryLevelWithRefs[];
    repository.findLevels.mockResolvedValue(levels);

    const all = await service.getLevels('tenant-a', {});
    expect(all.map((view) => view.isLowStock)).toEqual([true, false, false]);

    const lowOnly = await service.getLevels('tenant-a', {
      lowStockOnly: 'true',
    });
    expect(lowOnly.map((view) => view.id)).toEqual(['level-1']);
  });

  it('passes ledger filters through to the repository', async () => {
    await service.getMovements('tenant-a', {
      locationId: 'loc-1',
      productId: 'prod-1',
      skip: 10,
      take: 20,
    });
    expect(repository.findMovements).toHaveBeenCalledWith('tenant-a', {
      locationId: 'loc-1',
      productId: 'prod-1',
      skip: 10,
      take: 20,
    });
  });
});
