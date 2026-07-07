import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, Tenant } from '@prisma/client';
import {
  AuditActor,
  SYSTEM_ACTOR_EMAIL,
} from '../common/audit/audit-log.service';
import { DEFAULT_ENABLED_MODULE_CODES } from '../platform-modules/platform-module.catalog';
import { CreateTenantDto } from './dto/create-tenant.dto';
import { TenantsRepository } from './tenants.repository';

export function toSlug(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

@Injectable()
export class TenantsService {
  constructor(private readonly tenantsRepository: TenantsRepository) {}

  async create(dto: CreateTenantDto, actor?: AuditActor): Promise<Tenant> {
    const name = dto.name?.trim();
    if (!name) {
      throw new BadRequestException('Tenant name is required');
    }
    const slug = toSlug(dto.slug ?? name);
    if (!slug) {
      throw new BadRequestException(
        'Tenant slug could not be derived from the given name; provide a slug',
      );
    }

    try {
      // The audit entry is written inside the repository transaction —
      // tenant, default modules, and audit row commit or roll back together.
      return await this.tenantsRepository.createWithDefaultModules(
        { name, slug },
        DEFAULT_ENABLED_MODULE_CODES,
        (tenant) => ({
          tenantId: tenant.id,
          actorId: actor?.id ?? null,
          actorEmail: actor?.email ?? SYSTEM_ACTOR_EMAIL,
          action: AuditAction.CREATE,
          entityType: 'Tenant',
          entityId: tenant.id,
          after: tenant,
          reason: 'Tenant created',
        }),
      );
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        throw new ConflictException(`Tenant slug "${slug}" already exists`);
      }
      throw error;
    }
  }

  async findById(id: string): Promise<Tenant> {
    const tenant = await this.tenantsRepository.findById(id);
    if (!tenant) {
      throw new NotFoundException(`Tenant "${id}" not found`);
    }
    return tenant;
  }
}
