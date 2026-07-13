import { Injectable } from '@nestjs/common';
import { DeviceStatus, DeviceType, Prisma } from '@prisma/client';
import {
  AuditEntry,
  AuditLogService,
} from '../common/audit/audit-log.service';
import {
  deviceAdvisoryLockKey,
  unitAdvisoryLockKey,
} from '../common/locks';
import { PrismaService } from '../prisma/prisma.service';
import { TenantScopedRepository } from '../prisma/tenant-scoped.repository';

/** Read shape for device detail/list responses. */
export const DEVICE_INCLUDE = {
  unit: { select: { id: true, code: true, name: true, status: true, locationId: true } },
} satisfies Prisma.DeviceInclude;

/**
 * The registration token hash never leaves the data layer: every device row
 * returned by this repository omits it, so it can appear in neither API
 * responses nor audit snapshots.
 */
export const DEVICE_OMIT = {
  registrationTokenHash: true,
} satisfies Prisma.DeviceOmit;

export type DeviceWithUnit = Prisma.DeviceGetPayload<{
  include: typeof DEVICE_INCLUDE;
  omit: typeof DEVICE_OMIT;
}>;

export type DeviceRow = Prisma.DeviceGetPayload<{
  omit: typeof DEVICE_OMIT;
}>;

/**
 * Rejections surfaced as sentinels (mapped to HTTP errors in the service),
 * so the whole check-and-write stays inside one transaction:
 * - 'retired-blocked': RETIRED is terminal — a retired device's status can
 *   never change again.
 * - 'inactive-blocked': the device is DISABLED or RETIRED, so heartbeats
 *   and registration-token issuance are refused.
 */
export type DeviceUpdateRejection = 'retired-blocked';
export type DeviceLivenessRejection = 'inactive-blocked';

export interface DeviceSearchFilters {
  search?: string;
  unitId?: string;
  type?: DeviceType;
  status?: DeviceStatus;
  skip?: number;
  take?: number;
}

/** Statuses a successful heartbeat promotes to ONLINE. */
const HEARTBEAT_PROMOTABLE: readonly DeviceStatus[] = [
  DeviceStatus.PROVISIONED,
  DeviceStatus.OFFLINE,
  DeviceStatus.ONLINE,
];

