import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, OrderStatus } from '@prisma/client';
import { AuditEntry } from '../common/audit/audit-log.service';
import { OrderDetail, OrdersRepository } from './orders.repository';
import { OrdersService } from './orders.service';

describe('OrdersService', () => {
  const order = {
    id: 'order-1',
    tenantId: 'tenant-a',
    orderNumber: 'ORD-000001',
    status: OrderStatus.CONFIRMED,
    lines: [],
  } as unknown as OrderDetail;

  let repository: {
    findById: jest.Mock;
    search: jest.Mock;
    cancel: jest.Mock;
  };
  let service: OrdersService;

  beforeEach(() => {
    repository = {
      findById: jest.fn().mockResolvedValue(order),
      search: jest.fn().mockResolvedValue({ items: [order], total: 1 }),
      cancel: jest.fn().mockResolvedValue(order),
    };
    service = new OrdersService(repository as unknown as OrdersRepository);
  });

  it('maps a missing order to 404', async () => {
    repository.findById.mockResolvedValue(null);
    await expect(service.findById('tenant-a', 'missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('echoes pagination in the search envelope and forwards filters', async () => {
    const result = await service.search('tenant-a', {
      status: OrderStatus.CONFIRMED,
      orderNumber: ' ORD-000001 ',
      skip: 5,
      take: 10,
    });
    expect(result).toEqual({ items: [order], total: 1, skip: 5, take: 10 });
    expect(repository.search).toHaveBeenCalledWith(
      'tenant-a',
      expect.objectContaining({
        status: OrderStatus.CONFIRMED,
        orderNumber: 'ORD-000001',
        skip: 5,
        take: 10,
      }),
    );
  });

  describe('cancel', () => {
    it('builds a CANCEL audit entry with before/after', async () => {
      await service.cancel(
        'tenant-a',
        'order-1',
        { reason: 'Test run' },
        { id: 'user-1', email: 'jane@tenant-a.example' },
      );
      const buildAuditEntry = repository.cancel.mock.calls[0][3] as (
        before: unknown,
        after: OrderDetail,
      ) => AuditEntry;
      expect(buildAuditEntry(order, order)).toEqual(
        expect.objectContaining({
          tenantId: 'tenant-a',
          actorId: 'user-1',
          action: AuditAction.CANCEL,
          entityType: 'Order',
          entityId: 'order-1',
          reason: 'Test run',
        }),
      );
    });

    it('maps a missing order to 404 and a duplicate cancel to 409', async () => {
      repository.cancel.mockResolvedValue(null);
      await expect(
        service.cancel('tenant-a', 'missing', {}),
      ).rejects.toBeInstanceOf(NotFoundException);

      repository.cancel.mockResolvedValue('already-cancelled');
      await expect(
        service.cancel('tenant-a', 'order-1', {}),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    describe('cancellation reason safety (payments invariant)', () => {
      // The reason lands verbatim in Order.cancelReason AND the audit reason,
      // so it must never carry credential/payment content. Secret-shaped
      // fragments are assembled at runtime so no static literal reaches the
      // repo (Gitleaks scans every commit diff).
      const keyShapedValue = ['sk', 'live', 'abc123'].join('_');
      const bareSecretToken = ['sk', 'live', '0abcdef123456789'].join('_');
      const rejects = async (reason: string) => {
        await expect(
          service.cancel('tenant-a', 'order-1', { reason }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(repository.cancel).not.toHaveBeenCalled();
      };

      it('rejects a raw PAN in the reason (400, before any write)', async () => {
        await rejects('refund card 4111 1111 1111 1111');
      });

      it('rejects a token/api_key/password fragment in the reason', async () => {
        await rejects(`leaked api_key=${keyShapedValue}`);
        await rejects('note password: hunter2');
      });

      it('rejects a bare well-known secret token in the reason', async () => {
        await rejects(`operator pasted ${bareSecretToken}`);
      });

      it('rejects a credential URL in the reason', async () => {
        await rejects('feed rtsp://admin:pass@cam-1.local/live went down');
      });

      it('accepts a safe operational reason', async () => {
        await service.cancel('tenant-a', 'order-1', {
          reason: 'Customer changed mind',
        });
        expect(repository.cancel).toHaveBeenCalledWith(
          'tenant-a',
          'order-1',
          'Customer changed mind',
          expect.any(Function),
        );
      });
    });
  });
});
