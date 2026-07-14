import {
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
  });
});
