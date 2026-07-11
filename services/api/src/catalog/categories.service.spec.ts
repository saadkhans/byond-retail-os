import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, ProductCategory } from '@prisma/client';
import { AuditEntry } from '../common/audit/audit-log.service';
import { CategoriesRepository } from './categories.repository';
import { CategoriesService } from './categories.service';

describe('CategoriesService', () => {
  const category = {
    id: 'cat-1',
    tenantId: 'tenant-a',
    name: 'Beverages',
    parentId: null,
  } as ProductCategory;

  let repository: {
    create: jest.Mock;
    findById: jest.Mock;
    findMany: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
  };
  let service: CategoriesService;

  beforeEach(() => {
    repository = {
      create: jest.fn().mockResolvedValue(category),
      findById: jest.fn().mockResolvedValue(category),
      findMany: jest.fn().mockResolvedValue([category]),
      update: jest.fn().mockResolvedValue(category),
      delete: jest.fn().mockResolvedValue(category),
    };
    service = new CategoriesService(
      repository as unknown as CategoriesRepository,
    );
  });

  it('rejects whitespace-only names before touching the repository', async () => {
    await expect(
      service.create('tenant-a', { name: '   ' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('validates the parent with a TENANT-SCOPED lookup', async () => {
    repository.findById.mockResolvedValue(null);
    await expect(
      service.create('tenant-a', { name: 'Sodas', parentId: 'cat-other' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    // The scoped lookup is what makes a foreign tenant's id "not found".
    expect(repository.findById).toHaveBeenCalledWith('tenant-a', 'cat-other');
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('trims the name and passes a CREATE audit builder', async () => {
    await service.create(
      'tenant-a',
      { name: '  Beverages ' },
      { id: 'user-1', email: 'jane@tenant-a.example' },
    );
    expect(repository.create).toHaveBeenCalledWith(
      'tenant-a',
      expect.objectContaining({ name: 'Beverages' }),
      expect.any(Function),
    );
    const buildAuditEntry = repository.create.mock
      .calls[0][2] as (created: ProductCategory) => AuditEntry;
    expect(buildAuditEntry(category)).toEqual(
      expect.objectContaining({
        tenantId: 'tenant-a',
        actorId: 'user-1',
        action: AuditAction.CREATE,
        entityType: 'ProductCategory',
        entityId: category.id,
      }),
    );
  });

  it('maps duplicate names to a conflict error', async () => {
    repository.create.mockRejectedValue({ code: 'P2002' });
    await expect(
      service.create('tenant-a', { name: 'Beverages' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('maps a stale parent FK on create to a 400', async () => {
    // Parent validated, then deleted before the insert lands.
    repository.create.mockRejectedValue({ code: 'P2003' });
    await expect(
      service.create('tenant-a', { name: 'Sodas', parentId: 'cat-1' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('maps a stale parent FK on update to a 400', async () => {
    repository.update.mockRejectedValue({ code: 'P2003' });
    await expect(
      service.update('tenant-a', 'cat-1', { parentId: 'cat-parent' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an empty update', async () => {
    await expect(service.update('tenant-a', 'cat-1', {})).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('rejects a category as its own parent', async () => {
    await expect(
      service.update('tenant-a', 'cat-1', { parentId: 'cat-1' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects moving a category under one of its descendants (cycle)', async () => {
    const child = { ...category, id: 'cat-2', parentId: 'cat-1' };
    repository.findById.mockImplementation(
      async (_tenantId: string, id: string) =>
        id === 'cat-2' ? child : category,
    );
    await expect(
      service.update('tenant-a', 'cat-1', { parentId: 'cat-2' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('maps an in-transaction cycle rejection to a conflict', async () => {
    // The optimistic pre-check passes (parent is not a known descendant), but
    // the repository detects a cycle under its per-tenant lock — e.g. a
    // concurrent move committed first. That authoritative rejection is a 409.
    repository.update.mockResolvedValue('cycle-detected');
    await expect(
      service.update('tenant-a', 'cat-1', { parentId: 'cat-parent' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('404s when the update target is not in this tenant', async () => {
    repository.update.mockResolvedValue(null);
    await expect(
      service.update('tenant-a', 'cat-foreign', { name: 'X' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('maps a concurrent delete during update (P2025) to a 404', async () => {
    // Row read inside the transaction, then deleted by another request before
    // the unique update executed — Prisma raises P2025.
    repository.update.mockRejectedValue({ code: 'P2025' });
    await expect(
      service.update('tenant-a', 'cat-1', { name: 'X' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('maps delete FK violations to a conflict (children/products exist)', async () => {
    repository.delete.mockRejectedValue({ code: 'P2003' });
    await expect(service.delete('tenant-a', 'cat-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('404s when deleting a category outside this tenant', async () => {
    repository.delete.mockResolvedValue(null);
    await expect(
      service.delete('tenant-a', 'cat-foreign'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('maps a double-delete race (P2025) to a 404', async () => {
    repository.delete.mockRejectedValue({ code: 'P2025' });
    await expect(service.delete('tenant-a', 'cat-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
