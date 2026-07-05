import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, Location, Prisma } from '@prisma/client';
import { SYSTEM_ACTOR_EMAIL } from '../common/audit/audit-log.service';
import { CreateLocationDto } from './dto/create-location.dto';
import { LocationsRepository } from './locations.repository';

@Injectable()
export class LocationsService {
  constructor(private readonly locationsRepository: LocationsRepository) {}

  async create(tenantId: string, dto: CreateLocationDto): Promise<Location> {
    // Same whitespace-only guard as users/tenants/roles: DTO @MinLength(1)
    // passes for '   ', so trim and reject here. The code field needs no
    // guard — its DTO pattern already forbids whitespace entirely.
    const name = dto.name.trim();
    if (!name) {
      throw new BadRequestException('Location name is required');
    }
    const code = dto.code.trim().toUpperCase();
    try {
      return await this.locationsRepository.create(
        tenantId,
        {
          name,
          code,
          type: dto.type,
          // Blank timezone falls back to the schema default (UTC).
          timezone: dto.timezone?.trim() || undefined,
          address: dto.address as Prisma.InputJsonValue | undefined,
        },
        (location) => ({
          tenantId,
          actorEmail: SYSTEM_ACTOR_EMAIL,
          action: AuditAction.CREATE,
          entityType: 'Location',
          entityId: location.id,
          after: location,
          reason: 'Location created',
        }),
      );
    } catch (error) {
      if ((error as { code?: unknown })?.code === 'P2002') {
        throw new ConflictException(
          `A location with code "${code}" already exists for this tenant`,
        );
      }
      throw error;
    }
  }

  async findById(tenantId: string, id: string): Promise<Location> {
    const location = await this.locationsRepository.findById(tenantId, id);
    if (!location) {
      throw new NotFoundException(`Location "${id}" not found`);
    }
    return location;
  }

  findMany(tenantId: string): Promise<Location[]> {
    return this.locationsRepository.findMany(tenantId);
  }
}
