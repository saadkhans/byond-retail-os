import { Injectable } from '@nestjs/common';
import { DeviceStatus } from '@prisma/client';
import {
  AuditEntry,
  AuditLogService,
} from '../common/audit/audit-log.service';
import { deviceAdvisoryLockKey } from '../common/locks';
import { PrismaService } from '../prisma/prisma.service';
import { DEVICE_INCLUDE, DEVICE_OMIT, DeviceWithUnit } from './devices.repository';

/**
 * EXPLICITLY NOT a TenantScopedRepository: the caller of the redemption flow
 * is an unauthenticated edge device that proves possession of a one-time
 * registration token. Tenant scope is derived from the token itself — the
 * hash lookup resolves to exactly one device row, whose tenantId then scopes
 * everything else in the transaction. No method here accepts a caller-chosen
 * tenantId, and no query is broader than the single token-matched row.
 */
@Injectable()
export class EdgeRegistrationRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  /**
   * Redeems a one-time registration token. Returns the registered device, or
   * null on ANY mismatch (unknown hash, wrong serial, expired token,
   * disabled/retired device) — callers surface a single generic error so the
   * endpoint cannot be used to probe which part failed.
   *
   * Single-use: the stored hash is cleared in the same transaction.
   */
  redeem(
    tokenHash: string,
    serialNumber: string,
    buildAuditEntry: (
      before: { id: string; tenantId: string; status: DeviceStatus },
      after: DeviceWithUnit,
    ) => AuditEntry,
  ): Promise<DeviceWithUnit | null> {
    return this.prisma.$transaction(async (tx) => {
      // The hash is unique — this resolves to at most one device, in exactly
      // one tenant. A wrong token finds nothing; timing reveals only that.
      const candidate = await tx.device.findUnique({
        where: { registrationTokenHash: tokenHash },
      });
      if (!candidate) {
        return null;
      }
      // Serialize with the device's other mutations (same key as
      // DevicesRepository) before deciding on the row's state.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${deviceAdvisoryLockKey(
        candidate.tenantId,
        candidate.id,
      )}))`;
      const device = await tx.device.findFirst({
        where: { id: candidate.id, registrationTokenHash: tokenHash },
      });
      if (
        !device ||
        device.serialNumber !== serialNumber ||
        !device.registrationTokenExpiresAt ||
        device.registrationTokenExpiresAt.getTime() < Date.now() ||
        device.status === DeviceStatus.DISABLED ||
        device.status === DeviceStatus.RETIRED
      ) {
        return null;
      }
      const after = await tx.device.update({
        where: { id: device.id },
        data: {
          registrationTokenHash: null,
          registrationTokenExpiresAt: null,
          registeredAt: new Date(),
          lastSeenAt: new Date(),
          status:
            device.status === DeviceStatus.PROVISIONED ||
            device.status === DeviceStatus.OFFLINE
              ? DeviceStatus.ONLINE
              : device.status,
        },
        include: DEVICE_INCLUDE,
        omit: DEVICE_OMIT,
      });
      await this.auditLog.record(
        buildAuditEntry(
          {
            id: device.id,
            tenantId: device.tenantId,
            status: device.status,
          },
          after,
        ),
        tx,
      );
      return after;
    });
  }
}
