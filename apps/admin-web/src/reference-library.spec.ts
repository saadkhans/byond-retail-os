import { describe, expect, it } from 'vitest';
import { Paginated, Product } from './api';
import {
  mergeProducts,
  productSearchPaths,
} from './pages/ReferenceLibraryPage';

function page(items: Product[]): Paginated<Product> {
  return { items, total: items.length, skip: 0, take: 100 };
}

const AQUAFINA = {
  id: 'p1',
  sku: 'AQUAFINA-500ML',
  name: 'Aquafina Water 500ml',
  status: 'ACTIVE',
  unitOfMeasure: 'EACH',
  lowStockThreshold: null,
  barcodes: [{ value: '0123456789012' }],
} as Product;

const COLA = {
  id: 'p2',
  sku: 'SKU-COLA-RED',
  name: 'Cola Red Can',
  status: 'ACTIVE',
  unitOfMeasure: 'EACH',
  lowStockThreshold: null,
  barcodes: [],
} as Product;

describe('productSearchPaths (server-side name/SKU + exact barcode)', () => {
  it('returns the unfiltered list path for a blank query', () => {
    expect(productSearchPaths('')).toEqual(['/catalog/products?take=100']);
    expect(productSearchPaths('   ')).toEqual(['/catalog/products?take=100']);
  });

  it('queries both search and exact barcode for a short query', () => {
    expect(productSearchPaths('aquafina')).toEqual([
      '/catalog/products?take=100&search=aquafina',
      '/catalog/products?take=100&barcode=aquafina',
    ]);
  });

  it('trims and URL-encodes the query', () => {
    expect(productSearchPaths(' red can ')).toEqual([
      '/catalog/products?take=100&search=red%20can',
      '/catalog/products?take=100&barcode=red%20can',
    ]);
  });

  it('skips the barcode path when the query exceeds the DTO max (64)', () => {
    const long = 'x'.repeat(65);
    expect(productSearchPaths(long)).toEqual([
      `/catalog/products?take=100&search=${long}`,
    ]);
  });

  it('caps the search param at the DTO max (200)', () => {
    const paths = productSearchPaths('y'.repeat(250));
    expect(paths).toEqual([
      `/catalog/products?take=100&search=${'y'.repeat(200)}`,
    ]);
  });

  it('honours a custom page size', () => {
    expect(productSearchPaths('', 25)).toEqual(['/catalog/products?take=25']);
  });
});

describe('mergeProducts', () => {
  it('concatenates pages preserving order', () => {
    expect(mergeProducts([page([AQUAFINA]), page([COLA])])).toEqual([
      AQUAFINA,
      COLA,
    ]);
  });

  it('de-duplicates by product id across the search/barcode responses', () => {
    const merged = mergeProducts([page([AQUAFINA, COLA]), page([AQUAFINA])]);
    expect(merged).toHaveLength(2);
    expect(merged.map((product) => product.id)).toEqual(['p1', 'p2']);
  });

  it('returns an empty list for empty pages', () => {
    expect(mergeProducts([page([])])).toEqual([]);
  });
});
