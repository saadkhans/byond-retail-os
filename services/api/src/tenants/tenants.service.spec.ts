import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, Tenant, TenantStatus } from '@prisma/client';
import { AuditLogService } from '../common/audit/audit-log.service';
import { DEFAULT_ENABLED_MODULE_CODES } from '../platform-modules/platform-module.catalog';
import { TenantsRepository } from './tenants.repository';
import { TenantsService, toSlug } from './tenants.service';

describe('toSlug', () => {
  it('normalizes names into url-safe slugs', () => {
    expect(toSlug('Acme Stores!')).toBe('acme-stores');
    expect(toSlug('  Café & Bar  ')).toBe('cafe-bar');
    expect(toSlug('UPPER_case--Name')).toBe('upper-case-name');
  });

  it('returns an empty string when nothing survives normalization', () => {
    expect(toSlug('!!!')).toBe('');
  });
});

describe('TenantsService', () => {
  const tenant: Tenant = {
    id: 'tenant-1',
    name: 'Acme Stores',
    slug: 'acme-stores',
    status: TenantStatus.PENDING,
    settings: null,
    createdAt: new Date('2026-07-02T00:00:00Z'),
    updatedAt: new Date('2026-07-02T00:00:00Z'),
  };

  let repository: { createWithDefaultModules: jest.Mock; findById: jest.Mock };
  let auditLog: { record: jest.Mock };
  let service: TenantsService;

  beforeEach(() => {
    repository = {
      createWithDefaultModules: jest.fn().mockResolvedValue(tenant),
      findById: jest.fn().mockResolvedValue(tenant),
    };
    auditLog = { record: jest.fn().mockResolvedValue(undefined) };
    service = new TenantsService(
      repository as unknown as TenantsRepository,
      auditLog as unknown as AuditLogService,
    );
  });

  describe('create', () => {
    it('creates a tenant with a slug derived from the name and default modules', async () => {
      const result = await service.create({ name: 'Acme Stores!' });

      expect(repository.createWithDefaultModules).toHaveBeenCalledWith(
        { name: 'Acme Stores!', slug: 'acme-stores' },
        DEFAULT_ENABLED_MODULE_CODES,
      );
      expect(result).toBe(tenant);
    });

    it('uses an explicit slug when provided', async () => {
      await service.create({ name: 'Acme Stores', slug: 'acme-eu' });

      expect(repository.createWithDefaultModules).toHaveBeenCalledWith(
        { name: 'Acme Stores', slug: 'acme-eu' },
        DEFAULT_ENABLED_MODULE_CODES,
      );
    });

    it('writes an audit log entry scoped to the new tenant', async () => {
      await service.create({ name: 'Acme Stores' });

      expect(auditLog.record).toHaveBeenCalledTimes(1);
      expect(auditLog.record).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: tenant.id,
          action: AuditAction.CREATE,
          entityType: 'Tenant',
          entityId: tenant.id,
        }),
      );
    });

    it('rejects an empty name before touching the repository', async () => {
      await expect(service.create({ name: '   ' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(repository.createWithDefaultModules).not.toHaveBeenCalled();
      expect(auditLog.record).not.toHaveBeenCalled();
    });

    it('rejects a name that cannot produce a slug', async () => {
      await expect(service.create({ name: '!!!' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(repository.createWithDefaultModules).not.toHaveBeenCalled();
    });

    it('maps unique-constraint violations to a conflict error', async () => {
      repository.createWithDefaultModules.mockRejectedValue({
        code: 'P2002',
      });

      await expect(
        service.create({ name: 'Acme Stores' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(auditLog.record).not.toHaveBeenCalled();
    });

    it('rethrows unknown repository errors untouched', async () => {
      const boom = new Error('connection reset');
      repository.createWithDefaultModules.mockRejectedValue(boom);

      await expect(service.create({ name: 'Acme Stores' })).rejects.toBe(boom);
    });
  });

  describe('findById', () => {
    it('returns the tenant when found', async () => {
      await expect(service.findById('tenant-1')).resolves.toBe(tenant);
    });

    it('throws NotFound for an unknown id', async () => {
      repository.findById.mockResolvedValue(null);
      await expect(service.findById('nope')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
