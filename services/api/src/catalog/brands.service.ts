import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, Brand } from '@prisma/client';
import {
  AuditActor,
  AuditEntry,
  SYSTEM_ACTOR_EMAIL,
} from '../common/audit/audit-log.service';
import { BrandsRepository } from './brands.repository';
import { CreateBrandDto } from './dto/create-brand.dto';
import { UpdateBrandDto } from './dto/update-brand.dto';

function prismaErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null
    ? String((error as { code?: unknown }).code ?? '')
    : undefined;
}

@Injectable()
export class BrandsService {
  constructor(private readonly brandsRepository: BrandsRepository) {}

  async create(
    tenantId: string,
    dto: CreateBrandDto,
    actor?: AuditActor,
  ): Promise<Brand> {
    const name = dto.name.trim();
    if (!name) {
      throw new BadRequestException('Brand name is required');
    }
    try {
      return await this.brandsRepository.create(
        tenantId,
        { name, description: dto.description?.trim() || undefined },
        (brand) =>
          this.auditEntry(tenantId, actor, {
            action: AuditAction.CREATE,
            entityId: brand.id,
            after: brand,
            reason: 'Brand created',
          }),
      );
    } catch (error) {
      if (prismaErrorCode(error) === 'P2002') {
        throw new ConflictException(
          `A brand named "${name}" already exists for this tenant`,
        );
      }
      throw error;
    }
  }

  async findById(tenantId: string, id: string): Promise<Brand> {
    const brand = await this.brandsRepository.findById(tenantId, id);
    if (!brand) {
      throw new NotFoundException(`Brand "${id}" not found`);
    }
    return brand;
  }

  findMany(tenantId: string): Promise<Brand[]> {
    return this.brandsRepository.findMany(tenantId);
  }

  async update(
    tenantId: string,
    id: string,
    dto: UpdateBrandDto,
    actor?: AuditActor,
  ): Promise<Brand> {
    const data: { name?: string; description?: string } = {};
    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (!name) {
        throw new BadRequestException('Brand name is required');
      }
      data.name = name;
    }
    if (dto.description !== undefined) {
      data.description = dto.description.trim();
    }
    if (Object.keys(data).length === 0) {
      throw new BadRequestException('No fields to update');
    }

    let updated: Brand | null;
    try {
      updated = await this.brandsRepository.update(
        tenantId,
        id,
        data,
        (before, after) =>
          this.auditEntry(tenantId, actor, {
            action: AuditAction.UPDATE,
            entityId: after.id,
            before,
            after,
            reason: 'Brand updated',
          }),
      );
    } catch (error) {
      if (prismaErrorCode(error) === 'P2002') {
        throw new ConflictException(
          `A brand named "${data.name}" already exists for this tenant`,
        );
      }
      // The transaction reads the brand with the tenant filter, but a
      // concurrent DELETE can remove it between that read and the unique
      // update, so Prisma raises P2025. The target is gone — surface the same
      // 404 as a missing brand rather than a raw 500.
      if (prismaErrorCode(error) === 'P2025') {
        throw new NotFoundException(`Brand "${id}" not found`);
      }
      throw error;
    }
    if (!updated) {
      throw new NotFoundException(`Brand "${id}" not found`);
    }
    return updated;
  }

  async delete(
    tenantId: string,
    id: string,
    actor?: AuditActor,
  ): Promise<void> {
    let deleted: Brand | null;
    try {
      deleted = await this.brandsRepository.delete(tenantId, id, (brand) =>
        this.auditEntry(tenantId, actor, {
          action: AuditAction.DELETE,
          entityId: brand.id,
          before: brand,
          reason: 'Brand deleted',
        }),
      );
    } catch (error) {
      if (prismaErrorCode(error) === 'P2003') {
        throw new ConflictException(
          'Brand is still referenced by products; reassign them first',
        );
      }
      // A double-delete race: both requests pass the scoped findFirst, the
      // first commits, and the second reaches the unique delete which Prisma
      // reports as P2025. The row is already gone — surface the normal 404.
      if (prismaErrorCode(error) === 'P2025') {
        throw new NotFoundException(`Brand "${id}" not found`);
      }
      throw error;
    }
    if (!deleted) {
      throw new NotFoundException(`Brand "${id}" not found`);
    }
  }

  private auditEntry(
    tenantId: string,
    actor: AuditActor | undefined,
    partial: Pick<
      AuditEntry,
      'action' | 'entityId' | 'before' | 'after' | 'reason'
    >,
  ): AuditEntry {
    return {
      tenantId,
      actorId: actor?.id ?? null,
      actorEmail: actor?.email ?? SYSTEM_ACTOR_EMAIL,
      entityType: 'Brand',
      ...partial,
    };
  }
}
