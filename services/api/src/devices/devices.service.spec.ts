import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, DeviceStatus, DeviceType } from '@prisma/client';
import { AuditEntry } from '../common/audit/audit-log.service';
import { UnitsRepository } from '../units/units.repository';
import {
  DevicesRepository,
  DeviceRow,
  DeviceWithUnit,
} from './devices.repository';
import {
  DevicesService,
  hashRegistrationToken,
  REGISTRATION_TOKEN_TTL_MS,
} from './devices.service';

describe('DevicesService', () => {
  const device = {
    id: 'device-1',
    tenantId: 'tenant-a',
    unitId: 'unit-1',
    name: 'Front door lock',
    type: DeviceType.DOOR_LOCK,
    status: DeviceStatus.PROVISIONED,
    serialNumber: 'SN-0001',
    lastSeenAt: null,
  } as unknown as DeviceWithUnit;

  let repository: {
    create: jest.Mock;
    findById: jest.Mock;
    search: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    heartbeat: jest.Mock;
    issueRegistrationToken: jest.Mock;
  };
  let unitsRepository: { findById: jest.Mock };
  let service: DevicesService;

  beforeEach(() => {
    repository = {
      create: jest.fn().mockResolvedValue(device),
      findById: jest.fn().mockResolvedValue(device),
      search: jest.fn().mockResolvedValue({ items: [device], total: 1 }),
      update: jest.fn().mockResolvedValue(device),
      delete: jest.fn().mockResolvedValue(device),
      heartbeat: jest.fn().mockResolvedValue(device),
      issueRegistrationToken: jest.fn().mockResolvedValue(device),
    };
    unitsRepository = {
      findById: jest.fn().mockResolvedValue({ id: 'unit-1' }),
    };
    service = new DevicesService(
      repository as unknown as DevicesRepository,
      unitsRepository as unknown as UnitsRepository,
    );
  });

  it('rejects a unit that does not exist in this tenant (scoped lookup)', async () => {
    unitsRepository.findById.mockResolvedValue(null);
    await expect(
      service.create('tenant-a', {
        unitId: 'unit-b',
        name: 'Cam',
        type: DeviceType.CAMERA,
        serialNumber: 'SN-1',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(unitsRepository.findById).toHaveBeenCalledWith(
      'tenant-a',
      'unit-b',
    );
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('trims the serial and passes a CREATE audit builder', async () => {
    await service.create(
      'tenant-a',
      {
        unitId: 'unit-1',
        name: ' Front door lock ',
        type: DeviceType.DOOR_LOCK,
        serialNumber: ' SN-0001 ',
      },
      { id: 'user-1', email: 'jane@tenant-a.example' },
    );
    expect(repository.create).toHaveBeenCalledWith(
      'tenant-a',
      expect.objectContaining({
        name: 'Front door lock',
        serialNumber: 'SN-0001',
      }),
      expect.any(Function),
    );
    const buildAuditEntry = repository.create.mock
      .calls[0][2] as (created: DeviceWithUnit) => AuditEntry;
    expect(buildAuditEntry(device)).toEqual(
      expect.objectContaining({
        tenantId: 'tenant-a',
        actorId: 'user-1',
        action: AuditAction.CREATE,
        entityType: 'Device',
        entityId: device.id,
      }),
    );
  });

  it('maps duplicate serial numbers to a conflict error', async () => {
    repository.create.mockRejectedValue({ code: 'P2002' });
    await expect(
      service.create('tenant-a', {
        unitId: 'unit-1',
        name: 'Cam',
        type: DeviceType.CAMERA,
        serialNumber: 'SN-0001',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('maps a concurrent unit delete during create (P2003) to a 400', async () => {
    repository.create.mockRejectedValue({ code: 'P2003' });
    await expect(
      service.create('tenant-a', {
        unitId: 'unit-1',
        name: 'Cam',
        type: DeviceType.CAMERA,
        serialNumber: 'SN-0001',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an empty update and maps retired-blocked to a conflict', async () => {
    await expect(
      service.update('tenant-a', 'device-1', {}),
    ).rejects.toBeInstanceOf(BadRequestException);
    repository.update.mockResolvedValue('retired-blocked');
    await expect(
      service.update('tenant-a', 'device-1', {
        status: DeviceStatus.ONLINE,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('maps a concurrent delete during update (P2025) to a 404', async () => {
    repository.update.mockRejectedValue({ code: 'P2025' });
    await expect(
      service.update('tenant-a', 'device-1', { name: 'X' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('maps a double-delete race (P2025) to a 404', async () => {
    repository.delete.mockRejectedValue({ code: 'P2025' });
    await expect(
      service.delete('tenant-a', 'device-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  describe('heartbeat', () => {
    it('passes a HEARTBEAT audit builder with status-only snapshots', async () => {
      await service.heartbeat(
        'tenant-a',
        'device-1',
        { firmwareVersion: '1.4.2' },
        { id: 'user-1', email: 'jane@tenant-a.example' },
      );
      expect(repository.heartbeat).toHaveBeenCalledWith(
        'tenant-a',
        'device-1',
        { firmwareVersion: '1.4.2', softwareVersion: undefined },
        expect.any(Function),
      );
      const buildAuditEntry = repository.heartbeat.mock.calls[0][3] as (
        before: DeviceRow,
        after: DeviceWithUnit,
      ) => AuditEntry;
      const online = {
        ...device,
        status: DeviceStatus.ONLINE,
        lastSeenAt: new Date('2026-07-11T10:00:00Z'),
      } as unknown as DeviceWithUnit;
      const entry = buildAuditEntry(device as unknown as DeviceRow, online);
      expect(entry).toEqual(
        expect.objectContaining({
          action: AuditAction.HEARTBEAT,
          entityType: 'Device',
          before: { status: DeviceStatus.PROVISIONED, lastSeenAt: null },
          after: {
            status: DeviceStatus.ONLINE,
            lastSeenAt: online.lastSeenAt,
          },
        }),
      );
    });

    it('maps inactive-blocked to a conflict and a miss to a 404', async () => {
      repository.heartbeat.mockResolvedValue('inactive-blocked');
      await expect(
        service.heartbeat('tenant-a', 'device-1', {}),
      ).rejects.toBeInstanceOf(ConflictException);
      repository.heartbeat.mockResolvedValue(null);
      await expect(
        service.heartbeat('tenant-a', 'device-1', {}),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('issueRegistrationToken', () => {
    it('returns the plaintext once and stores only the hash', async () => {
      const issued = await service.issueRegistrationToken(
        'tenant-a',
        'device-1',
        { id: 'user-1', email: 'jane@tenant-a.example' },
      );
      expect(issued.registrationToken.length).toBeGreaterThanOrEqual(40);
      expect(issued.expiresAt.getTime()).toBeGreaterThan(Date.now());
      expect(issued.expiresAt.getTime()).toBeLessThanOrEqual(
        Date.now() + REGISTRATION_TOKEN_TTL_MS,
      );

      const [, , stored] = repository.issueRegistrationToken.mock.calls[0] as [
        string,
        string,
        { tokenHash: string; expiresAt: Date },
      ];
      // The repository receives the HASH, never the plaintext.
      expect(stored.tokenHash).toBe(
        hashRegistrationToken(issued.registrationToken),
      );
      expect(stored.tokenHash).not.toBe(issued.registrationToken);
    });

    it('never leaks the token or hash into the audit entry', async () => {
      const issued = await service.issueRegistrationToken(
        'tenant-a',
        'device-1',
      );
      const buildAuditEntry = repository.issueRegistrationToken.mock
        .calls[0][3] as (device: DeviceRow) => AuditEntry;
      const entry = buildAuditEntry(device as unknown as DeviceRow);
      expect(entry.action).toBe(AuditAction.REGISTER);
      const serialized = JSON.stringify(entry);
      expect(serialized).not.toContain(issued.registrationToken);
      expect(serialized).not.toContain(
        hashRegistrationToken(issued.registrationToken),
      );
    });

    it('maps inactive-blocked to a conflict and a miss to a 404', async () => {
      repository.issueRegistrationToken.mockResolvedValue('inactive-blocked');
      await expect(
        service.issueRegistrationToken('tenant-a', 'device-1'),
      ).rejects.toBeInstanceOf(ConflictException);
      repository.issueRegistrationToken.mockResolvedValue(null);
      await expect(
        service.issueRegistrationToken('tenant-a', 'device-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
