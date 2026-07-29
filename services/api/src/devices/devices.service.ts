import { createHash, randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, Prisma } from '@prisma/client';
import {
  AuditActor,
  AuditEntry,
  SYSTEM_ACTOR_EMAIL,
} from '../common/audit/audit-log.service';
import { findSensitiveKeyPath } from '../common/sensitive-keys';
import { UnitsRepository } from '../units/units.repository';
import {
  DevicesRepository,
  DeviceRow,
  DeviceWithUnit,
} from './devices.repository';
import { CreateDeviceDto } from './dto/create-device.dto';
import { HeartbeatDto } from './dto/heartbeat.dto';
import { QueryDevicesDto } from './dto/query-devices.dto';
import { UpdateDeviceDto } from './dto/update-device.dto';

function prismaErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null
    ? String((error as { code?: unknown }).code ?? '')
    : undefined;
}

/** One-time registration tokens expire after this long. */
export const REGISTRATION_TOKEN_TTL_MS = 60 * 60 * 1000; // 60 minutes

export function hashRegistrationToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export interface IssuedRegistrationToken {
  /** Plaintext token — returned ONCE, never stored or logged. */
  registrationToken: string;
  expiresAt: Date;
}

@Injectable()
export class DevicesService {
  constructor(
    private readonly devicesRepository: DevicesRepository,
    private readonly unitsRepository: UnitsRepository,
  ) {}

  async create(
    tenantId: string,
    dto: CreateDeviceDto,
    actor?: AuditActor,
  ): Promise<DeviceWithUnit> {
    const name = dto.name.trim();
    if (!name) {
      throw new BadRequestException('Device name is required');
    }
    const serialNumber = dto.serialNumber.trim();
    if (!serialNumber) {
      throw new BadRequestException('Device serial number is required');
    }
    this.assertSafeMetadata(dto.metadata);
    // The unit must exist IN THIS TENANT (scoped lookup).
    await this.assertUnit(tenantId, dto.unitId);

    try {
      return await this.devicesRepository.create(
        tenantId,
        {
          unitId: dto.unitId,
          name,
          type: dto.type,
          status: dto.status,
          serialNumber,
          metadata: dto.metadata as Prisma.InputJsonValue | undefined,
          firmwareVersion: dto.firmwareVersion?.trim() || undefined,
          softwareVersion: dto.softwareVersion?.trim() || undefined,
        },
        (device) =>
          this.auditEntry(tenantId, actor, {
            action: AuditAction.CREATE,
            entityType: 'Device',
            entityId: device.id,
            after: device,
            reason: 'Device created',
          }),
      );
    } catch (error) {
      if (prismaErrorCode(error) === 'P2002') {
        throw new ConflictException(
          `A device with serial number "${serialNumber}" already exists for this tenant`,
        );
      }
      // The unit was validated above, but a concurrent delete can remove it
      // before the insert lands (Restrict FK) — controlled 400, not a 500.
      if (prismaErrorCode(error) === 'P2003') {
        throw new BadRequestException('Referenced unit no longer exists');
      }
      throw error;
    }
  }

  async findById(tenantId: string, id: string): Promise<DeviceWithUnit> {
    const device = await this.devicesRepository.findById(tenantId, id);
    if (!device) {
      throw new NotFoundException(`Device "${id}" not found`);
    }
    return device;
  }

