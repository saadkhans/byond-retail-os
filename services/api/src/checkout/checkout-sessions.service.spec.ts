import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, CheckoutSessionStatus } from '@prisma/client';
import { AuditEntry } from '../common/audit/audit-log.service';
import {
  CheckoutSessionDetail,
  CheckoutSessionsRepository,
} from './checkout-sessions.repository';
import { CheckoutSessionsService } from './checkout-sessions.service';

describe('CheckoutSessionsService', () => {
  const sessionDetail = {
    id: 'sess-1',
    tenantId: 'tenant-a',
    status: CheckoutSessionStatus.OPEN,
    lines: [],
    order: null,
  } as unknown as CheckoutSessionDetail;

  const actor = { id: 'user-1', email: 'jane@tenant-a.example' };

  let repository: {
    create: jest.Mock;
    findByIdempotencyKey: jest.Mock;
    findOrderByIdempotencyKey: jest.Mock;
    findById: jest.Mock;
    search: jest.Mock;
    updateStatus: jest.Mock;
    addLine: jest.Mock;
    updateLine: jest.Mock;
    removeLine: jest.Mock;
    complete: jest.Mock;
  };
  let service: CheckoutSessionsService;

  beforeEach(() => {
    repository = {
      create: jest
        .fn()
        .mockResolvedValue({ session: sessionDetail, replayed: false }),
      findByIdempotencyKey: jest.fn().mockResolvedValue(null),
      findOrderByIdempotencyKey: jest.fn().mockResolvedValue(null),
      findById: jest.fn().mockResolvedValue(sessionDetail),
      search: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      updateStatus: jest.fn().mockResolvedValue(sessionDetail),
      addLine: jest
        .fn()
        .mockResolvedValue({ line: { id: 'line-1' }, replayed: false }),
      updateLine: jest.fn().mockResolvedValue({ id: 'line-1' }),
      removeLine: jest.fn().mockResolvedValue({ id: 'line-1' }),
      complete: jest.fn().mockResolvedValue({
        order: { id: 'order-1', orderNumber: 'ORD-000001' },
        replayed: false,
      }),
    };
    service = new CheckoutSessionsService(
      repository as unknown as CheckoutSessionsRepository,
    );
  });

  describe('create', () => {
    it('builds a CREATE audit entry for the session', async () => {
      await service.create(
        'tenant-a',
        { locationId: 'loc-a1', unitId: 'unit-a1' },
        actor,
      );
      const buildAuditEntry = repository.create.mock.calls[0][2] as (
        session: CheckoutSessionDetail,
      ) => AuditEntry;
      expect(buildAuditEntry(sessionDetail)).toEqual(
        expect.objectContaining({
          tenantId: 'tenant-a',
          actorId: 'user-1',
          action: AuditAction.CREATE,
          entityType: 'CheckoutSession',
          entityId: 'sess-1',
        }),
      );
    });

    it.each([
      'location-not-found',
      'unit-not-found',
      'unit-location-mismatch',
      'device-not-found',
      'device-unit-mismatch',
    ] as const)('maps %s to a 400', async (rejection) => {
      repository.create.mockResolvedValue(rejection);
      await expect(
        service.create('tenant-a', {
          locationId: 'loc-a1',
          unitId: 'unit-a1',
          deviceId: 'dev-1',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('replays the winner on an idempotency-key P2002 race', async () => {
      repository.create.mockRejectedValue({ code: 'P2002' });
      repository.findByIdempotencyKey.mockResolvedValue(sessionDetail);
      await expect(
        service.create('tenant-a', {
          locationId: 'loc-a1',
          unitId: 'unit-a1',
          idempotencyKey: 'key-1',
        }),
      ).resolves.toBe(sessionDetail);
      expect(repository.findByIdempotencyKey).toHaveBeenCalledWith(
        'tenant-a',
        'key-1',
      );
    });
  });

  describe('evidence reference safety (payments invariant)', () => {
    // Persisted verbatim → must never carry credential/payment content.
    const rejects = async (dto: Record<string, unknown>) => {
      await expect(
        service.create('tenant-a', {
          locationId: 'loc-a1',
          unitId: 'unit-a1',
          ...dto,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.addLine('tenant-a', 'sess-1', {
          productId: 'prod-a',
          quantity: 1,
          ...dto,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.updateLine('tenant-a', 'sess-1', 'line-1', dto),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repository.create).not.toHaveBeenCalled();
      expect(repository.addLine).not.toHaveBeenCalled();
      expect(repository.updateLine).not.toHaveBeenCalled();
    };

    it('rejects a raw PAN in sourceId with a controlled 400', async () => {
      await rejects({ sourceId: '4111 1111 1111 1111' });
    });

    it('rejects token/api_key/password fragments in evidence fields', async () => {
      // Key-shaped values are assembled at runtime so the repo never carries
      // a static secret-shaped literal (Gitleaks scans every commit diff).
      const keyShapedValue = ['sk', 'live', 'abc123'].join('_');
      const tokenShapedValue = ['eyJhbGciOi', 'JIUzI1NiJ9'].join('');
      await rejects({ visionEventId: `api_key=${keyShapedValue}` });
      await rejects({ vlmReviewId: 'password: hunter2' });
      await rejects({ sourceId: `access_token=${tokenShapedValue}` });
    });

    it('rejects a credential URL in evidenceBundleId', async () => {
      await rejects({
        evidenceBundleId: 'rtsp://admin:pass@camera-aisle-01.local/feed',
      });
      await rejects({
        evidenceBundleId: 'https://cdn.example/bundle?access_token=abc',
      });
    });

    it('rejects CVV/PIN/PAN content in reasonCodes', async () => {
      await rejects({ reasonCodes: ['cvv=123'] });
      await rejects({ reasonCodes: ['pin: 1234'] });
      await rejects({ reasonCodes: ['ok', '4242424242424242'] });
    });

    it('accepts safe opaque references and reason codes', async () => {
      await service.create('tenant-a', {
        locationId: 'loc-a1',
        unitId: 'unit-a1',
        sourceId: 'camera-aisle-01',
        evidenceBundleId: 'bundle_001',
        visionEventId: 'vision_evt_123',
        vlmReviewId: 'vlm_review_abc',
        reasonCodes: ['shelf_pickup_observed'],
      });
      expect(repository.create).toHaveBeenCalledWith(
        'tenant-a',
        expect.objectContaining({
          sourceId: 'camera-aisle-01',
          evidenceBundleId: 'bundle_001',
          visionEventId: 'vision_evt_123',
          vlmReviewId: 'vlm_review_abc',
          reasonCodes: ['shelf_pickup_observed'],
        }),
        expect.any(Function),
      );
      await service.addLine('tenant-a', 'sess-1', {
        productId: 'prod-a',
        quantity: 1,
        sourceId: 'camera-aisle-01',
        visionEventId: 'vision_evt_123',
        reasonCodes: ['shelf_pickup_observed'],
      });
      expect(repository.addLine).toHaveBeenCalled();
    });
  });

  describe('idempotency key safety (payments invariant)', () => {
    // Persisted verbatim onto session/line/order rows → same opaqueness
    // rule as evidence refs. Key-shaped fragments are assembled at runtime
    // so the repo never carries a static secret-shaped literal (Gitleaks
    // scans every commit diff).
    const keyShapedValue = ['sk', 'live', 'abc123'].join('_');
    const sensitiveKeys = [
      '4242424242424242',
      `token=${keyShapedValue}`,
      'rtsp://admin:pass@cam-1.local/feed',
    ];

    const rejectsKey = async (idempotencyKey: string) => {
      await expect(
        service.create('tenant-a', {
          locationId: 'loc-a1',
          unitId: 'unit-a1',
          idempotencyKey,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.addLine('tenant-a', 'sess-1', {
          productId: 'prod-a',
          quantity: 1,
          idempotencyKey,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.complete('tenant-a', 'sess-1', { idempotencyKey }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repository.create).not.toHaveBeenCalled();
      expect(repository.addLine).not.toHaveBeenCalled();
      expect(repository.complete).not.toHaveBeenCalled();
    };

    it('rejects a raw PAN used as an idempotency key (400, before any write)', async () => {
      await rejectsKey(sensitiveKeys[0]);
    });

    it('rejects a token fragment used as an idempotency key', async () => {
      await rejectsKey(sensitiveKeys[1]);
    });

    it('rejects a credential URL used as an idempotency key', async () => {
      await rejectsKey(sensitiveKeys[2]);
    });

    it('accepts safe opaque idempotency keys on create/addLine/complete', async () => {
      const idempotencyKey = 'checkout-2026-07-14-unit-a1-0001';
      await service.create('tenant-a', {
        locationId: 'loc-a1',
        unitId: 'unit-a1',
        idempotencyKey,
      });
      expect(repository.create).toHaveBeenCalledWith(
        'tenant-a',
        expect.objectContaining({ idempotencyKey }),
        expect.any(Function),
      );
      await service.addLine('tenant-a', 'sess-1', {
        productId: 'prod-a',
        quantity: 1,
        idempotencyKey,
      });
      expect(repository.addLine).toHaveBeenCalled();
      await service.complete('tenant-a', 'sess-1', { idempotencyKey });
      expect(repository.complete).toHaveBeenCalledWith(
        'tenant-a',
        'sess-1',
        expect.objectContaining({ idempotencyKey }),
        expect.anything(),
      );
    });
  });

  describe('updateStatus', () => {
    it('uses CANCEL/EXPIRE audit actions for terminal targets and UPDATE otherwise', async () => {
      for (const [status, action] of [
        [CheckoutSessionStatus.CANCELLED, AuditAction.CANCEL],
        [CheckoutSessionStatus.EXPIRED, AuditAction.EXPIRE],
        [CheckoutSessionStatus.ACTIVE, AuditAction.UPDATE],
      ] as const) {
        repository.updateStatus.mockClear();
        await service.updateStatus('tenant-a', 'sess-1', { status }, actor);
        const buildAuditEntry = repository.updateStatus.mock.calls[0][3] as (
          before: unknown,
          after: CheckoutSessionDetail,
        ) => AuditEntry;
        expect(buildAuditEntry(sessionDetail, sessionDetail).action).toBe(
          action,
        );
      }
    });

    it('maps terminal and illegal transitions to 409', async () => {
      repository.updateStatus.mockResolvedValue('terminal-blocked');
      await expect(
        service.updateStatus('tenant-a', 'sess-1', {
          status: CheckoutSessionStatus.CANCELLED,
        }),
      ).rejects.toBeInstanceOf(ConflictException);

      repository.updateStatus.mockResolvedValue('transition-blocked');
      await expect(
        service.updateStatus('tenant-a', 'sess-1', {
          status: CheckoutSessionStatus.ACTIVE,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('maps a missing session to 404', async () => {
      repository.updateStatus.mockResolvedValue(null);
      await expect(
        service.updateStatus('tenant-a', 'missing', {
          status: CheckoutSessionStatus.ACTIVE,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('lines', () => {
    it('maps line rejections to the right HTTP errors', async () => {
      repository.addLine.mockResolvedValue('product-not-found');
      await expect(
        service.addLine('tenant-a', 'sess-1', {
          productId: 'prod-x',
          quantity: 1,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);

      repository.addLine.mockResolvedValue('product-not-saleable');
      await expect(
        service.addLine('tenant-a', 'sess-1', {
          productId: 'prod-x',
          quantity: 1,
        }),
      ).rejects.toBeInstanceOf(ConflictException);

      repository.addLine.mockResolvedValue('session-terminal');
      await expect(
        service.addLine('tenant-a', 'sess-1', {
          productId: 'prod-x',
          quantity: 1,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('maps a duplicate product line to 409', async () => {
      repository.addLine.mockRejectedValue({ code: 'P2002' });
      await expect(
        service.addLine('tenant-a', 'sess-1', {
          productId: 'prod-a',
          quantity: 1,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('maps a consumed (removed-line) idempotency key to 409 — never a resurrect', async () => {
      repository.addLine.mockResolvedValue('idempotency-key-consumed');
      await expect(
        service.addLine('tenant-a', 'sess-1', {
          productId: 'prod-a',
          quantity: 1,
          idempotencyKey: 'key-K',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('rejects an empty line update before touching the repository', async () => {
      await expect(
        service.updateLine('tenant-a', 'sess-1', 'line-1', {}),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repository.updateLine).not.toHaveBeenCalled();
    });

    it('treats an evidence-only update as a change', async () => {
      await service.updateLine('tenant-a', 'sess-1', 'line-1', {
        vlmReviewId: 'review-1',
      });
      expect(repository.updateLine).toHaveBeenCalledWith(
        'tenant-a',
        'sess-1',
        'line-1',
        expect.objectContaining({ vlmReviewId: 'review-1' }),
        expect.any(Function),
      );
    });

    it('builds a DELETE audit entry on remove', async () => {
      await service.removeLine('tenant-a', 'sess-1', 'line-1', actor);
      const buildAuditEntry = repository.removeLine.mock.calls[0][3] as (
        deleted: unknown,
      ) => AuditEntry;
      expect(buildAuditEntry({ id: 'line-1' })).toEqual(
        expect.objectContaining({
          action: AuditAction.DELETE,
          entityType: 'CheckoutSessionLine',
          actorId: 'user-1',
        }),
      );
    });
  });

  describe('complete', () => {
    it('returns the created order', async () => {
      await expect(
        service.complete('tenant-a', 'sess-1', {}, actor),
      ).resolves.toEqual(
        expect.objectContaining({ orderNumber: 'ORD-000001' }),
      );
    });

    it('names the failing SKU on insufficient stock', async () => {
      repository.complete.mockResolvedValue({
        stockFailure: 'insufficient-stock',
        sku: 'SKU-B',
      });
      await expect(
        service.complete('tenant-a', 'sess-1', {}),
      ).rejects.toMatchObject({
        message: expect.stringContaining('SKU-B') as string,
        status: 409,
      });
    });

    it.each([
      ['already-completed'],
      ['session-terminal'],
      ['empty-session'],
      ['idempotency-key-conflict'],
    ] as const)('maps %s to 409', async (rejection) => {
      repository.complete.mockResolvedValue(rejection);
      await expect(
        service.complete('tenant-a', 'sess-1', {}),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it.each([
      ['product-not-saleable'],
      ['unit-of-measure-changed'],
    ] as const)('names the failing SKU on a %s rollback (409)', async (reason) => {
      repository.complete.mockResolvedValue({
        stockFailure: reason,
        sku: 'SKU-B',
      });
      await expect(
        service.complete('tenant-a', 'sess-1', {}),
      ).rejects.toMatchObject({
        message: expect.stringContaining('SKU-B') as string,
        status: 409,
      });
    });

    it('replays the winning order when a completion P2002 race was THIS session', async () => {
      repository.complete.mockRejectedValue({ code: 'P2002' });
      const winner = {
        id: 'order-1',
        orderNumber: 'ORD-000001',
        checkoutSessionId: 'sess-1',
      };
      repository.findOrderByIdempotencyKey = jest
        .fn()
        .mockResolvedValue(winner);
      await expect(
        service.complete('tenant-a', 'sess-1', { idempotencyKey: 'key-1' }),
      ).resolves.toBe(winner);
      expect(repository.findOrderByIdempotencyKey).toHaveBeenCalledWith(
        'tenant-a',
        'key-1',
      );
    });

    it('maps a completion P2002 race lost to ANOTHER session to 409, never 500', async () => {
      repository.complete.mockRejectedValue({ code: 'P2002' });
      repository.findOrderByIdempotencyKey = jest.fn().mockResolvedValue({
        id: 'order-x',
        orderNumber: 'ORD-000009',
        checkoutSessionId: 'sess-OTHER',
      });
      await expect(
        service.complete('tenant-a', 'sess-1', { idempotencyKey: 'key-1' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('rethrows a P2002 with no idempotency key (not a replayable race)', async () => {
      repository.complete.mockRejectedValue({ code: 'P2002' });
      await expect(
        service.complete('tenant-a', 'sess-1', {}),
      ).rejects.toMatchObject({ code: 'P2002' });
    });

    it('maps a missing session to 404', async () => {
      repository.complete.mockResolvedValue('session-not-found');
      await expect(
        service.complete('tenant-a', 'missing', {}),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('builds COMPLETE, order CREATE, and STOCK_ADJUSTMENT audit entries', async () => {
      await service.complete('tenant-a', 'sess-1', {}, actor);
      const builders = repository.complete.mock.calls[0][3] as {
        sessionCompleted: (b: unknown, a: { id: string }) => AuditEntry;
        orderCreated: (o: { id: string; orderNumber: string }) => AuditEntry;
        stockConsumed: (
          m: { id: string },
          l: { quantity: number },
          line: { sku: string },
        ) => AuditEntry;
      };
      expect(
        builders.sessionCompleted(sessionDetail, { id: 'sess-1' }),
      ).toEqual(
        expect.objectContaining({
          action: AuditAction.COMPLETE,
          entityType: 'CheckoutSession',
        }),
      );
      expect(
        builders.orderCreated({ id: 'order-1', orderNumber: 'ORD-000001' }),
      ).toEqual(
        expect.objectContaining({
          action: AuditAction.CREATE,
          entityType: 'Order',
        }),
      );
      expect(
        builders.stockConsumed(
          { id: 'mov-1' },
          { quantity: 4 },
          { sku: 'SKU-A' },
        ),
      ).toEqual(
        expect.objectContaining({
          action: AuditAction.STOCK_ADJUSTMENT,
          entityType: 'InventoryMovement',
          entityId: 'mov-1',
        }),
      );
    });
  });
});
