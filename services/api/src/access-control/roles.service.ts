import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, Role, UserRole } from '@prisma/client';
import {
  AuditActor,
  SYSTEM_ACTOR_EMAIL,
} from '../common/audit/audit-log.service';
import { UsersRepository } from '../users/users.repository';
import { CreateRoleDto } from './dto/create-role.dto';
import { RolesRepository } from './roles.repository';

@Injectable()
export class RolesService {
  constructor(
    private readonly rolesRepository: RolesRepository,
    private readonly usersRepository: UsersRepository,
  ) {}

  async create(
    tenantId: string,
    dto: CreateRoleDto,
    actor?: AuditActor,
  ): Promise<Role> {
    const name = dto.name.trim();
    if (!name) {
      throw new BadRequestException('Role name is required');
    }

    try {
      return await this.rolesRepository.create(
        tenantId,
        { name, description: dto.description?.trim() },
        (role) => ({
          tenantId,
          actorId: actor?.id ?? null,
          actorEmail: actor?.email ?? SYSTEM_ACTOR_EMAIL,
          action: AuditAction.CREATE,
          entityType: 'Role',
          entityId: role.id,
          after: role,
          reason: 'Role created',
        }),
      );
    } catch (error) {
      if ((error as { code?: unknown })?.code === 'P2002') {
        throw new ConflictException(
          `A role named "${name}" already exists for this tenant`,
        );
      }
      throw error;
    }
  }

  findMany(tenantId: string): Promise<Role[]> {
    return this.rolesRepository.findMany(tenantId);
  }

  /**
   * Assigns a role to a user. Role, target user, and (when supplied) the
   * assigning actor are all resolved through tenant-scoped lookups, so
   * cross-tenant assignment — including platform users, whose tenantId is
   * NULL and who therefore never match a scoped lookup — is structurally
   * impossible. Platform-level role assignment is a separate, explicitly
   * designed flow that does not exist in Phase 1.
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

    const targetUser = await this.usersRepository.findById(tenantId, userId);
    if (!targetUser) {
      throw new NotFoundException(
        `User "${userId}" not found in this tenant`,
      );
    }

    let actorId: string | null = null;
    let actorEmail = SYSTEM_ACTOR_EMAIL;
    if (assignedById !== undefined) {
      const actor = await this.usersRepository.findById(
        tenantId,
        assignedById,
      );
      if (!actor) {
        throw new NotFoundException(
          `Assigning user "${assignedById}" not found in this tenant`,
        );
      }
      actorId = actor.id;
      actorEmail = actor.email;
    }

    try {
      return await this.rolesRepository.assignToUser(
        tenantId,
        { userId, roleId, assignedById },
        (userRole) => ({
          tenantId,
          actorId,
          actorEmail,
          action: AuditAction.ROLE_ASSIGN,
          entityType: 'UserRole',
          entityId: userRole.id,
          after: userRole,
          reason: `Role "${role.name}" assigned to user "${targetUser.email}"`,
        }),
      );
    } catch (error) {
      if ((error as { code?: unknown })?.code === 'P2002') {
        throw new ConflictException('User already has this role');
      }
      throw error;
    }
  }
}
