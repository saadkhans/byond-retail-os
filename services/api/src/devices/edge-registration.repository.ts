import { Injectable } from '@nestjs/common';
import { DeviceStatus, ModuleStatus, TenantStatus } from '@prisma/client';
import {
  AuditEntry,
  AuditLogService,
} from '../common/audit/audit-log.service';
import { deviceAdvisoryLockKey } from '../common/locks';
import { PrismaService } from '../prisma/prisma.service';
import { DEVICE_INCLUDE, DEVICE_OMIT, DeviceWithUnit } from './devices.repository';

/** Module code gating all unit/device functionality (same as @RequireModule). */
const DEVICES_MODULE_CODE = 'devices';

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
   * null on ANY mismatch (unknown hash, disabled devices module, wrong
   * serial, expired token, disabled/retired device) — callers surface a
   * single generic error so the endpoint cannot be used to probe which part
   * failed.
   *
   * Single-use, and hostile-input hardened:
   * - A valid token presented with the WRONG serial is CONSUMED (hash and
   *   expiry cleared, nothing else mutated) before returning the generic
   *   failure — a leaked token grants exactly one serial guess, not a
   *   guessing window until expiry.
   * - When the tenant is not ACTIVE or has the devices module disabled, the
   *   redemption fails with NO mutation at all: authenticated routes fail
   *   closed on suspended tenants via AuthRepository, and this public
   *   endpoint must not be the exception. The token resumes working if the
   *   tenant/module is reactivated within its lifetime.
   * - On success the stored hash is cleared in the same transaction.
   */
  redeem(
    tokenHash: string,
    serialNumber: string,
    buildAuditEntry: (
      before: {
        id: string;
        tenantId: string;
        status: DeviceStatus;
        registeredAt: Date | null;
      },
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
      )}))::text`;
      const device = await tx.device.findFirst({
        where: { id: candidate.id, registrationTokenHash: tokenHash },
      });
      if (!device) {
        return null;
      }

      // Authenticated requests fail closed on non-ACTIVE tenants (login and
      // AuthGuard both check tenant status); this public route must apply
      // the same rule before ANY mutation — a token issued while the tenant
      // was ACTIVE must not register devices for a tenant that has since
      // been suspended/archived. Same generic failure, nothing consumed.
      const tenant = await tx.tenant.findUnique({
        where: { id: device.tenantId },
        select: { status: true },
      });
      if (tenant?.status !== TenantStatus.ACTIVE) {
        return null;
      }

      // Mirror ModuleEnabledGuard/PlatformModulesService.isEnabledForTenant
      // inside the transaction: registration is part of the devices module,
      // so a tenant that disabled it cannot complete the handshake. Checked
      // BEFORE the serial-mismatch consumption and with no mutation — the
      // outcome must stay indistinguishable from a bad token, and nothing
      // about the device may change.
      const platformModule = await tx.platformModule.findUnique({
        where: { code: DEVICES_MODULE_CODE },
      });
      if (!platformModule || !platformModule.isActive) {
        return null;
      }
      const tenantModule = await tx.tenantModule.findFirst({
        where: { tenantId: device.tenantId, moduleId: platformModule.id },
      });
      if (tenantModule?.status !== ModuleStatus.ENABLED) {
        return null;
      }

      // Wrong serial for a REAL token: consume the token so a leaked token
      // cannot be replayed with different serial guesses, then fail with the
      // same generic response as every other branch.
      if (device.serialNumber !== serialNumber) {
        await tx.device.update({
          where: { id: device.id },
          data: {
            registrationTokenHash: null,
            registrationTokenExpiresAt: null,
          },
        });
        return null;
      }

      if (
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
            // Real prior registration state: re-registration of a device
            // that was registered before must not be audited as first-time.
            registeredAt: device.registeredAt,
          },
          after,
        ),
        tx,
      );
      return after;
    });
  }
}
