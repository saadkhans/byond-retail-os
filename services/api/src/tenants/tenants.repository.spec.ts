import { AuditLogService } from '../common/audit/audit-log.service';
import { DefaultModulesMissingError } from '../common/errors/domain.errors';
import { PrismaService } from '../prisma/prisma.service';
import { TenantsRepository } from './tenants.repository';

describe('TenantsRepository.createWithDefaultModules', () => {
  const tenant = { id: 'tenant-1', name: 'Acme', slug: 'acme' };
  const coreModule = { id: 'module-core', code: 'core', isActive: true };
  const auditEntry = {
    tenantId: 'tenant-1',
    actorEmail: 'system@byond.internal',
    action: 'CREATE',
    entityType: 'Tenant',
  };

  let tx: {
    tenant: { create: jest.Mock };
    platformModule: { findMany: jest.Mock };
    tenantModule: { createMany: jest.Mock };
  };
  let prisma: { $transaction: jest.Mock };
  let auditLog: { record: jest.Mock };
  let repository: TenantsRepository;
  const buildAuditEntry = jest.fn().mockReturnValue(auditEntry);

  beforeEach(() => {
    tx = {
      tenant: { create: jest.fn().mockResolvedValue(tenant) },
      platformModule: { findMany: jest.fn().mockResolvedValue([coreModule]) },
      tenantModule: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    // The callback receives the transaction client; a thrown error inside it
    // means Prisma rolls the whole transaction back.
    prisma = { $transaction: jest.fn(async (callback) => callback(tx)) };
    auditLog = { record: jest.fn().mockResolvedValue(undefined) };
    repository = new TenantsRepository(
      prisma as unknown as PrismaService,
      auditLog as unknown as AuditLogService,
    );
    buildAuditEntry.mockClear();
  });

  it('creates tenant, default modules, and audit row inside one transaction', async () => {
    const result = await repository.createWithDefaultModules(
      { name: 'Acme', slug: 'acme' },
      ['core'],
      buildAuditEntry,
    );

    expect(result).toBe(tenant);
    expect(tx.tenant.create).toHaveBeenCalledWith({
      data: { name: 'Acme', slug: 'acme' },
    });
    expect(tx.tenantModule.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          tenantId: tenant.id,
          moduleId: coreModule.id,
          status: 'ENABLED',
        }),
      ],
    });
    // Audit row written through the SAME transaction client — atomic commit.
    expect(auditLog.record).toHaveBeenCalledWith(auditEntry, tx);
    expect(buildAuditEntry).toHaveBeenCalledWith(tenant);
  });

  it('fails the whole transaction when a default module is missing or inactive', async () => {
    tx.platformModule.findMany.mockResolvedValue([]);

    await expect(
      repository.createWithDefaultModules(
        { name: 'Acme', slug: 'acme' },
        ['core'],
        buildAuditEntry,
      ),
    ).rejects.toBeInstanceOf(DefaultModulesMissingError);

    expect(tx.tenantModule.createMany).not.toHaveBeenCalled();
    expect(auditLog.record).not.toHaveBeenCalled();
  });

  it('names the missing module codes in the error', async () => {
    tx.platformModule.findMany.mockResolvedValue([]);

    await expect(
      repository.createWithDefaultModules(
        { name: 'Acme', slug: 'acme' },
        ['core'],
        buildAuditEntry,
      ),
    ).rejects.toThrow(/core/);
  });

  it('propagates audit failure so the transaction rolls back the mutation', async () => {
    const auditBoom = new Error('audit insert failed');
    auditLog.record.mockRejectedValue(auditBoom);

    await expect(
      repository.createWithDefaultModules(
        { name: 'Acme', slug: 'acme' },
        ['core'],
        buildAuditEntry,
      ),
    ).rejects.toBe(auditBoom);

    // The error escaped the $transaction callback — with a real database
    // Prisma rolls back the tenant + module writes, so no committed mutation
    // can exist without its audit row.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});
