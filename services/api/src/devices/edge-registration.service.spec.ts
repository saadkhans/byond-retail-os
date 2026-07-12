import { UnauthorizedException } from '@nestjs/common';
import { AuditAction, DeviceStatus } from '@prisma/client';
import { AuditEntry } from '../common/audit/audit-log.service';
import { DeviceWithUnit } from './devices.repository';
import { hashRegistrationToken } from './devices.service';
import { EdgeRegistrationRepository } from './edge-registration.repository';
import { EdgeRegistrationService } from './edge-registration.service';

describe('EdgeRegistrationService', () => {
  const registered = {
    id: 'device-1',
    tenantId: 'tenant-a',
    unitId: 'unit-1',
    name: 'Front door lock',
    type: 'DOOR_LOCK',
    status: DeviceStatus.ONLINE,
    serialNumber: 'SN-0001',
    registeredAt: new Date('2026-07-11T10:00:00Z'),
  } as unknown as DeviceWithUnit;

  let repository: { redeem: jest.Mock };
  let service: EdgeRegistrationService;

  beforeEach(() => {
    repository = { redeem: jest.fn().mockResolvedValue(registered) };
    service = new EdgeRegistrationService(
      repository as unknown as EdgeRegistrationRepository,
    );
  });

  it('hashes the token before it reaches the repository', async () => {
    await service.register({
      serialNumber: ' SN-0001 ',
      registrationToken: 'the-plaintext-token-value',
    });
    const [hash, serial] = repository.redeem.mock.calls[0] as [
      string,
      string,
    ];
    expect(hash).toBe(hashRegistrationToken('the-plaintext-token-value'));
    expect(hash).not.toBe('the-plaintext-token-value');
    expect(serial).toBe('SN-0001');
  });

  it('returns a minimal identity — never the full device row', async () => {
    const result = await service.register({
      serialNumber: 'SN-0001',
      registrationToken: 'the-plaintext-token-value',
    });
    expect(result).toEqual({
      deviceId: 'device-1',
      tenantId: 'tenant-a',
      unitId: 'unit-1',
      name: 'Front door lock',
      type: 'DOOR_LOCK',
      status: DeviceStatus.ONLINE,
      registeredAt: registered.registeredAt,
    });
  });

  it('audits the registration as a system-actor REGISTER without the token', async () => {
    await service.register({
      serialNumber: 'SN-0001',
      registrationToken: 'the-plaintext-token-value',
    });
    const buildAuditEntry = repository.redeem.mock.calls[0][2] as (
      before: {
        id: string;
        tenantId: string;
        status: DeviceStatus;
        registeredAt: Date | null;
      },
      after: DeviceWithUnit,
    ) => AuditEntry;
    const entry = buildAuditEntry(
      {
        id: 'device-1',
        tenantId: 'tenant-a',
        status: DeviceStatus.PROVISIONED,
        registeredAt: null,
      },
      registered,
    );
    expect(entry).toEqual(
      expect.objectContaining({
        tenantId: 'tenant-a',
        actorId: null,
        action: AuditAction.REGISTER,
        entityType: 'Device',
        entityId: 'device-1',
        before: {
          status: DeviceStatus.PROVISIONED,
          registered: false,
          registeredAt: null,
        },
        reason: 'Edge device registered with one-time token',
      }),
    );
    expect(JSON.stringify(entry)).not.toContain('the-plaintext-token-value');
  });

  it('audits a RE-registration with the real prior registered state', async () => {
    await service.register({
      serialNumber: 'SN-0001',
      registrationToken: 'the-plaintext-token-value',
    });
    const buildAuditEntry = repository.redeem.mock.calls[0][2] as (
      before: {
        id: string;
        tenantId: string;
        status: DeviceStatus;
        registeredAt: Date | null;
      },
      after: DeviceWithUnit,
    ) => AuditEntry;
    const previouslyRegisteredAt = new Date('2026-07-01T00:00:00Z');
    const entry = buildAuditEntry(
      {
        id: 'device-1',
        tenantId: 'tenant-a',
        status: DeviceStatus.ONLINE,
        registeredAt: previouslyRegisteredAt,
      },
      registered,
    );
    // The before snapshot must NOT claim the device was unregistered.
    expect(entry.before).toEqual({
      status: DeviceStatus.ONLINE,
      registered: true,
      registeredAt: previouslyRegisteredAt,
    });
    expect(entry.reason).toBe(
      'Edge device re-registered with one-time token',
    );
  });

  it('surfaces every failure as the same generic 401', async () => {
    repository.redeem.mockResolvedValue(null);
    await expect(
      service.register({
        serialNumber: 'SN-0001',
        registrationToken: 'expired-or-wrong-or-used',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
