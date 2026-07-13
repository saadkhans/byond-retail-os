import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, Location, Prisma } from '@prisma/client';
import {
  AuditActor,
  AuditEntry,
  SYSTEM_ACTOR_EMAIL,
} from '../common/audit/audit-log.service';
import { CreateLocationDto } from './dto/create-location.dto';
import { QueryLocationsDto } from './dto/query-locations.dto';
import { UpdateLocationDto } from './dto/update-location.dto';
import { LocationsRepository } from './locations.repository';

function prismaErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null
    ? String((error as { code?: unknown }).code ?? '')
    : undefined;
}

@Injectable()
export class LocationsService {
  constructor(private readonly locationsRepository: LocationsRepository) {}

  async create(
    tenantId: string,
    dto: CreateLocationDto,
    actor?: AuditActor,
  ): Promise<Location> {
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
        (location) =>
          this.auditEntry(tenantId, actor, {
            action: AuditAction.CREATE,
            entityType: 'Location',
            entityId: location.id,
            after: location,
            reason: 'Location created',
          }),
      );
    } catch (error) {
      if (prismaErrorCode(error) === 'P2002') {
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

  // Legacy GET /locations contract: the full unpaginated list, as shipped
  // in Phase 1. New list features belong on search() (/stores) instead.
  findMany(tenantId: string): Promise<Location[]> {
    return this.locationsRepository.findMany(tenantId);
  }

  async search(
    tenantId: string,
    query: QueryLocationsDto,
  ): Promise<{ items: Location[]; total: number; skip: number; take: number }> {
    const skip = query.skip ?? 0;
    const take = query.take ?? 25;
    const { items, total } = await this.locationsRepository.search(tenantId, {
      search: query.search?.trim() || undefined,
      type: query.type,
      status: query.status,
      skip,
      take,
    });
    return { items, total, skip, take };
  }

  async update(
    tenantId: string,
    id: string,
    dto: UpdateLocationDto,
    actor?: AuditActor,
  ): Promise<Location> {
    const data: Parameters<LocationsRepository['update']>[2] = {};
    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (!name) {
        throw new BadRequestException('Location name is required');
      }
      data.name = name;
    }
    if (dto.type !== undefined) {
      data.type = dto.type;
    }
    if (dto.status !== undefined) {
      data.status = dto.status;
    }
    if (dto.timezone !== undefined) {
      const timezone = dto.timezone.trim();
      if (!timezone) {
        throw new BadRequestException('Timezone cannot be blank');
      }
      data.timezone = timezone;
    }
    if (dto.address !== undefined) {
      data.address = dto.address as Prisma.InputJsonValue;
    }
    if (Object.keys(data).length === 0) {
      throw new BadRequestException('No fields to update');
    }

    let updated: Location | null;
    try {
      updated = await this.locationsRepository.update(
        tenantId,
        id,
        data,
        (before, after) =>
          this.auditEntry(tenantId, actor, {
            action: AuditAction.UPDATE,
            entityType: 'Location',
            entityId: after.id,
            before,
            after,
            reason:
              dto.status !== undefined
                ? 'Location updated (status change)'
                : 'Location updated',
          }),
      );
    } catch (error) {
      // The row was read inside the transaction, then deleted by another
      // request before the unique update executed — Prisma raises P2025.
      if (prismaErrorCode(error) === 'P2025') {
        throw new NotFoundException(`Location "${id}" not found`);
      }
      throw error;
    }
    if (!updated) {
      throw new NotFoundException(`Location "${id}" not found`);
    }
    return updated;
  }

  async delete(
    tenantId: string,
    id: string,
    actor?: AuditActor,
  ): Promise<void> {
    let deleted: Location | null;
    try {
      deleted = await this.locationsRepository.delete(
        tenantId,
        id,
        (location) =>
          this.auditEntry(tenantId, actor, {
            action: AuditAction.DELETE,
            entityType: 'Location',
            entityId: location.id,
            before: location,
            reason: 'Location deleted',
          }),
      );
    } catch (error) {
      if (prismaErrorCode(error) === 'P2003') {
        throw new ConflictException(
          'Location is still referenced by retail units or inventory and cannot be deleted',
        );
      }
      // Double-delete race: both requests pass the scoped findFirst, the
      // first commits, and the second's delete raises P2025.
      if (prismaErrorCode(error) === 'P2025') {
        throw new NotFoundException(`Location "${id}" not found`);
      }
      throw error;
    }
    if (!deleted) {
      throw new NotFoundException(`Location "${id}" not found`);
    }
  }

  private auditEntry(
    tenantId: string,
    actor: AuditActor | undefined,
    partial: Pick<
      AuditEntry,
      'action' | 'entityType' | 'entityId' | 'before' | 'after' | 'reason'
    >,
  ): AuditEntry {
    return {
      tenantId,
      actorId: actor?.id ?? null,
      actorEmail: actor?.email ?? SYSTEM_ACTOR_EMAIL,
      ...partial,
    };
  }
}
