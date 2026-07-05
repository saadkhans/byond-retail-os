import { BadRequestException, ConflictException } from '@nestjs/common';
import { AuditAction, Location, LocationType } from '@prisma/client';
import { AuditEntry } from '../common/audit/audit-log.service';
import { LocationsRepository } from './locations.repository';
import { LocationsService } from './locations.service';

describe('LocationsService', () => {
  const location = {
    id: 'location-1',
    tenantId: 'tenant-a',
    name: 'Downtown Flagship',
    code: 'DT-001',
  } as Location;

  let repository: { create: jest.Mock; findById: jest.Mock; findMany: jest.Mock };
  let service: LocationsService;

  beforeEach(() => {
    repository = {
      create: jest.fn().mockResolvedValue(location),
      findById: jest.fn().mockResolvedValue(location),
      findMany: jest.fn().mockResolvedValue([location]),
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
});