  async search(
    tenantId: string,
    query: QueryDevicesDto,
  ): Promise<{
    items: DeviceWithUnit[];
    total: number;
    skip: number;
    take: number;
  }> {
    const skip = query.skip ?? 0;
    const take = query.take ?? 25;
    const { items, total } = await this.devicesRepository.search(tenantId, {
      search: query.search?.trim() || undefined,
      unitId: query.unitId,
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
    dto: UpdateDeviceDto,
    actor?: AuditActor,
  ): Promise<DeviceWithUnit> {
    const data: Parameters<DevicesRepository['update']>[2] = {};
    if (dto.unitId !== undefined) {
      data.unitId = dto.unitId;
    }
    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (!name) {
        throw new BadRequestException('Device name is required');
      }
      data.name = name;
    }
    if (dto.type !== undefined) {
      data.type = dto.type;
    }
    if (dto.status !== undefined) {
      data.status = dto.status;
    }
    if (dto.metadata !== undefined) {
      this.assertSafeMetadata(dto.metadata);
      data.metadata = dto.metadata as Prisma.InputJsonValue;
    }
    if (dto.firmwareVersion !== undefined) {
      data.firmwareVersion = dto.firmwareVersion.trim();
    }
    if (dto.softwareVersion !== undefined) {
      data.softwareVersion = dto.softwareVersion.trim();
    }
    if (Object.keys(data).length === 0) {
      throw new BadRequestException('No fields to update');
    }
    if (data.unitId !== undefined) {
      await this.assertUnit(tenantId, data.unitId);
    }

    let updated: Awaited<ReturnType<DevicesRepository['update']>>;
    try {
      updated = await this.devicesRepository.update(
        tenantId,
        id,
        data,
        (before, after) =>
          this.auditEntry(tenantId, actor, {
            action: AuditAction.UPDATE,
            entityType: 'Device',
            entityId: after.id,
            before,
            after,
            reason:
              dto.status !== undefined
                ? 'Device updated (status change)'
                : 'Device updated',
          }),
      );
    } catch (error) {
      // Concurrent unit delete after the assert above (Restrict FK).
      if (prismaErrorCode(error) === 'P2003') {
        throw new BadRequestException('Referenced unit no longer exists');
      }
      // The row was read inside the transaction, then deleted by another
      // request before the unique update executed — Prisma raises P2025.
      if (prismaErrorCode(error) === 'P2025') {
        throw new NotFoundException(`Device "${id}" not found`);
      }
      throw error;
    }
    if (updated === 'retired-blocked') {
      throw new ConflictException(
        'A RETIRED device is terminal and cannot change status; provision a new device instead',
      );
    }
    if (updated !== null && 'rejection' in updated) {
      throw new ConflictException(
        `Device still has ${updated.assetCount} live video asset(s) referencing it ` +
          'and cannot move to another unit; Phase 10 assets pin the ' +
          'store/unit/device hierarchy they were captured under — delete ' +
          'those assets first',
      );
    }
    if (!updated) {
      throw new NotFoundException(`Device "${id}" not found`);
    }
    return updated;
  }

  async delete(
    tenantId: string,
    id: string,
    actor?: AuditActor,
  ): Promise<void> {
    let deleted: DeviceRow | null;
    try {
      deleted = await this.devicesRepository.delete(tenantId, id, (device) =>
        this.auditEntry(tenantId, actor, {
          action: AuditAction.DELETE,
          entityType: 'Device',
          entityId: device.id,
          before: device,
          reason: 'Device deleted',
        }),
      );
    } catch (error) {
      // Double-delete race: the row is already gone — surface the normal 404.
      if (prismaErrorCode(error) === 'P2025') {
        throw new NotFoundException(`Device "${id}" not found`);
      }
      // A RESTRICT foreign key blocks the delete: the device is still
      // referenced (e.g. a checkout session's source device). Map to a
      // controlled 409 instead of leaking a raw Prisma error as a 500.
      if (prismaErrorCode(error) === 'P2003') {
        throw new ConflictException(
          'Device is referenced by checkout sessions or related records ' +
            'and cannot be deleted',
        );
      }
      throw error;
    }
    if (!deleted) {
      throw new NotFoundException(`Device "${id}" not found`);
    }
  }

  /**
   * Records a heartbeat. Status changes caused by the heartbeat (e.g.
   * OFFLINE → ONLINE) are audited with a HEARTBEAT action; routine
   * heartbeats only bump lastSeenAt and are not written to the audit log.
   */
  async heartbeat(
    tenantId: string,
    id: string,
    dto: HeartbeatDto,
    actor?: AuditActor,
  ): Promise<DeviceWithUnit> {
    const result = await this.devicesRepository.heartbeat(
      tenantId,
      id,
      {
        firmwareVersion: dto.firmwareVersion?.trim() || undefined,
        softwareVersion: dto.softwareVersion?.trim() || undefined,
      },
      (before, after) =>
        this.auditEntry(tenantId, actor, {
          action: AuditAction.HEARTBEAT,
          entityType: 'Device',
          entityId: after.id,
          before: { status: before.status, lastSeenAt: before.lastSeenAt },
          after: { status: after.status, lastSeenAt: after.lastSeenAt },
          reason: `Heartbeat changed status ${before.status} -> ${after.status}`,
        }),
    );
    if (result === 'inactive-blocked') {
      throw new ConflictException(
        'Device is DISABLED or RETIRED and cannot send heartbeats',
      );
    }
    if (!result) {
      throw new NotFoundException(`Device "${id}" not found`);
    }
    return result;
  }

  /**
   * Issues a one-time edge registration token for the device. Only the
   * SHA-256 hash is persisted; the plaintext appears exactly once — in this
   * method's return value — and is never logged or audited. Reissuing
   * invalidates any previously issued token.
   */
  async issueRegistrationToken(
    tenantId: string,
    id: string,
    actor?: AuditActor,
  ): Promise<IssuedRegistrationToken> {
    const registrationToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + REGISTRATION_TOKEN_TTL_MS);
    const result = await this.devicesRepository.issueRegistrationToken(
      tenantId,
      id,
      { tokenHash: hashRegistrationToken(registrationToken), expiresAt },
      (device) =>
        this.auditEntry(tenantId, actor, {
          action: AuditAction.REGISTER,
          entityType: 'Device',
          entityId: device.id,
          // Deliberately NOT the device row: only the fact that a token was
          // issued and when it expires — never the token or its hash.
          after: { registrationTokenIssued: true, expiresAt },
          reason: 'Edge registration token issued',
        }),
    );
    if (result === 'inactive-blocked') {
      throw new ConflictException(
        'Device is DISABLED or RETIRED and cannot be registered',
      );
    }
    if (!result) {
      throw new NotFoundException(`Device "${id}" not found`);
    }
    return { registrationToken, expiresAt };
  }

