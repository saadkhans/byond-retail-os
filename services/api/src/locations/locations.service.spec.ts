import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  Location,
  LocationStatus,
  LocationType,
} from '@prisma/client';
import { AuditEntry } from '../common/audit/audit-log.service';
import { LocationsRepository } from './locations.repository';
import { LocationsService } from './locations.service';

describe('LocationsService', () => {
  const location = {
    id: 'location-1',
    tenantId: 'tenant-a',
    name: 'Downtown Flagship',
    code: 'DT-001',
    status: LocationStatus.ACTIVE,
  } as Location;

  let repository: {
    create: jest.Mock;
    findById: jest.Mock;
    findMany: jest.Mock;
    search: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
  };
  let service: LocationsService;

  beforeEach(() => {
    repository = {
      create: jest.fn().mockResolvedValue(location),
      findById: jest.fn().mockResolvedValue(location),
      findMany: jest.fn().mockResolvedValue([location]),
      search: jest.fn().mockResolvedValue({ items: [location], total: 1 }),
      update: jest.fn().mockResolvedValue(location),
      delete: jest.fn().mockResolvedValue(location),
    };
    service = new LocationsService(
      repository as unknown as LocationsRepository,
    );
  });

  it('rejects whitespace-only names before touching the repository', async () => {
    await expect(
      service.create('tenant-a', {
        name: '   ',
        code: 'DT-001',
        type: LocationType.STORE,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('trims the name, uppercases the code, and passes an audit builder', async () => {
    await service.create('tenant-a', {
      name: '  Downtown Flagship ',
      code: 'dt-001',
      type: LocationType.STORE,
    });

    expect(repository.create).toHaveBeenCalledWith(
      'tenant-a',
      expect.objectContaining({
        name: 'Downtown Flagship',
        code: 'DT-001',
        type: LocationType.STORE,
      }),
      expect.any(Function),
    );
    const buildAuditEntry = repository.create.mock
      .calls[0][2] as (created: Location) => AuditEntry;
    expect(buildAuditEntry(location)).toEqual(
      expect.objectContaining({
        tenantId: 'tenant-a',
        action: AuditAction.CREATE,
        entityType: 'Location',
        entityId: location.id,
      }),
    );
  });

  it('maps duplicate codes to a conflict error', async () => {
    repository.create.mockRejectedValue({ code: 'P2002' });
    await expect(
      service.create('tenant-a', {
        name: 'Downtown Flagship',
        code: 'DT-001',
        type: LocationType.STORE,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('search applies defaults and echoes pagination', async () => {
    const result = await service.search('tenant-a', { search: '  down ' });
    expect(repository.search).toHaveBeenCalledWith('tenant-a', {
      search: 'down',
      type: undefined,
      status: undefined,
      skip: 0,
      take: 25,
    });
    expect(result).toEqual({ items: [location], total: 1, skip: 0, take: 25 });
  });

  it('rejects an empty update and 404s on a foreign target', async () => {
    await expect(
      service.update('tenant-a', 'location-1', {}),
    ).rejects.toBeInstanceOf(BadRequestException);
    repository.update.mockResolvedValue(null);
    await expect(
      service.update('tenant-a', 'location-foreign', { name: 'X' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('audits status changes with before/after snapshots', async () => {
    await service.update(
      'tenant-a',
      'location-1',
      { status: LocationStatus.CLOSED },
      { id: 'user-1', email: 'jane@tenant-a.example' },
    );
    const buildAuditEntry = repository.update.mock.calls[0][3] as (
      before: Location,
      after: Location,
    ) => AuditEntry;
    const closed = { ...location, status: LocationStatus.CLOSED };
    expect(buildAuditEntry(location, closed)).toEqual(
      expect.objectContaining({
        action: AuditAction.UPDATE,
        entityType: 'Location',
        before: location,
        after: closed,
        reason: 'Location updated (status change)',
      }),
    );
  });

  it('maps a concurrent delete during update (P2025) to a 404', async () => {
    repository.update.mockRejectedValue({ code: 'P2025' });
    await expect(
      service.update('tenant-a', 'location-1', { name: 'X' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('maps delete FK violations to a conflict (units/inventory reference it)', async () => {
    repository.delete.mockRejectedValue({ code: 'P2003' });
    await expect(
      service.delete('tenant-a', 'location-1'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('maps a double-delete race (P2025) to a 404', async () => {
    repository.delete.mockRejectedValue({ code: 'P2025' });
    await expect(
      service.delete('tenant-a', 'location-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
