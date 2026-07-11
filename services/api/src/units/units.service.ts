import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, RetailUnit } from '@prisma/client';
import {
  AuditActor,
  AuditEntry,
  SYSTEM_ACTOR_EMAIL,
} from '../common/audit/audit-log.service';
import { LocationsRepository } from '../locations/locations.repository';
import { CreateUnitDto } from './dto/create-unit.dto';
import { QueryUnitsDto } from './dto/query-units.dto';
import { UpdateUnitDto } from './dto/update-unit.dto';
import {
  RetailUnitWithLocation,
  UnitsRepository,
} from './units.repository';

function prismaErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null
    ? String((error as { code?: unknown }).code ?? '')
    : undefined;
}

@Injectable()
export class UnitsService {
  constructor(
    private readonly unitsRepository: UnitsRepository,
    private readonly locationsRepository: LocationsRepository,
  ) {}

  async create(
    tenantId: string,
    dto: CreateUnitDto,
    actor?: AuditActor,
  ): Promise<RetailUnitWithLocation> {
    const name = dto.name.trim();
    if (!name) {
      throw new BadRequestException('Unit name is required');
    }
    const code = dto.code.trim().toUpperCase();
    // The store must exist IN THIS TENANT (scoped lookup).
    await this.assertLocation(tenantId, dto.locationId);

    try {
      return await this.unitsRepository.create(
        tenantId,
        {
          locationId: dto.locationId,
          code,
          name,
          type: dto.type,
          status: dto.status,
          placement: dto.placement?.trim() || undefined,
        },
        (unit) =>
          this.auditEntry(tenantId, actor, {
            action: AuditAction.CREATE,
            entityType: 'RetailUnit',
            entityId: unit.id,
            after: unit,
            reason: 'Retail unit created',
          }),
      );
    } catch (error) {
      if (prismaErrorCode(error) === 'P2002') {
        throw new ConflictException(
          `A unit with code "${code}" already exists for this tenant`,
        );
      }
      // The store was validated above, but a concurrent delete can remove it
      // before the insert lands, surfacing a Restrict FK violation. Map it
      // to a controlled 400 instead of a 500.
      if (prismaErrorCode(error) === 'P2003') {
        throw new BadRequestException(
          'Referenced store no longer exists',
        );
      }
      throw error;
    }
  }

  async findById(
    tenantId: string,
    id: string,
  ): Promise<RetailUnitWithLocation> {
    const unit = await this.unitsRepository.findById(tenantId, id);
    if (!unit) {
      throw new NotFoundException(`Unit "${id}" not found`);
    }
    return unit;
  }

  async search(
    tenantId: string,
    query: QueryUnitsDto,
  ): Promise<{
    items: RetailUnitWithLocation[];
    total: number;
    skip: number;
    take: number;
  }> {
    const skip = query.skip ?? 0;
    const take = query.take ?? 25;
    const { items, total } = await this.unitsRepository.search(tenantId, {
      search: query.search?.trim() || undefined,
      locationId: query.locationId,
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
    dto: UpdateUnitDto,
    actor?: AuditActor,
  ): Promise<RetailUnitWithLocation> {
    const data: Parameters<UnitsRepository['update']>[2] = {};
    if (dto.locationId !== undefined) {
      data.locationId = dto.locationId;
    }
    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (!name) {
        throw new BadRequestException('Unit name is required');
      }
      data.name = name;
    }
    if (dto.type !== undefined) {
      data.type = dto.type;
    }
    if (dto.status !== undefined) {
      data.status = dto.status;
    }
    if (dto.placement !== undefined) {
      data.placement =
        dto.placement === null ? null : dto.placement.trim() || null;
    }
    if (Object.keys(data).length === 0) {
      throw new BadRequestException('No fields to update');
    }
    if (data.locationId !== undefined) {
      await this.assertLocation(tenantId, data.locationId);
    }

    let updated: Awaited<ReturnType<UnitsRepository['update']>>;
    try {
      updated = await this.unitsRepository.update(
        tenantId,
        id,
        data,
        (before, after) =>
          this.auditEntry(tenantId, actor, {
            action: AuditAction.UPDATE,
            entityType: 'RetailUnit',
            entityId: after.id,
            before,
            after,
            reason:
              dto.status !== undefined
                ? 'Retail unit updated (status change)'
                : 'Retail unit updated',
          }),
      );
    } catch (error) {
      // Concurrent store delete after the assert above (Restrict FK).
      if (prismaErrorCode(error) === 'P2003') {
        throw new BadRequestException('Referenced store no longer exists');
      }
      // The row was read inside the transaction, then deleted by another
      // request before the unique update executed — Prisma raises P2025.
      if (prismaErrorCode(error) === 'P2025') {
        throw new NotFoundException(`Unit "${id}" not found`);
      }
      throw error;
    }
    if (updated === 'retired-blocked') {
      throw new ConflictException(
        'A RETIRED unit is terminal and cannot change status; provision a new unit instead',
      );
    }
    if (!updated) {
      throw new NotFoundException(`Unit "${id}" not found`);
    }
    return updated;
  }

  async delete(
    tenantId: string,
    id: string,
    actor?: AuditActor,
  ): Promise<void> {
    let deleted: RetailUnit | 'has-devices' | null;
    try {
      deleted = await this.unitsRepository.delete(tenantId, id, (unit) =>
        this.auditEntry(tenantId, actor, {
          action: AuditAction.DELETE,
          entityType: 'RetailUnit',
          entityId: unit.id,
          before: unit,
          reason: 'Retail unit deleted',
        }),
      );
    } catch (error) {
      // FK backstop for future referencing tables (the device check is
      // explicit inside the transaction).
      if (prismaErrorCode(error) === 'P2003') {
        throw new ConflictException(
          'Unit is still referenced and cannot be deleted; retire it instead',
        );
      }
      // Double-delete race: the row is already gone — surface the normal 404.
      if (prismaErrorCode(error) === 'P2025') {
        throw new NotFoundException(`Unit "${id}" not found`);
      }
      throw error;
    }
    if (deleted === 'has-devices') {
      throw new ConflictException(
        'Unit still has devices assigned and cannot be deleted; remove or reassign its devices first',
      );
    }
    if (!deleted) {
      throw new NotFoundException(`Unit "${id}" not found`);
    }
  }

  /** The store must exist IN THIS TENANT (scoped lookup). */
  private async assertLocation(
    tenantId: string,
    locationId: string,
  ): Promise<void> {
    const location = await this.locationsRepository.findById(
      tenantId,
      locationId,
    );
    if (!location) {
      throw new BadRequestException(`Store "${locationId}" not found`);
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