@Injectable()
export class DevicesRepository extends TenantScopedRepository {
  constructor(
    prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {
    super(prisma);
  }

  create(
    tenantId: string,
    data: {
      unitId: string;
      name: string;
      type: DeviceType;
      status?: DeviceStatus;
      serialNumber: string;
      metadata?: Prisma.InputJsonValue;
      firmwareVersion?: string;
      softwareVersion?: string;
    },
    buildAuditEntry: (device: DeviceWithUnit) => AuditEntry,
  ): Promise<DeviceWithUnit> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      // Serialize with UnitsRepository.delete() (same key): the unit delete
      // counts devices under this lock, so a create cannot slip in between
      // that count and the unit's removal.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${unitAdvisoryLockKey(
        scopedTenantId,
        data.unitId,
      )}))`;
      const device = await tx.device.create({
        data: { ...data, tenantId: scopedTenantId },
        include: DEVICE_INCLUDE,
        omit: DEVICE_OMIT,
      });
      await this.auditLog.record(buildAuditEntry(device), tx);
      return device;
    });
  }

  findById(tenantId: string, id: string): Promise<DeviceWithUnit | null> {
    return this.prisma.device.findFirst({
      where: this.scope(tenantId, { id }),
      include: DEVICE_INCLUDE,
      omit: DEVICE_OMIT,
    });
  }

  async search(
    tenantId: string,
    filters: DeviceSearchFilters,
  ): Promise<{ items: DeviceWithUnit[]; total: number }> {
    const where: Prisma.DeviceWhereInput = this.scope(tenantId);
    if (filters.unitId) {
      where.unitId = filters.unitId;
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
        { serialNumber: { contains: filters.search, mode: 'insensitive' } },
      ];
    }
    const [items, total] = await Promise.all([
      this.prisma.device.findMany({
        where,
        include: DEVICE_INCLUDE,
        omit: DEVICE_OMIT,
        // id is the deterministic tie-breaker: name is not unique within a
        // tenant, so ties would otherwise reorder across skip/take pages.
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip: filters.skip ?? 0,
        take: filters.take ?? 25,
      }),
      this.prisma.device.count({ where }),
    ]);
    return { items, total };
  }

  update(
    tenantId: string,
    id: string,
    data: {
      unitId?: string;
      name?: string;
      type?: DeviceType;
      status?: DeviceStatus;
      metadata?: Prisma.InputJsonValue;
      firmwareVersion?: string;
      softwareVersion?: string;
    },
    buildAuditEntry: (
      before: DeviceRow,
      after: DeviceWithUnit,
    ) => AuditEntry,
  ): Promise<DeviceWithUnit | DeviceUpdateRejection | null> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      // Serialize with delete/heartbeat/registration (same key), so status
      // decisions never race and the DELETE audit snapshot stays authoritative.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${deviceAdvisoryLockKey(
        scopedTenantId,
        id,
      )}))`;
      const before = await tx.device.findFirst({
        where: { id, tenantId: scopedTenantId },
        omit: DEVICE_OMIT,
      });
      if (!before) {
        return null;
      }
      // RETIRED is terminal: once retired, a device's status never changes
      // again (provision replacement hardware as a new device instead).
      if (
        before.status === DeviceStatus.RETIRED &&
        data.status !== undefined &&
        data.status !== DeviceStatus.RETIRED
      ) {
        return 'retired-blocked' as const;
      }
      const after = await tx.device.update({
        where: { id: before.id },
        data,
        include: DEVICE_INCLUDE,
        omit: DEVICE_OMIT,
      });
      await this.auditLog.record(buildAuditEntry(before, after), tx);
      return after;
    });
  }

  delete(
    tenantId: string,
    id: string,
    buildAuditEntry: (deleted: DeviceRow) => AuditEntry,
  ): Promise<DeviceRow | null> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${deviceAdvisoryLockKey(
        scopedTenantId,
        id,
      )}))`;
      const existing = await tx.device.findFirst({
        where: { id, tenantId: scopedTenantId },
        omit: DEVICE_OMIT,
      });
      if (!existing) {
        return null;
      }
      await tx.device.delete({ where: { id: existing.id } });
      await this.auditLog.record(buildAuditEntry(existing), tx);
      return existing;
    });
  }

  /**
   * Records a device heartbeat: bumps lastSeenAt (server clock — never
   * client-supplied), optionally refreshes firmware/software versions, and
   * promotes PROVISIONED/OFFLINE devices to ONLINE. MAINTENANCE devices keep
   * their status (the heartbeat is still recorded); DISABLED/RETIRED devices
   * are refused. The audit entry is written ONLY when the status actually
   * changes — routine heartbeats would otherwise flood the audit log.
   */
  heartbeat(
    tenantId: string,
    id: string,
    data: { firmwareVersion?: string; softwareVersion?: string },
    buildAuditEntry: (
      before: DeviceRow,
      after: DeviceWithUnit,
    ) => AuditEntry,
  ): Promise<DeviceWithUnit | DeviceLivenessRejection | null> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${deviceAdvisoryLockKey(
        scopedTenantId,
        id,
      )}))`;
      const before = await tx.device.findFirst({
        where: { id, tenantId: scopedTenantId },
        omit: DEVICE_OMIT,
      });
      if (!before) {
        return null;
      }
      if (
        before.status === DeviceStatus.DISABLED ||
        before.status === DeviceStatus.RETIRED
      ) {
        return 'inactive-blocked' as const;
      }
      const nextStatus = HEARTBEAT_PROMOTABLE.includes(before.status)
        ? DeviceStatus.ONLINE
        : before.status;
      const after = await tx.device.update({
        where: { id: before.id },
        data: {
          ...data,
          status: nextStatus,
          lastSeenAt: new Date(),
        },
        include: DEVICE_INCLUDE,
        omit: DEVICE_OMIT,
      });
      if (after.status !== before.status) {
        await this.auditLog.record(buildAuditEntry(before, after), tx);
      }
      return after;
    });
  }

  /**
   * Stores the HASH of a freshly issued one-time registration token (the
   * plaintext never reaches this layer's storage or audit trail) together
   * with its expiry. Reissuing replaces — and thereby invalidates — any
   * previously issued token.
   */
  issueRegistrationToken(
    tenantId: string,
    id: string,
    data: { tokenHash: string; expiresAt: Date },
    buildAuditEntry: (device: DeviceRow) => AuditEntry,
  ): Promise<DeviceRow | DeviceLivenessRejection | null> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${deviceAdvisoryLockKey(
        scopedTenantId,
        id,
      )}))`;
      const before = await tx.device.findFirst({
        where: { id, tenantId: scopedTenantId },
        omit: DEVICE_OMIT,
      });
      if (!before) {
        return null;
      }
      if (
        before.status === DeviceStatus.DISABLED ||
        before.status === DeviceStatus.RETIRED
      ) {
        return 'inactive-blocked' as const;
      }
      const after = await tx.device.update({
        where: { id: before.id },
        data: {
          registrationTokenHash: data.tokenHash,
          registrationTokenExpiresAt: data.expiresAt,
        },
        omit: DEVICE_OMIT,
      });
      await this.auditLog.record(buildAuditEntry(after), tx);
      return after;
    });
  }
}
