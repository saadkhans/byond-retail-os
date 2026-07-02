import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, Role, UserRole } from '@prisma/client';
import {
  AuditLogService,
  SYSTEM_ACTOR_EMAIL,
} from '../common/audit/audit-log.service';
import { CreateRoleDto } from './dto/create-role.dto';
import { RolesRepository } from './roles.repository';

@Injectable()
export class RolesService {
  constructor(
    private readonly rolesRepository: RolesRepository,
    private readonly auditLog: AuditLogService,
  ) {}

  async create(tenantId: string, dto: CreateRoleDto): Promise<Role> {
    let role: Role;
    try {
      role = await this.rolesRepository.create(tenantId, {
        name: dto.name.trim(),
        description: dto.description?.trim(),
      });
    } catch (error) {
      if ((error as { code?: unknown })?.code === 'P2002') {
        throw new ConflictException(
          `A role named "${dto.name.trim()}" already exists for this tenant`,
        );
      }
      throw error;
    }

    await this.auditLog.record({
      tenantId,
      actorEmail: SYSTEM_ACTOR_EMAIL,
      action: AuditAction.CREATE,
      entityType: 'Role',
      entityId: role.id,
      after: role,
      reason: 'Role created',
    });

    return role;
  }

  findMany(tenantId: string): Promise<Role[]> {
    return this.rolesRepository.findMany(tenantId);
  }

  /**
   * Assigns a role to a user. The role is looked up through the tenant-scoped
   * repository first, so a role belonging to another tenant is a NotFound —
   * cross-tenant assignment is structurally impossible.
   */
  async assignToUser(
    tenantId: string,
    userId: string,
    roleId: string,
    assignedById?: string,
  ): Promise<UserRole> {
    const role = await this.rolesRepository.findById(tenantId, roleId);
    if (!role) {
      throw new NotFoundException(`Role "${roleId}" not found`);
    }

    let userRole: UserRole;
    try {
      userRole = await this.rolesRepository.assignToUser(tenantId, {
        userId,
        roleId,
        assignedById,
      });
    } catch (error) {
      if ((error as { code?: unknown })?.code === 'P2002') {
        throw new ConflictException('User already has this role');
      }
      throw error;
    }

    await this.auditLog.record({
      tenantId,
      actorId: assignedById ?? null,
      actorEmail: SYSTEM_ACTOR_EMAIL,
      action: AuditAction.ROLE_ASSIGN,
      entityType: 'UserRole',
      entityId: userRole.id,
      after: userRole,
      reason: `Role "${role.name}" assigned to user`,
    });

    return userRole;
  }
}
