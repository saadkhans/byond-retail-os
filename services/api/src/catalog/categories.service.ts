import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, ProductCategory } from '@prisma/client';
import {
  AuditActor,
  AuditEntry,
  SYSTEM_ACTOR_EMAIL,
} from '../common/audit/audit-log.service';
import { CategoriesRepository } from './categories.repository';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';

function prismaErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null
    ? String((error as { code?: unknown }).code ?? '')
    : undefined;
}

// Defensive cap when walking the parent chain; a legitimate retail category
// tree never approaches this depth.
const MAX_TREE_DEPTH = 64;

@Injectable()
export class CategoriesService {
  constructor(private readonly categoriesRepository: CategoriesRepository) {}

  async create(
    tenantId: string,
    dto: CreateCategoryDto,
    actor?: AuditActor,
  ): Promise<ProductCategory> {
    const name = dto.name.trim();
    if (!name) {
      throw new BadRequestException('Category name is required');
    }
    if (dto.parentId) {
      // Scoped lookup: a parent id from another tenant is simply not found.
      const parent = await this.categoriesRepository.findById(
        tenantId,
        dto.parentId,
      );
      if (!parent) {
        throw new BadRequestException(
          `Parent category "${dto.parentId}" not found`,
        );
      }
    }
    try {
      return await this.categoriesRepository.create(
        tenantId,
        {
          name,
          description: dto.description?.trim() || undefined,
          parentId: dto.parentId,
        },
        (category) =>
          this.auditEntry(tenantId, actor, {
            action: AuditAction.CREATE,
            entityId: category.id,
            after: category,
            reason: 'Product category created',
          }),
      );
    } catch (error) {
      if (prismaErrorCode(error) === 'P2002') {
        throw new ConflictException(
          `A category named "${name}" already exists for this tenant`,
        );
      }
      throw error;
    }
  }

  async findById(tenantId: string, id: string): Promise<ProductCategory> {
    const category = await this.categoriesRepository.findById(tenantId, id);
    if (!category) {
      throw new NotFoundException(`Category "${id}" not found`);
    }
    return category;
  }

  findMany(tenantId: string): Promise<ProductCategory[]> {
    return this.categoriesRepository.findMany(tenantId);
  }

  async update(
    tenantId: string,
    id: string,
    dto: UpdateCategoryDto,
    actor?: AuditActor,
  ): Promise<ProductCategory> {
    const data: {
      name?: string;
      description?: string;
      parentId?: string | null;
    } = {};
    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (!name) {
        throw new BadRequestException('Category name is required');
      }
      data.name = name;
    }
    if (dto.description !== undefined) {
      data.description = dto.description.trim();
    }
    if (dto.parentId !== undefined) {
      if (dto.parentId !== null) {
        await this.assertValidParent(tenantId, id, dto.parentId);
      }
      data.parentId = dto.parentId;
    }
    if (Object.keys(data).length === 0) {
      throw new BadRequestException('No fields to update');
    }

    let updated: ProductCategory | null;
    try {
      updated = await this.categoriesRepository.update(
        tenantId,
        id,
        data,
        (before, after) =>
          this.auditEntry(tenantId, actor, {
            action: AuditAction.UPDATE,
            entityId: after.id,
            before,
            after,
            reason: 'Product category updated',
          }),
      );
    } catch (error) {
      if (prismaErrorCode(error) === 'P2002') {
        throw new ConflictException(
          `A category named "${data.name}" already exists for this tenant`,
        );
      }
      throw error;
    }
    if (!updated) {
      throw new NotFoundException(`Category "${id}" not found`);
    }
    return updated;
  }

  async delete(
    tenantId: string,
    id: string,
    actor?: AuditActor,
  ): Promise<void> {
    let deleted: ProductCategory | null;
    try {
      deleted = await this.categoriesRepository.delete(tenantId, id, (category) =>
        this.auditEntry(tenantId, actor, {
          action: AuditAction.DELETE,
          entityId: category.id,
          before: category,
          reason: 'Product category deleted',
        }),
      );
    } catch (error) {
      if (prismaErrorCode(error) === 'P2003') {
        throw new ConflictException(
          'Category is still referenced by products or child categories; reassign them first',
        );
      }
      throw error;
    }
    if (!deleted) {
      throw new NotFoundException(`Category "${id}" not found`);
    }
  }

  /**
   * The new parent must exist IN THIS TENANT and must not create a cycle
   * (a category can never be its own ancestor).
   */
  private async assertValidParent(
    tenantId: string,
    id: string,
    parentId: string,
  ): Promise<void> {
    if (parentId === id) {
      throw new BadRequestException('A category cannot be its own parent');
    }
    const parent = await this.categoriesRepository.findById(
      tenantId,
      parentId,
    );
    if (!parent) {
      throw new BadRequestException(`Parent category "${parentId}" not found`);
    }
    let ancestor: ProductCategory | null = parent;
    for (let depth = 0; ancestor?.parentId; depth += 1) {
      if (depth >= MAX_TREE_DEPTH) {
        throw new BadRequestException('Category tree is too deep');
      }
      if (ancestor.parentId === id) {
        throw new BadRequestException(
          'Cannot move a category under one of its own descendants',
        );
      }
      ancestor = await this.categoriesRepository.findById(
        tenantId,
        ancestor.parentId,
      );
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
      entityType: 'ProductCategory',
      ...partial,
    };
  }
}
