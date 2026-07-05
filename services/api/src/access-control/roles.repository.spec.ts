import { AuditLogService } from '../common/audit/audit-log.service';
import { TenantIsolationViolationError } from '../common/errors/domain.errors';
import { PrismaService } from '../prisma/prisma.service';
import { RolesRepository } from './roles.repository';

describe('RolesRepository.assignToUser (in-transaction tenancy enforcement)', () => {
  const auditEntry = {
    tenantId: 'tenant-a',
    actorEmail: 'admin@tenant-a.example',
    action: 'ROLE_ASSIGN',
    entityType: 'UserRole',
  };
  const buildAuditEntry = jest.fn().mockReturnValue(auditEntry);

  let tx: {
    user: { findFirst: jest.Mock };
    role: { findFirst: jest.Mock };
    userRole: { create: jest.Mock };
  };
  let prisma: { $transaction: jest.Mock };
  let auditLog: { record: jest.Mock };
  let repository: RolesRepository;

  beforeEach(() => {
    tx = {
      user: { findFirst: jest.fn().mockResolvedValue({ id: 'user-1' }) },
      role: { findFirst: jest.fn().mockResolvedValue({ id: 'role-1' }) },
      userRole: {
        create: jest.fn().mockResolvedValue({ id: 'user-role-1' }),
      },
    };
    prisma = { $transaction: jest.fn(async (callback) => callback(tx)) };
    auditLog = { record: jest.fn().mockResolvedValue(undefined) };
    repository = new RolesRepository(
      prisma as unknown as PrismaService,
      auditLog as unknown as AuditLogService,
    );
    buildAuditEntry.mockClear();
  });

  it('verifies user, role, and actor rows against the scoped tenantId inside the transaction', async () => {
    await repository.assignToUser(
      'tenant-a',
      { userId: 'user-1', roleId: 'role-1', assignedById: 'user-admin' },
      buildAuditEntry,
    );

    expect(tx.user.findFirst).toHaveBeenCalledWith({
      where: { id: 'user-1', tenantId: 'tenant-a' },
      select: { id: true },
    });
    expect(tx.role.findFirst).toHaveBeenCalledWith({
      where: { id: 'role-1', tenantId: 'tenant-a' },
      select: { id: true },
    });
    expect(tx.user.findFirst).toHaveBeenCalledWith({
      where: { id: 'user-admin', tenantId: 'tenant-a' },
      select: { id: true },
    });
    expect(tx.userRole.create).toHaveBeenCalledWith({
      data: {
        userId: 'user-1',
        roleId: 'role-1',
        assignedById: 'user-admin',
        tenantId: 'tenant-a',
      },
    });
    expect(auditLog.record).toHaveBeenCalledWith(auditEntry, tx);
  });

  it('rejects a target user from another tenant — fails closed, nothing written', async () => {
    tx.user.findFirst.mockResolvedValue(null);

    await expect(
      repository.assignToUser(
        'tenant-a',
        { userId: 'user-of-tenant-b', roleId: 'role-1' },
        buildAuditEntry,
      ),
    ).rejects.toBeInstanceOf(TenantIsolationViolationError);

    expect(tx.userRole.create).not.toHaveBeenCalled();
    expect(auditLog.record).not.toHaveBeenCalled();
  });

  it('rejects a role from another tenant', async () => {
    tx.role.findFirst.mockResolvedValue(null);

    await expect(
      repository.assignToUser(
        'tenant-a',
        { userId: 'user-1', roleId: 'role-of-tenant-b' },
        buildAuditEntry,
      ),
    ).rejects.toThrow(/role .* does not belong to tenant/);

    expect(tx.userRole.create).not.toHaveBeenCalled();
    expect(auditLog.record).not.toHaveBeenCalled();
  });

  it('rejects an assignedById from another tenant', async () => {
    tx.user.findFirst
      .mockResolvedValueOnce({ id: 'user-1' }) // target user in tenant
      .mockResolvedValueOnce(null); // actor is not

    await expect(
      repository.assignToUser(
        'tenant-a',
        { userId: 'user-1', roleId: 'role-1', assignedById: 'actor-of-b' },
        buildAuditEntry,
      ),
    ).rejects.toThrow(/assigning user .* does not belong to tenant/);

    expect(tx.userRole.create).not.toHaveBeenCalled();
    expect(auditLog.record).not.toHaveBeenCalled();
  });

  it('rejects platform users: tenantId NULL never matches the scoped lookup', async () => {
    // A platform user's row has tenantId NULL, so the in-transaction
    // findFirst({ id, tenantId: 'tenant-a' }) returns null exactly as it
    // does for a cross-tenant user.
    tx.user.findFirst.mockResolvedValue(null);

    await expect(
      repository.assignToUser(
        'tenant-a',
        { userId: 'platform-user-id', roleId: 'role-1' },
        buildAuditEntry,
      ),
    ).rejects.toBeInstanceOf(TenantIsolationViolationError);

    expect(tx.userRole.create).not.toHaveBeenCalled();
  });

  it('skips the actor check when assignedById is not supplied', async () => {
    await repository.assignToUser(
      'tenant-a',
      { userId: 'user-1', roleId: 'role-1' },
      buildAuditEntry,
    );

    // Exactly one user lookup (the target), not two.
    expect(tx.user.findFirst).toHaveBeenCalledTimes(1);
    expect(tx.userRole.create).toHaveBeenCalled();
  });
});
