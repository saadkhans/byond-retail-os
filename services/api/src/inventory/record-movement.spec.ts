import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { InventoryService } from './inventory.service';
import {
  EXTERNAL_MOVEMENT_REFERENCE_TYPE,
  InventoryRepository,
} from './inventory.repository';

/**
 * "Record inventory movement" contract: append-only via the shared
 * applyMovement seam, positive quantities with type-carried direction,
 * idempotent-by-reference replay, and tenant scoping.
 */

const TENANT = 'tenant-1';
const ACTOR = { id: 'user-1', email: 'admin@byond.local' };

const VALID = {
  locationId: 'store-1',
  productId: 'prod-1',
  movementType: 'RECEIPT' as const,
  quantity: 1,
  reason: 'Controlled pickup pipeline test',
  reference: 'WATER-BOTTLE-TEST-001',
};

function buildService(overrides: {
  result?: unknown;
} = {}) {
  const recordExternalMovement = jest.fn(async () =>
    overrides.result ?? {
      movement: { id: 'mv-1', quantityDelta: 1, movementType: 'RECEIPT', locationId: 'store-1', productId: 'prod-1' },
      level: { quantity: 1 },
      replayed: false,
    },
  );
  const repository = { recordExternalMovement } as unknown as InventoryRepository;
  return { service: new InventoryService(repository), recordExternalMovement };
}

