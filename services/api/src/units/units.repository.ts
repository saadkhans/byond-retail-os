import { Injectable } from '@nestjs/common';
import {
  Prisma,
  RetailUnit,
  RetailUnitStatus,
  RetailUnitType,
} from '@prisma/client';
import {
  AuditEntry,
  AuditLogService,
} from '../common/audit/audit-log.service';
import { unitAdvisoryLockKey } from '../common/locks';
import { PrismaService } from '../prisma/prisma.service';
import { TenantScopedRepository } from '../prisma/tenant-scoped.repository';

/** Read shape for unit detail/list responses. */
export const UNIT_INCLUDE = {
  location: { select: { id: true, name: true, code: true, status: true } },
} satisfies Prisma.RetailUnitInclude;

export type RetailUnitWithLocation = Prisma.RetailUnitGetPayload<{
  include: typeof UNIT_INCLUDE;
}>;

/**
 * Rejections surfaced as sentinels (mapped to HTTP errors in the service),
 * so the whole check-and-write stays inside one transaction:
 * - 'retired-blocked': RETIRED is a terminal status — a retired unit's
 *   status can never change again.
 * - 'transition-blocked': the requested status change is not a legal
 *   lifecycle transition (see UNIT_STATUS_TRANSITIONS).
 * - 'has-devices': the unit still has devices assigned; deleting it would
 *   orphan them (and future phases will add inventory references).
 * - { rejection: 'has-video-assets', assetCount }: a store move is blocked
 *   while live (non-deleted) Phase 10 video assets reference the unit —
 *   assets denormalize the store/unit/device hierarchy they were captured
 *   under, and reparenting would strand their crops (the inference queue
 *   rejects the stale tuple with unit-location-mismatch). The count rides
 *   along so the HTTP mapping can name it.
 */
export interface UnitReparentRejection {
  rejection: 'has-video-assets';
  assetCount: number;
}
export type UnitUpdateRejection =
  | 'retired-blocked'
  | 'transition-blocked'
  | UnitReparentRejection;
export type UnitDeleteRejection = 'has-devices';

/**
 * The unit lifecycle state machine: DRAFT → ACTIVE ↔ MAINTENANCE/DISABLED →
 * RETIRED. A DRAFT unit has never been operational, so it cannot be retired
 * directly (delete it instead) and an operational unit cannot go back to
 * DRAFT. RETIRED is terminal.
 */
export const UNIT_STATUS_TRANSITIONS: Readonly<
  Record<RetailUnitStatus, readonly RetailUnitStatus[]>
> = {
  [RetailUnitStatus.DRAFT]: [
    RetailUnitStatus.ACTIVE,
    RetailUnitStatus.DISABLED,
  ],
  [RetailUnitStatus.ACTIVE]: [
    RetailUnitStatus.MAINTENANCE,
    RetailUnitStatus.DISABLED,
    RetailUnitStatus.RETIRED,
  ],
  [RetailUnitStatus.MAINTENANCE]: [
    RetailUnitStatus.ACTIVE,
    RetailUnitStatus.DISABLED,
    RetailUnitStatus.RETIRED,
  ],
  [RetailUnitStatus.DISABLED]: [
    RetailUnitStatus.ACTIVE,
    RetailUnitStatus.MAINTENANCE,
    RetailUnitStatus.RETIRED,
  ],
  [RetailUnitStatus.RETIRED]: [],
};

export interface UnitSearchFilters {
  search?: string;
  locationId?: string;
  type?: RetailUnitType;
  status?: RetailUnitStatus;
  skip?: number;
  take?: number;
}

