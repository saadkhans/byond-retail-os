import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, User } from '@prisma/client';
import { AuditEntry } from '../common/audit/audit-log.service';
import { UsersRepository } from './users.repository';
import { UsersService } from './users.service';

describe('UsersService', () => {
  const user = {
    id: 'user-1',
    tenantId: 'tenant-a',
    email: 'jane.doe@example.com',
    firstName: 'Jane',
    lastName: 'Doe',
  } as User;

  let repository: {
    create: jest.Mock;
    findById: jest.Mock;
    findMany: jest.Mock;
  };
  let service: UsersService;

  beforeEach(() => {
    repository = {
      create: jest.fn().mockResolvedValue(user),
      findById: jest.fn().mockResolvedValue(user),
      findMany: jest.fn().mockResolvedValue([user]),
    };
    service = new UsersService(repository as unknown as UsersRepository);
  });

  describe('create', () => {
    it('rejects whitespace-only firstName before touching the repository', async () => {
      await expect(
        service.create('tenant-a', {
          email: 'jane@example.com',
          firstName: '   ',
          lastName: 'Doe',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('rejects whitespace-only lastName before touching the repository', async () => {
      await expect(
        service.create('tenant-a', {
          email: 'jane@example.com',
          firstName: 'Jane',
          lastName: '  \t ',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('trims names, normalizes email, and passes an audit builder', async () => {
      await service.create('tenant-a', {
        email: '  Jane.Doe@Example.COM ',
        firstName: '  Jane ',
        lastName: ' Doe  ',
      });

      expect(repository.create).toHaveBeenCalledWith(
        'tenant-a',
        {
          email: 'jane.doe@example.com',
          firstName: 'Jane',
          lastName: 'Doe',
        },
        expect.any(Function),
      );
      const buildAuditEntry = repository.create.mock
        .calls[0][2] as (created: User) => AuditEntry;
      expect(buildAuditEntry(user)).toEqual(
        expect.objectContaining({
          tenantId: 'tenant-a',
          action: AuditAction.CREATE,
          entityType: 'User',
          entityId: user.id,
        }),
      );
    });

    it('maps duplicate emails to a conflict error', async () => {
      repository.create.mockRejectedValue({ code: 'P2002' });
      await expect(
        service.create('tenant-a', {
          email: 'jane@example.com',
          firstName: 'Jane',
          lastName: 'Doe',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('findById', () => {
    it('throws NotFound when the scoped lookup misses', async () => {
      repository.findById.mockResolvedValue(null);
      await expect(
        service.findById('tenant-a', 'nope'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
