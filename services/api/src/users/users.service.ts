import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditAction, User } from '@prisma/client';
import {
  AuditLogService,
  SYSTEM_ACTOR_EMAIL,
} from '../common/audit/audit-log.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UsersRepository } from './users.repository';

@Injectable()
export class UsersService {
  constructor(
    private readonly usersRepository: UsersRepository,
    private readonly auditLog: AuditLogService,
  ) {}

  async create(tenantId: string, dto: CreateUserDto): Promise<User> {
    let user: User;
    try {
      user = await this.usersRepository.create(tenantId, {
        email: dto.email.toLowerCase().trim(),
        firstName: dto.firstName.trim(),
        lastName: dto.lastName.trim(),
      });
    } catch (error) {
      if ((error as { code?: unknown })?.code === 'P2002') {
        throw new ConflictException('A user with this email already exists');
      }
      throw error;
    }

    await this.auditLog.record({
      tenantId,
      actorEmail: SYSTEM_ACTOR_EMAIL,
      action: AuditAction.CREATE,
      entityType: 'User',
      entityId: user.id,
      after: user,
      reason: 'User created',
    });

    return user;
  }

  async findById(tenantId: string, id: string): Promise<User> {
    const user = await this.usersRepository.findById(tenantId, id);
    if (!user) {
      throw new NotFoundException(`User "${id}" not found`);
    }
    return user;
  }

  findMany(tenantId: string): Promise<User[]> {
    return this.usersRepository.findMany(tenantId);
  }
}
