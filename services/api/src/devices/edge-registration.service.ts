import { Injectable, UnauthorizedException } from '@nestjs/common';
import { AuditAction } from '@prisma/client';
import { SYSTEM_ACTOR_EMAIL } from '../common/audit/audit-log.service';
import { hashRegistrationToken } from './devices.service';
import { RegisterDeviceDto } from './dto/register-device.dto';
import { EdgeRegistrationRepository } from './edge-registration.repository';

/** Minimal identity returned to a successfully registered edge device. */
export interface EdgeRegistrationResult {
  deviceId: string;
  tenantId: string;
  unitId: string;
  name: string;
  type: string;
  status: string;
  registeredAt: Date | null;
}

@Injectable()
export class EdgeRegistrationService {
  constructor(
    private readonly edgeRegistrationRepository: EdgeRegistrationRepository,
  ) {}

  /**
   * Completes the edge registration handshake. The one-time token (issued by
   * a tenant admin holding device:register) is the credential: it is matched
   * by SHA-256 hash, bound to the device's serial number, single-use, and
   * expiring. Every failure mode surfaces the SAME generic 401 so the
   * endpoint cannot be used to probe serials or token validity, and neither
   * the token nor its hash is ever logged.
   *
   * Phase 7 (edge runtime) will exchange this registration for long-lived
   * device credentials; this phase deliberately mints none.
   */
  async register(dto: RegisterDeviceDto): Promise<EdgeRegistrationResult> {
    const device = await this.edgeRegistrationRepository.redeem(
      hashRegistrationToken(dto.registrationToken),
      dto.serialNumber.trim(),
      (before, after) => ({
        tenantId: before.tenantId,
        actorId: null,
        // No authenticated user exists on this route; the audit actor is the
        // system, attributed to the device via entityId.
        actorEmail: SYSTEM_ACTOR_EMAIL,
        action: AuditAction.REGISTER,
        entityType: 'Device',
        entityId: before.id,
        before: { status: before.status, registered: false },
        after: {
          status: after.status,
          registered: true,
          registeredAt: after.registeredAt,
        },
        reason: 'Edge device registered with one-time token',
      }),
    );
    if (!device) {
      throw new UnauthorizedException('Invalid registration token');
    }
    return {
      deviceId: device.id,
      tenantId: device.tenantId,
      unitId: device.unitId,
      name: device.name,
      type: device.type,
      status: device.status,
      registeredAt: device.registeredAt,
    };
  }
}
