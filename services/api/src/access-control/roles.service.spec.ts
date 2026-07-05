import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, Role, UserRole } from '@prisma/client';
import { AuditEntry, SYSTEM_ACTOR_EMAIL } from '../common/audit/audit-log.service';
import { UsersRepository } from '../users/users.repository';
import { RolesRepository } from './roles.repository';
import { RolesService } from './roles.service';

describe('RolesService', () => {
  const role = {
    id: 'role-1',
    tenantId: 'tenant-a',
    name: 'Store Manager',
    isSystem: false,
  } as Role;
  const targetUser = {
    id: 'user-1',
    tenantId: 'tenant-a',
    email: 'jane@tenant-a.example',
  };
  const actorUser = {
    id: 'user-admin',
    tenantId: 'tenant-a',
    email: 'admin@tenant-a.example',
  };
  const userRole = {
    id: 'user-role-1',
    userId: 'user-1',
    roleId: 'role-1',
    tenantId: 'tenant-a',
  } as UserRole;

  let rolesRepository: {
    create: jest.Mock;
    findById: jest.Mock;
    findMany: jest.Mock;
    assignToUser: jest.Mock;
  };
  let usersRepository: { findById: jest.Mock };
  let service: RolesService;

  beforeEach(() => {
    rolesRepository = {
      create: jest.fn().mockResolvedValue(role),
      findById: jest.fn().mockResolvedValue(role),
      findMany: jest.fn().mockResolvedValue([role]),
      assignToUser: jest.fn().mockResolvedValue(userRole),
    };
    usersRepository = { findById: jest.fn().mockResolvedValue(targetUser) };
    service = new RolesService(
      rolesRepository as unknown as RolesRepository,
      usersRepository as unknown as UsersRepository,
    );
  });

  describe('create', () => {
    it('rejects blank role names after trimming, before any insert', async () => {
      await expect(
        service.create('tenant-a', { name: '   ' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(rolesRepository.create).not.toHaveBeenCalled();
    });

    it('creates the role with a trimmed name and an audit builder', async () => {
      await service.create('tenant-a', { name: '  Store Manager  ' });

      expect(rolesRepository.create).toHaveBeenCalledWith(
        'tenant-a',
        { name: 'Store Manager', description: undefined },
        expect.any(Function),
      );
      const buildAuditEntry = rolesRepository.create.mock
        .calls[0][2] as (created: Role) => AuditEntry;
      expect(buildAuditEntry(role)).toEqual(
        expect.objectContaining({
          tenantId: 'tenant-a',
          action: AuditAction.CREATE,
          entityType: 'Role',
          entityId: role.id,
        }),
      );
    });

    it('maps duplicate names to a conflict error', async () => {
      rolesRepository.create.mockRejectedValue({ code: 'P2002' });
      await expect(
        service.create('tenant-a', { name: 'Store Manager' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('assignToUser', () => {
    it('assigns a tenant role to a user of the same tenant', async () => {
      const result = await service.assignToUser(
        'tenant-a',
        'user-1',
        'role-1',
      );

      expect(usersRepository.findById).toHaveBeenCalledWith(
        'tenant-a',
        'user-1',
      );
      expect(rolesRepository.assignToUser).toHaveBeenCalledWith(
        'tenant-a',
        { userId: 'user-1', roleId: 'role-1', assignedById: undefined },
        expect.any(Function),
      );
      expect(result).toBe(userRole);
    });

    it('rejects when the role does not belong to the tenant', async () => {
      rolesRepository.findById.mockResolvedValue(null);

      await expect(
        service.assignToUser('tenant-a', 'user-1', 'role-of-tenant-b'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(rolesRepository.assignToUser).not.toHaveBeenCalled();
    });

    it("rejects cross-tenant assignment: tenant B's user never resolves in tenant A's scope", async () => {
      // The tenant-scoped lookup returns null for any user whose tenantId is
      // not tenant-a — exactly what happens for a tenant-B user.
      usersRepository.findById.mockResolvedValue(null);

      await expect(
        service.assignToUser('tenant-a', 'user-of-tenant-b', 'role-1'),
      ).rejects.toThrow(/not found in this tenant/);
      expect(rolesRepository.assignToUser).not.toHaveBeenCalled();
    });

    it('rejects platform users: NULL tenantId never matches a scoped lookup', async () => {
      // Platform users have tenantId NULL, so the scoped findById returns
      // null for them too — platform-role assignment is out of scope for
      // Phase 1 and must fail here.
      usersRepository.findById.mockResolvedValue(null);

      await expect(
        service.assignToUser('tenant-a', 'platform-user-id', 'role-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(rolesRepository.assignToUser).not.toHaveBeenCalled();
    });

    it('rejects an assigning actor from outside the tenant', async () => {
      usersRepository.findById
        .mockResolvedValueOnce(targetUser) // target user resolves
        .mockResolvedValueOnce(null); // actor does not

      await expect(
        service.assignToUser(
          'tenant-a',
          'user-1',
          'role-1',
          'actor-of-tenant-b',
        ),
      ).rejects.toThrow(/Assigning user .* not found in this tenant/);
      expect(rolesRepository.assignToUser).not.toHaveBeenCalled();
    });

    it('audits with the validated actor identity when assignedById is given', async () => {
      usersRepository.findById
        .mockResolvedValueOnce(targetUser)
        .mockResolvedValueOnce(actorUser);

      await service.assignToUser('tenant-a', 'user-1', 'role-1', 'user-admin');

      const buildAuditEntry = rolesRepository.assignToUser.mock
        .calls[0][2] as (created: UserRole) => AuditEntry;
      expect(buildAuditEntry(userRole)).toEqual(
        expect.objectContaining({
          tenantId: 'tenant-a',
          actorId: actorUser.id,
          actorEmail: actorUser.email,
          action: AuditAction.ROLE_ASSIGN,
          entityType: 'UserRole',
        }),
      );
    });

    it('audits as the system actor when no assignedById is given', async () => {
      await service.assignToUser('tenant-a', 'user-1', 'role-1');

      const buildAuditEntry = rolesRepository.assignToUser.mock
        .calls[0][2] as (created: UserRole) => AuditEntry;
      expect(buildAuditEntry(userRole)).toEqual(
        expect.objectContaining({
          actorId: null,
          actorEmail: SYSTEM_ACTOR_EMAIL,
        }),
      );
    });

    it('maps duplicate assignment to a conflict error', async () => {
      rolesRepository.assignToUser.mockRejectedValue({ code: 'P2002' });
      await expect(
        service.assignToUser('tenant-a', 'user-1', 'role-1'),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });
});
