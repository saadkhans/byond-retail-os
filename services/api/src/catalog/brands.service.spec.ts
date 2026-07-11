import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, Brand } from '@prisma/client';
import { AuditEntry } from '../common/audit/audit-log.service';
import { BrandsRepository } from './brands.repository';
import { BrandsService } from './brands.service';

describe('BrandsService', () => {
  const brand = {
    id: 'brand-1',
    tenantId: 'tenant-a',
    name: 'Acme Foods',
  } as Brand;

  let repository: {
    create: jest.Mock;
    findById: jest.Mock;
    findMany: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
  };
  let service: BrandsService;

  beforeEach(() => {
    repository = {
      create: jest.fn().mockResolvedValue(brand),
      findById: jest.fn().mockResolvedValue(brand),
      findMany: jest.fn().mockResolvedValue([brand]),
      update: jest.fn().mockResolvedValue(brand),
      delete: jest.fn().mockResolvedValue(brand),
    };
    service = new BrandsService(repository as unknown as BrandsRepository);
  });

  it('rejects whitespace-only names before touching the repository', async () => {
    await expect(
      service.create('tenant-a', { name: ' ' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('trims the name and passes a CREATE audit builder', async () => {
    await service.create(
      'tenant-a',
      { name: ' Acme Foods ' },
      { id: 'user-1', email: 'jane@tenant-a.example' },
    );
    expect(repository.create).toHaveBeenCalledWith(
      'tenant-a',
      expect.objectContaining({ name: 'Acme Foods' }),
      expect.any(Function),
    );
    const buildAuditEntry = repository.create.mock
      .calls[0][2] as (created: Brand) => AuditEntry;
    expect(buildAuditEntry(brand)).toEqual(
      expect.objectContaining({
        tenantId: 'tenant-a',
        action: AuditAction.CREATE,
        entityType: 'Brand',
        entityId: brand.id,
      }),
    );
  });

  it('maps duplicate names to a conflict error', async () => {
    repository.create.mockRejectedValue({ code: 'P2002' });
    await expect(
      service.create('tenant-a', { name: 'Acme Foods' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects an empty update and 404s on a foreign target', async () => {
    await expect(
      service.update('tenant-a', 'brand-1', {}),
    ).rejects.toBeInstanceOf(BadRequestException);
    repository.update.mockResolvedValue(null);
    await expect(
      service.update('tenant-a', 'brand-foreign', { name: 'X' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('maps delete FK violations to a conflict (products reference it)', async () => {
    repository.delete.mockRejectedValue({ code: 'P2003' });
    await expect(service.delete('tenant-a', 'brand-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('maps a concurrent delete during update (P2025) to a 404', async () => {
    // The row was read inside the transaction, then deleted by another request
    // before the unique update executed — Prisma raises P2025.
    repository.update.mockRejectedValue({ code: 'P2025' });
    await expect(
      service.update('tenant-a', 'brand-1', { name: 'X' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('maps a double-delete race (P2025) to a 404', async () => {
    repository.delete.mockRejectedValue({ code: 'P2025' });
    await expect(service.delete('tenant-a', 'brand-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
