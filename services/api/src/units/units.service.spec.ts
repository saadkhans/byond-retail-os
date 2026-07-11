import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  RetailUnitStatus,
  RetailUnitType,
} from '@prisma/client';
import { AuditEntry } from '../common/audit/audit-log.service';
import { LocationsRepository } from '../locations/locations.repository';
import { RetailUnitWithLocation, UnitsRepository } from './units.repository';
import { UnitsService } from './units.service';

describe('UnitsService', () => {
  const unit = {
    id: 'unit-1',
    tenantId: 'tenant-a',
    locationId: 'loc-a1',
    code: 'FRIDGE-001',
    name: 'Entrance Smart Fridge',
    type: RetailUnitType.SMART_FRIDGE,
    status: RetailUnitStatus.DRAFT,
    placement: null,
  } as unknown as RetailUnitWithLocation;

  let repository: {
    create: jest.Mock;
    findById: jest.Mock;
    search: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
  };
  let locationsRepository: { findById: jest.Mock };
  let service: UnitsService;

  beforeEach(() => {
    repository = {
      create: jest.fn().mockResolvedValue(unit),
      findById: jest.fn().mockResolvedValue(unit),
      search: jest.fn().mockResolvedValue({ items: [unit], total: 1 }),
      update: jest.fn().mockResolvedValue(unit),
      delete: jest.fn().mockResolvedValue(unit),
    };
    locationsRepository = {
      findById: jest.fn().mockResolvedValue({ id: 'loc-a1' }),
    };
    service = new UnitsService(
      repository as unknown as UnitsRepository,
      locationsRepository as unknown as LocationsRepository,
    );
  });

  it('rejects whitespace-only names before touching the repository', async () => {
    await expect(
      service.create('tenant-a', {
        locationId: 'loc-a1',
        code: 'FRIDGE-001',
        name: '   ',
        type: RetailUnitType.SMART_FRIDGE,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('rejects a store that does not exist in this tenant (scoped lookup)', async () => {
    locationsRepository.findById.mockResolvedValue(null);
    await expect(
      service.create('tenant-a', {
        locationId: 'loc-b1',
        code: 'FRIDGE-001',
        name: 'Fridge',
        type: RetailUnitType.SMART_FRIDGE,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(locationsRepository.findById).toHaveBeenCalledWith(
      'tenant-a',
      'loc-b1',
    );
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('uppercases the code and passes a CREATE audit builder', async () => {
    await service.create(
      'tenant-a',
      {
        locationId: 'loc-a1',
        code: 'fridge-001',
        name: ' Entrance Smart Fridge ',
        type: RetailUnitType.SMART_FRIDGE,
      },
      { id: 'user-1', email: 'jane@tenant-a.example' },
    );
    expect(repository.create).toHaveBeenCalledWith(
      'tenant-a',
      expect.objectContaining({
        code: 'FRIDGE-001',
        name: 'Entrance Smart Fridge',
      }),
      expect.any(Function),
    );
    const buildAuditEntry = repository.create.mock
      .calls[0][2] as (created: RetailUnitWithLocation) => AuditEntry;
    expect(buildAuditEntry(unit)).toEqual(
      expect.objectContaining({
        tenantId: 'tenant-a',
        actorId: 'user-1',
        action: AuditAction.CREATE,
        entityType: 'RetailUnit',
        entityId: unit.id,
      }),
    );
  });

  it('maps duplicate codes to a conflict error', async () => {
    repository.create.mockRejectedValue({ code: 'P2002' });
    await expect(
      service.create('tenant-a', {
        locationId: 'loc-a1',
        code: 'FRIDGE-001',
        name: 'Fridge',
        type: RetailUnitType.SMART_FRIDGE,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('maps a concurrent store delete during create (P2003) to a 400', async () => {
    repository.create.mockRejectedValue({ code: 'P2003' });
    await expect(
      service.create('tenant-a', {
        locationId: 'loc-a1',
        code: 'FRIDGE-001',
        name: 'Fridge',
        type: RetailUnitType.SMART_FRIDGE,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an empty update and 404s on a foreign target', async () => {
    await expect(
      service.update('tenant-a', 'unit-1', {}),
    ).rejects.toBeInstanceOf(BadRequestException);
    repository.update.mockResolvedValue(null);
    await expect(
      service.update('tenant-a', 'unit-foreign', { name: 'X' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('validates a reassigned store against the SAME tenant', async () => {
    locationsRepository.findById.mockResolvedValue(null);
    await expect(
      service.update('tenant-a', 'unit-1', { locationId: 'loc-b1' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(locationsRepository.findById).toHaveBeenCalledWith(
      'tenant-a',
      'loc-b1',
    );
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('maps the retired-blocked sentinel to a conflict', async () => {
    repository.update.mockResolvedValue('retired-blocked');
    await expect(
      service.update('tenant-a', 'unit-1', {
        status: RetailUnitStatus.ACTIVE,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('maps a concurrent delete during update (P2025) to a 404', async () => {
    repository.update.mockRejectedValue({ code: 'P2025' });
    await expect(
      service.update('tenant-a', 'unit-1', { name: 'X' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('maps the has-devices sentinel on delete to a conflict', async () => {
    repository.delete.mockResolvedValue('has-devices');
    await expect(service.delete('tenant-a', 'unit-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('maps delete FK violations (future references) to a conflict', async () => {
    repository.delete.mockRejectedValue({ code: 'P2003' });
    await expect(service.delete('tenant-a', 'unit-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('maps a double-delete race (P2025) to a 404', async () => {
    repository.delete.mockRejectedValue({ code: 'P2025' });
    await expect(service.delete('tenant-a', 'unit-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('search applies defaults and echoes pagination', async () => {
    const result = await service.search('tenant-a', {});
    expect(repository.search).toHaveBeenCalledWith(
      'tenant-a',
      expect.objectContaining({ skip: 0, take: 25 }),
    );
    expect(result).toEqual({ items: [unit], total: 1, skip: 0, take: 25 });
  });
});