  /**
   * Device metadata is for SAFE, NON-SECRET configuration only. This BLOCKS
   * persistence (controlled 400) when any credential- or payment-shaped KEY
   * (passwords, tokens, secrets, API keys, card numbers, CVV/PIN/PAN in any
   * prefixed or camelCased alias, track data, ...) OR credential-bearing
   * string VALUE (rtsp://user:pass@camera.local, password= connection
   * strings, ...) appears anywhere in the object — recursively, through
   * nested objects and arrays. Audit-snapshot redaction is only a backstop;
   * such values must never reach storage in the first place (AGENTS.md
   * payments invariant).
   */
  private assertSafeMetadata(metadata?: Record<string, unknown>): void {
    if (metadata === undefined) {
      return;
    }
    const offendingPath = findSensitiveKeyPath(metadata);
    if (offendingPath) {
      throw new BadRequestException(
        `Device metadata must not contain credential- or payment-shaped ` +
          `keys or credential-bearing values ("${offendingPath}"). ` +
          `Metadata is for safe, non-secret configuration only — secrets ` +
          `belong in a dedicated secret store (reference them by name), ` +
          `and payment data must never be stored.`,
      );
    }
  }

  /** The unit must exist IN THIS TENANT (scoped lookup). */
  private async assertUnit(tenantId: string, unitId: string): Promise<void> {
    const unit = await this.unitsRepository.findById(tenantId, unitId);
    if (!unit) {
      throw new BadRequestException(`Unit "${unitId}" not found`);
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
