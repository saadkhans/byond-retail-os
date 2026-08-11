import { describe, expect, it } from 'vitest';
import { Product } from './api';
import { filterProducts } from './pages/ReferenceLibraryPage';

const PRODUCTS: Product[] = [
  {
    id: 'p1',
    sku: 'AQUAFINA-500ML',
    name: 'Aquafina Water 500ml',
    status: 'ACTIVE',
    unitOfMeasure: 'EACH',
    lowStockThreshold: null,
    barcodes: [{ value: '0123456789012' }],
  },
  {
    id: 'p2',
    sku: 'SKU-COLA-RED',
    name: 'Cola Red Can',
    status: 'ACTIVE',
    unitOfMeasure: 'EACH',
    lowStockThreshold: null,
    barcodes: [],
  },
] as Product[];

describe('filterProducts (name / SKU / barcode search)', () => {
  it('matches by name fragment, case-insensitive', () => {
    expect(filterProducts(PRODUCTS, 'aquafina')).toHaveLength(1);
    expect(filterProducts(PRODUCTS, 'WATER')[0].id).toBe('p1');
  });

  it('matches by SKU fragment', () => {
    expect(filterProducts(PRODUCTS, 'cola-red')[0].id).toBe('p2');
  });

  it('matches by barcode', () => {
    expect(filterProducts(PRODUCTS, '0123456789012')[0].id).toBe('p1');
  });

  it('returns everything for a blank query and nothing for a miss', () => {
    expect(filterProducts(PRODUCTS, '  ')).toHaveLength(2);
    expect(filterProducts(PRODUCTS, 'zzz-nope')).toHaveLength(0);
  });
});