@Injectable()
export class UnitsRepository extends TenantScopedRepository {
  constructor(
    prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {
    super(prisma);
  }

  create(
    tenantId: string,
    data: {
      locationId: string;
      code: string;
      name: string;
      type: RetailUnitType;
      status?: RetailUnitStatus;
      placement?: string;
    },
    buildAuditEntry: (unit: RetailUnitWithLocation) => AuditEntry,
  ): Promise<RetailUnitWithLocation> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      const unit = await tx.retailUnit.create({
        data: { ...data, tenantId: scopedTenantId },
        include: UNIT_INCLUDE,
      });
      await this.auditLog.record(buildAuditEntry(unit), tx);
      return unit;
    });
  }

  findById(
    tenantId: string,
    id: string,
  ): Promise<RetailUnitWithLocation | null> {
    return this.prisma.retailUnit.findFirst({
      where: this.scope(tenantId, { id }),
      include: UNIT_INCLUDE,
    });
  }

  async search(
    tenantId: string,
    filters: UnitSearchFilters,
  ): Promise<{ items: RetailUnitWithLocation[]; total: number }> {
    const where: Prisma.RetailUnitWhereInput = this.scope(tenantId);
    if (filters.locationId) {
      where.locationId = filters.locationId;
    }
    if (filters.type) {
      where.type = filters.type;
    }
    if (filters.status) {
      where.status = filters.status;
    }
    if (filters.search) {
      where.OR = [
        { name: { contains: filters.search, mode: 'insensitive' } },
        { code: { contains: filters.search, mode: 'insensitive' } },
      ];
    }
    const [items, total] = await Promise.all([
      this.prisma.retailUnit.findMany({
        where,
        include: UNIT_INCLUDE,
        // id is the deterministic tie-breaker: name is not unique within a
        // tenant, so ties would otherwise reorder across skip/take pages.
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip: filters.skip ?? 0,
        take: filters.take ?? 25,
      }),
      this.prisma.retailUnit.count({ where }),
    ]);
    return { items, total };
  }

  update(
    tenantId: string,
    id: string,
    data: {
      locationId?: string;
      name?: string;
      type?: RetailUnitType;
      status?: RetailUnitStatus;
      placement?: string | null;
    },
    buildAuditEntry: (
      before: RetailUnit,
      after: RetailUnitWithLocation,
    ) => AuditEntry,
  ): Promise<RetailUnitWithLocation | UnitUpdateRejection | null> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      // Serialize with delete() and device creation (same key), so the
      // DELETE audit's `before` snapshot always matches the row removed and
      // status checks cannot race.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${unitAdvisoryLockKey(
        scopedTenantId,
        id,
      )}))::text`;
      const before = await tx.retailUnit.findFirst({
        where: { id, tenantId: scopedTenantId },
      });
      if (!before) {
        return null;
      }
      // Lifecycle enforcement, checked inside the transaction so a
      // concurrent status change cannot slip an illegal jump through.
      if (data.status !== undefined && data.status !== before.status) {
        // RETIRED is terminal: once retired, a unit's status never changes
        // again (re-provision hardware as a new unit instead).
        if (before.status === RetailUnitStatus.RETIRED) {
          return 'retired-blocked' as const;
        }
        if (
          !UNIT_STATUS_TRANSITIONS[before.status].includes(data.status)
        ) {
          return 'transition-blocked' as const;
        }
      }
      // Phase 10 video assets denormalize the store/unit/device hierarchy
      // they were captured under (their bindings are historical evidence);
      // moving the unit to another store would leave every referencing
      // asset with a stale unit→store tuple, and the inference queue would
      // then reject its crops with unit-location-mismatch — permanently
      // stranding them. A store move is therefore BLOCKED while live
      // assets reference the unit; soft-deleted assets (deletedAt set) do
      // not block. Race-free under the unit advisory lock above:
      // VideoAssetsRepository.createAsset() takes the SAME unit lock
      // (canonical unit → device order) and holds it through its insert,
      // so a concurrent upload cannot land between this count and the
      // update below.
      if (
        data.locationId !== undefined &&
        data.locationId !== before.locationId
      ) {
        const assetCount = await tx.videoAsset.count({
          where: {
            unitId: before.id,
            tenantId: scopedTenantId,
            deletedAt: null,
          },
        });
        if (assetCount > 0) {
          return { rejection: 'has-video-assets', assetCount } as const;
        }
      }
      const after = await tx.retailUnit.update({
        where: { id: before.id },
        data,
        include: UNIT_INCLUDE,
      });
      await this.auditLog.record(buildAuditEntry(before, after), tx);
      return after;
    });
  }

  delete(
    tenantId: string,
    id: string,
    buildAuditEntry: (deleted: RetailUnit) => AuditEntry,
  ): Promise<RetailUnit | UnitDeleteRejection | null> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      // Serialize with device creation for this unit (DevicesRepository
      // takes the same key): otherwise a device create could land between
      // the device count below and the row removal.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${unitAdvisoryLockKey(
        scopedTenantId,
        id,
      )}))::text`;
      const existing = await tx.retailUnit.findFirst({
        where: { id, tenantId: scopedTenantId },
      });
      if (!existing) {
        return null;
      }
      const deviceCount = await tx.device.count({
        where: { unitId: existing.id, tenantId: scopedTenantId },
      });
      if (deviceCount > 0) {
        return 'has-devices' as const;
      }
      // Restrict FKs backstop the check above for any FUTURE referencing
      // table (P2003 is mapped to a controlled 409 in the service).
      await tx.retailUnit.delete({ where: { id: existing.id } });
      await this.auditLog.record(buildAuditEntry(existing), tx);
      return existing;
    });
  }
}
