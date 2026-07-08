import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction } from '@prisma/client';
import { AuditEntry } from '../common/audit/audit-log.service';
import { BrandsRepository } from './brands.repository';
import { CategoriesRepository } from './categories.repository';
import {
  ProductsRepository,
  ProductWithRelations,
} from './products.repository';
import { ProductsService } from './products.service';

describe('ProductsService', () => {
  const product = {
    id: 'prod-1',
    tenantId: 'tenant-a',
    sku: 'BEV-COLA-330',
    name: 'Cola 330ml Can',
    status: 'DRAFT',
    barcodes: [],
    category: null,
    brand: null,
  } as unknown as ProductWithRelations;

  let products: {
    create: jest.Mock;
    findById: jest.Mock;
    search: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    addBarcode: jest.Mock;
    removeBarcode: jest.Mock;
  };
  let categories: { findById: jest.Mock };
  let brands: { findById: jest.Mock };
  let service: ProductsService;

  beforeEach(() => {
    products = {
      create: jest.fn().mockResolvedValue(product),
      findById: jest.fn().mockResolvedValue(product),
      search: jest.fn().mockResolvedValue({ items: [product], total: 1 }),
      update: jest.fn().mockResolvedValue(product),
      delete: jest.fn().mockResolvedValue(product),
      addBarcode: jest.fn().mockResolvedValue({ id: 'bc-1' }),
      removeBarcode: jest.fn().mockResolvedValue({ id: 'bc-1' }),
    };
    categories = { findById: jest.fn().mockResolvedValue({ id: 'cat-1' }) };
    brands = { findById: jest.fn().mockResolvedValue({ id: 'brand-1' }) };
    service = new ProductsService(
      products as unknown as ProductsRepository,
      categories as unknown as CategoriesRepository,
      brands as unknown as BrandsRepository,
    );
  });

  it('normalizes the SKU to uppercase and trims the name', async () => {
    await service.create('tenant-a', {
      sku: 'bev-cola-330',
      name: '  Cola 330ml Can ',
    });
    expect(products.create).toHaveBeenCalledWith(
      'tenant-a',
      expect.objectContaining({ sku: 'BEV-COLA-330', name: 'Cola 330ml Can' }),
      expect.any(Function),
    );
  });

  it('validates category and brand with TENANT-SCOPED lookups', async () => {
    categories.findById.mockResolvedValue(null);
    await expect(
      service.create('tenant-a', {
        sku: 'X-1',
        name: 'X',
        categoryId: 'cat-foreign',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(categories.findById).toHaveBeenCalledWith(
      'tenant-a',
      'cat-foreign',
    );
    expect(products.create).not.toHaveBeenCalled();

    categories.findById.mockResolvedValue({ id: 'cat-1' });
    brands.findById.mockResolvedValue(null);
    await expect(
      service.create('tenant-a', {
        sku: 'X-1',
        name: 'X',
        brandId: 'brand-foreign',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(products.create).not.toHaveBeenCalled();
  });

  it('rejects duplicate barcode values within one request', async () => {
    await expect(
      service.create('tenant-a', {
        sku: 'X-1',
        name: 'X',
        barcodes: [{ value: '123' }, { value: ' 123 ' }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(products.create).not.toHaveBeenCalled();
  });

  it('builds a CREATE audit entry for new products', async () => {
    await service.create(
      'tenant-a',
      { sku: 'BEV-COLA-330', name: 'Cola' },
      { id: 'user-1', email: 'jane@tenant-a.example' },
    );
    const buildAuditEntry = products.create.mock
      .calls[0][2] as (created: ProductWithRelations) => AuditEntry;
    expect(buildAuditEntry(product)).toEqual(
      expect.objectContaining({
        tenantId: 'tenant-a',
        actorId: 'user-1',
        action: AuditAction.CREATE,
        entityType: 'Product',
        entityId: product.id,
      }),
    );
  });

  it('maps SKU/barcode unique violations to a conflict error', async () => {
    products.create.mockRejectedValue({ code: 'P2002' });
    await expect(
      service.create('tenant-a', { sku: 'BEV-COLA-330', name: 'Cola' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('maps a stale category/brand FK violation on create to a 400', async () => {
    // A concurrent delete removed the referenced category/brand between
    // validation and the insert landing.
    products.create.mockRejectedValue({ code: 'P2003' });
    await expect(
      service.create('tenant-a', {
        sku: 'BEV-COLA-330',
        name: 'Cola',
        categoryId: 'cat-x',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an empty update and 404s on a foreign target', async () => {
    await expect(
      service.update('tenant-a', 'prod-1', {}),
    ).rejects.toBeInstanceOf(BadRequestException);
    products.update.mockResolvedValue(null);
    await expect(
      service.update('tenant-a', 'prod-foreign', { name: 'X' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('maps a blocked unit-of-measure change to a conflict', async () => {
    products.update.mockResolvedValue('uom-change-blocked');
    await expect(
      service.update('tenant-a', 'prod-1', { unitOfMeasure: 'CASE' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('maps a blocked archive (on-hand stock) to a conflict', async () => {
    products.update.mockResolvedValue('archive-blocked');
    await expect(
      service.update('tenant-a', 'prod-1', { status: 'ARCHIVED' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('maps a stale category/brand FK violation on update to a 400', async () => {
    // A concurrent delete removed the referenced category/brand between the
    // service's validation and the update landing.
    products.update.mockRejectedValue({ code: 'P2003' });
    await expect(
      service.update('tenant-a', 'prod-1', { categoryId: 'cat-x' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('maps a concurrent product delete (P2025) on update to a 404', async () => {
    // A plain field update read `before`, then the product was deleted before
    // the write landed.
    products.update.mockRejectedValue({ code: 'P2025' });
    await expect(
      service.update('tenant-a', 'prod-1', { name: 'Renamed' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('maps delete FK violations to "archive instead" conflict', async () => {
    products.delete.mockRejectedValue({ code: 'P2003' });
    await expect(service.delete('tenant-a', 'prod-1')).rejects.toThrow(
      /ARCHIVED/,
    );
  });

  it('passes pagination defaults and trimmed filters to search', async () => {
    const result = await service.search('tenant-a', { search: ' cola ' });
    expect(products.search).toHaveBeenCalledWith(
      'tenant-a',
      expect.objectContaining({ search: 'cola', skip: 0, take: 25 }),
    );
    expect(result).toEqual(
      expect.objectContaining({ total: 1, skip: 0, take: 25 }),
    );
  });

  it('404s when adding a barcode to a product outside this tenant', async () => {
    products.addBarcode.mockResolvedValue('product-not-found');
    await expect(
      service.addBarcode('tenant-a', 'prod-foreign', { value: '123' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('maps duplicate barcodes to a conflict error', async () => {
    products.addBarcode.mockRejectedValue({ code: 'P2002' });
    await expect(
      service.addBarcode('tenant-a', 'prod-1', { value: '123' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('404s when removing a barcode that is not on the product', async () => {
    products.removeBarcode.mockResolvedValue(null);
    await expect(
      service.removeBarcode('tenant-a', 'prod-1', 'bc-x'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
