import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import {
  REQUIRED_MODULE_KEY,
  REQUIRED_PERMISSIONS_KEY,
  TENANT_ONLY_KEY,
} from '../auth/decorators/access-policy.decorators';
import { CreatePriceBookDto } from './dto/create-price-book.dto';
import { SetEntriesDto } from './dto/set-entries.dto';
import { PriceBooksController, PricesController } from './pricing.controller';

/**
 * Access-policy pin for the pricing surface: tenant-scoped, gated on the
 * pricing module, reads separated from changes. Price changes are the most
 * consequential non-inventory mutation in the platform, so the permission
 * split is asserted rather than assumed.
 */
describe('pricing controllers access policy', () => {
  it.each([
    ['PriceBooksController', PriceBooksController],
    ['PricesController', PricesController],
  ])('%s is tenant-only and gated on the pricing module', (_name, target) => {
    expect(Reflect.getMetadata(TENANT_ONLY_KEY, target)).toBe(true);
    expect(Reflect.getMetadata(REQUIRED_MODULE_KEY, target)).toBe('pricing');
  });

  it.each([
    ['list', ['price-book:read']],
    ['findOne', ['price-book:read']],
    ['findVersion', ['price-book:read']],
    ['listEntries', ['price-book:read']],
    ['create', ['price-book:manage']],
    ['update', ['price-book:manage']],
    ['createVersion', ['price-book:manage']],
    ['setEntries', ['price-book:manage']],
    ['activate', ['price-book:manage']],
    ['rollback', ['price-book:manage']],
  ] as const)('requires %s permissions', (handler, expected) => {
    expect(
      Reflect.getMetadata(
        REQUIRED_PERMISSIONS_KEY,
        PriceBooksController.prototype[handler],
      ),
    ).toEqual(expected);
  });

  it('gates price resolution behind price:read', () => {
    expect(
      Reflect.getMetadata(
        REQUIRED_PERMISSIONS_KEY,
        PricesController.prototype.resolve,
      ),
    ).toEqual(['price:read']);
  });
});

describe('pricing controllers delegate with the caller’s tenant', () => {
  const pricing = {
    findBooks: jest.fn(async () => ({ items: [], total: 0 })),
    createBook: jest.fn(async () => ({ id: 'book-1' })),
    resolve: jest.fn(async () => null),
  };
  const books = new PriceBooksController(pricing as never);
  const prices = new PricesController(pricing as never);

  beforeEach(() => jest.clearAllMocks());

  it('passes the authenticated tenant, never one from the body', async () => {
    await books.list('tenant-1', {});
    expect(pricing.findBooks).toHaveBeenCalledWith('tenant-1', {});
  });

  it('passes the authenticated actor to mutations', async () => {
    await books.create(
      'tenant-1',
      { code: 'RETAIL', name: 'Retail', currencyCode: 'AED' },
      { userId: 'user-9', email: 'ops@example.com' } as never,
    );
    expect(pricing.createBook).toHaveBeenCalledWith(
      'tenant-1',
      expect.anything(),
      { id: 'user-9', email: 'ops@example.com' },
    );
  });

  it('resolves prices in the caller’s tenant', async () => {
    await prices.resolve('tenant-1', { productId: 'prod-a' });
    expect(pricing.resolve).toHaveBeenCalledWith('tenant-1', {
      productId: 'prod-a',
    });
  });
});

describe('pricing DTO validation', () => {
  async function errorsFor<T extends object>(
    cls: new () => T,
    payload: Record<string, unknown>,
  ): Promise<string[]> {
    const dto = plainToInstance(cls, payload);
    const errors = await validate(dto as object, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    return errors.map((error) => error.property);
  }

  it('accepts a well-formed price book', async () => {
    await expect(
      errorsFor(CreatePriceBookDto, {
        code: 'RETAIL',
        name: 'Retail',
        currencyCode: 'AED',
      }),
    ).resolves.toEqual([]);
  });

  it('rejects a currency that is not a three-letter code', async () => {
    await expect(
      errorsFor(CreatePriceBookDto, {
        code: 'RETAIL',
        name: 'Retail',
        currencyCode: 'DIRHAMS',
      }),
    ).resolves.toContain('currencyCode');
  });

  it('rejects a negative price — a price is never a credit', async () => {
    await expect(
      errorsFor(SetEntriesDto, {
        entries: [{ productId: 'prod-a', unitPriceMinor: -1 }],
      }),
    ).resolves.toContain('entries');
  });

  it('rejects a fractional price — minor units are integers', async () => {
    await expect(
      errorsFor(SetEntriesDto, {
        entries: [{ productId: 'prod-a', unitPriceMinor: 10.99 }],
      }),
    ).resolves.toContain('entries');
  });

  it('rejects an empty entry set', async () => {
    await expect(
      errorsFor(SetEntriesDto, { entries: [] }),
    ).resolves.toContain('entries');
  });
});
