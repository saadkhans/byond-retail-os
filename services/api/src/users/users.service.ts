import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction } from '@prisma/client';
import {
  AuditActor,
  SYSTEM_ACTOR_EMAIL,
} from '../common/audit/audit-log.service';
import { CreateUserDto } from './dto/create-user.dto';
import { SafeDbUser, UsersRepository } from './users.repository';

@Injectable()
export class UsersService {
  constructor(private readonly usersRepository: UsersRepository) {}

  async create(
    tenantId: string,
    dto: CreateUserDto,
    actor?: AuditActor,
  ): Promise<SafeDbUser> {
    // DTO @MinLength(1) passes for whitespace-only input; trim first and
    // fail closed so empty names can never be persisted.
    const firstName = dto.firstName.trim();
    const lastName = dto.lastName.trim();
    if (!firstName) {
      throw new BadRequestException('firstName is required');
    }
    if (!lastName) {
      throw new BadRequestException('lastName is required');
    }

    try {
      return await this.usersRepository.create(
        tenantId,
        {
          email: dto.email.toLowerCase().trim(),
          firstName,
          lastName,
        },
        (user) => ({
          tenantId,
          actorId: actor?.id ?? null,
          actorEmail: actor?.email ?? SYSTEM_ACTOR_EMAIL,
          action: AuditAction.CREATE,
          entityType: 'User',
          entityId: user.id,
          after: user,
          reason: 'User created',
        }),
      );
    } catch (error) {
      if ((error as { code?: unknown })?.code === 'P2002') {
        throw new ConflictException('A user with this email already exists');
      }
      throw error;
    }
  }

  async findById(tenantId: string, id: string): Promise<SafeDbUser> {
    const user = await this.usersRepository.findById(tenantId, id);
    if (!user) {
      throw new NotFoundException(`User "${id}" not found`);
    }
    return user;
  }

  findMany(tenantId: string): Promise<SafeDbUser[]> {
    return this.usersRepository.findMany(tenantId);
  }
}
