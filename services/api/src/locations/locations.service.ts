import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, Location, Prisma } from '@prisma/client';
import {
  AuditLogService,
  SYSTEM_ACTOR_EMAIL,
} from '../common/audit/audit-log.service';
import { CreateLocationDto } from './dto/create-location.dto';
import { LocationsRepository } from './locations.repository';

@Injectable()
export class LocationsService {
  constructor(
    private readonly locationsRepository: LocationsRepository,
    private readonly auditLog: AuditLogService,
  ) {}

  async create(tenantId: string, dto: CreateLocationDto): Promise<Location> {
    let location: Location;
    try {
      location = await this.locationsRepository.create(tenantId, {
        name: dto.name.trim(),
        code: dto.code.trim().toUpperCase(),
        type: dto.type,
        timezone: dto.timezone,
        address: dto.address as Prisma.InputJsonValue | undefined,
      });
    } catch (error) {
      if ((error as { code?: unknown })?.code === 'P2002') {
        throw new ConflictException(
          `A location with code "${dto.code.trim().toUpperCase()}" already exists for this tenant`,
        );
      }
      throw error;
    }

    await this.auditLog.record({
      tenantId,
      actorEmail: SYSTEM_ACTOR_EMAIL,
      action: AuditAction.CREATE,
      entityType: 'Location',
      entityId: location.id,
      after: location,
      reason: 'Location created',
    });

    return location;
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