describe('InventoryService.recordMovement', () => {
  it('records a RECEIPT as a POSITIVE ledger delta with the reference attached', async () => {
    const { service, recordExternalMovement } = buildService();
    const result = await service.recordMovement(TENANT, VALID, ACTOR);
    expect(result.replayed).toBe(false);
    expect(result.level.quantity).toBe(1);
    const args = recordExternalMovement.mock.calls[0] as unknown[];
    expect(args[0]).toBe(TENANT);
    expect(args[1]).toMatchObject({
      movementType: 'RECEIPT',
      quantityDelta: 1,
      reference: 'WATER-BOTTLE-TEST-001',
      reason: 'Controlled pickup pipeline test',
    });
  });

  it('CORRECTION_OUT carries direction server-side (negative delta from a positive quantity)', async () => {
    const { service, recordExternalMovement } = buildService();
    await service.recordMovement(
      TENANT,
      { ...VALID, movementType: 'CORRECTION_OUT', quantity: 2, reference: 'REF-OUT-1' },
      ACTOR,
    );
    expect(
      (recordExternalMovement.mock.calls[0] as unknown[])[1],
    ).toMatchObject({ quantityDelta: -2 });
  });

  it('replays a duplicate reference without a second write (idempotent)', async () => {
    const { service } = buildService({
      result: {
        movement: { id: 'mv-1', quantityDelta: 1, movementType: 'RECEIPT', locationId: 'store-1', productId: 'prod-1' },
        level: { quantity: 1 },
        replayed: true,
      },
    });
    const result = await service.recordMovement(TENANT, VALID, ACTOR);
    expect(result.replayed).toBe(true);
    expect(result.level.quantity).toBe(1);
  });

  it('maps unknown store/product to 404s', async () => {
    for (const [failure, message] of [
      ['location-not-found', 'store-1'],
      ['product-not-found', 'prod-1'],
    ] as const) {
      const { service } = buildService({ result: failure });
      await expect(
        service.recordMovement(TENANT, VALID, ACTOR),
      ).rejects.toThrow(NotFoundException);
      await expect(
        service.recordMovement(TENANT, VALID, ACTOR),
      ).rejects.toThrow(message);
    }
  });

  it('rejects zero/negative/fractional quantity with 400 before any write', async () => {
    const { service, recordExternalMovement } = buildService();
    for (const quantity of [0, -1, 1.5]) {
      await expect(
        service.recordMovement(TENANT, { ...VALID, quantity }, ACTOR),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(recordExternalMovement).not.toHaveBeenCalled();
  });

  it('rejects a credential-/payment-bearing reason before any ledger write', async () => {
    // The ledger is append-only — a PAN written into a reason is permanent.
    const { service, recordExternalMovement } = buildService();
    for (const reason of [
      'refund to card 4111111111111111 cvv=123',
      'chargeback for 4111-1111-1111-1111',
      'password=hunter2 replay',
      // Strict free-text screen: separator-grouped PANs and label/value
      // pairs WITHOUT '='/':' must reject too — the weak value screen
      // (space/dash-only PAN bridging, separator-bound credentials) let
      // all of these into the append-only ledger.
      'received 4111_1111_1111_1111',
      'refund 4111.1111.1111.1111',
      'damaged cvv 123',
      'cvv123 on the slip',
      'password hunter2',
    ]) {
      await expect(
        service.recordMovement(TENANT, { ...VALID, reason }, ACTOR),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(recordExternalMovement).not.toHaveBeenCalled();
  });

  it('rejects a payment-bearing reference before any ledger write', async () => {
    // The DTO charset ([A-Za-z0-9._-]) admits PANs grouped by dash, dot,
    // or underscore; the strict free-text screen chains ALL of those
    // separators (the weak screen only bridged space/dash, so
    // '4111.1111.1111.1111' persisted verbatim).
    const { service, recordExternalMovement } = buildService();
    for (const reference of [
      '4111-1111-1111-1111',
      '4111.1111.1111.1111',
      '4111_1111_1111_1111',
    ]) {
      await expect(
        service.recordMovement(TENANT, { ...VALID, reference }, ACTOR),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(recordExternalMovement).not.toHaveBeenCalled();
  });

  it('redacts a PAN-valued id from the 404 message instead of echoing it', async () => {
    // locationId/productId carry no DTO charset guard, and 404 bodies land
    // in logs/telemetry — a PAN smuggled as an id must echo as [REDACTED].
    for (const [failure, dirty] of [
      ['location-not-found', { locationId: '4111111111111111' }],
      ['product-not-found', { productId: '4111.1111.1111.1111' }],
    ] as const) {
      const { service } = buildService({ result: failure });
      const rejection = service.recordMovement(
        TENANT,
        { ...VALID, ...dirty },
        ACTOR,
      );
      await expect(rejection).rejects.toBeInstanceOf(NotFoundException);
      await expect(rejection).rejects.toThrow('[REDACTED]');
      await expect(rejection).rejects.not.toThrow(/4111/);
    }
  });

  it('maps below-zero outcomes to a controlled 409', async () => {
    const { service } = buildService({ result: 'insufficient-stock' });
    await expect(
      service.recordMovement(
        TENANT,
        { ...VALID, movementType: 'CORRECTION_OUT' },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('InventoryRepository.recordExternalMovement tenant scoping', () => {
  it('locks on the tenant-scoped reference and scopes the replay lookup by tenant', async () => {
    const findFirstMovement = jest.fn(async (_args: unknown) => null);
    const applied = {
      movement: { id: 'mv-9', locationId: 'store-1', productId: 'prod-1', quantityDelta: 1 },
      level: { quantity: 1 },
    };
    const tx = {
      $queryRaw: jest.fn(async (..._args: unknown[]) => []),
      inventoryMovement: { findFirst: findFirstMovement },
      inventoryLevel: { findFirst: jest.fn(async () => ({ quantity: 1 })) },
    };
    const prisma = {
      $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
    };
    const auditLog = { record: jest.fn(async () => undefined) };
    const repository = new InventoryRepository(
      prisma as never,
      auditLog as never,
    );
    // The applyMovement internals are the shared seam — stub them here so
    // this test pins ONLY the reference/tenant semantics.
    (repository as unknown as { applyMovement: unknown }).applyMovement =
      jest.fn(async () => applied);

    const result = await repository.recordExternalMovement(
      TENANT,
      {
        locationId: 'store-1',
        productId: 'prod-1',
        movementType: 'RECEIPT' as never,
        quantityDelta: 1,
        reason: 'test',
        reference: 'REF-1',
      },
      () => ({}) as never,
    );
    expect((result as { replayed: boolean }).replayed).toBe(false);
    // Advisory lock key embeds the tenant — two tenants sharing a
    // reference string can never serialize on (or replay) each other.
    expect(tx.$queryRaw.mock.calls[0][1]).toBe(
      `inventory-ref:${TENANT}:REF-1`,
    );
    expect(findFirstMovement.mock.calls[0][0]).toMatchObject({
      where: {
        tenantId: TENANT,
        referenceType: EXTERNAL_MOVEMENT_REFERENCE_TYPE,
        referenceId: 'REF-1',
      },
    });
  });

  it('replays ONLY an identical request — a reused reference with different fields is a conflict', async () => {
    const stored = {
      id: 'mv-1',
      locationId: 'store-1',
      productId: 'prod-1',
      movementType: 'RECEIPT',
      quantityDelta: 5,
      reason: 'delivery',
    };
    const buildRepository = () => {
      const tx = {
        $queryRaw: jest.fn(async (..._args: unknown[]) => []),
        inventoryMovement: { findFirst: jest.fn(async () => stored) },
        inventoryLevel: { findFirst: jest.fn(async () => ({ quantity: 5 })) },
      };
      const prisma = {
        $transaction: jest.fn(
          async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
        ),
      };
      return new InventoryRepository(
        prisma as never,
        { record: jest.fn(async () => undefined) } as never,
      );
    };
    const identical = {
      locationId: 'store-1',
      productId: 'prod-1',
      movementType: 'RECEIPT' as never,
      quantityDelta: 5,
      reason: 'delivery',
      reference: 'REF-1',
    };
    // Same request-defining fields → the recorded movement replays.
    const replay = await buildRepository().recordExternalMovement(
      TENANT,
      identical,
      () => ({}) as never,
    );
    expect((replay as { replayed: boolean }).replayed).toBe(true);
    // ANY differing field → 'reference-mismatch', never a silent success.
    for (const mutation of [
      { quantityDelta: 6 },
      { productId: 'prod-OTHER' },
      { locationId: 'store-OTHER' },
      { movementType: 'CORRECTION_IN' as never },
      { reason: 'different reason' },
    ]) {
      await expect(
        buildRepository().recordExternalMovement(
          TENANT,
          { ...identical, ...mutation },
          () => ({}) as never,
        ),
      ).resolves.toBe('reference-mismatch');
    }
  });
});
