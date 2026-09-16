import {
  computeBasketTotals,
  isEffectiveAt,
  lineTotalMinor,
  normalizeCurrencyCode,
  normalizePriceBookCode,
  PriceCandidate,
  selectPrice,
} from './pricing.logic';

const AT = new Date('2026-09-16T12:00:00Z');

function candidate(overrides: Partial<PriceCandidate> = {}): PriceCandidate {
  return {
    priceBookId: 'book-tenant',
    priceBookCode: 'RETAIL',
    priceBookLocationId: null,
    priceBookVersionId: 'version-1',
    versionNumber: 1,
    status: 'ACTIVE',
    effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    effectiveTo: null,
    unitPriceMinor: 1000,
    currencyCode: 'AED',
    ...overrides,
  };
}

describe('isEffectiveAt', () => {
  it('includes the instant a version starts', () => {
    expect(isEffectiveAt(candidate({ effectiveFrom: AT }), AT)).toBe(true);
  });

  it('excludes the instant a version ends, so windows never overlap', () => {
    // Half-open [from, to): the moment v2 starts is the moment v1 stops, so
    // exactly one version answers for any instant.
    expect(isEffectiveAt(candidate({ effectiveTo: AT }), AT)).toBe(false);
  });

  it('excludes a version scheduled for the future', () => {
    const scheduled = candidate({
      effectiveFrom: new Date('2026-12-01T00:00:00Z'),
    });
    expect(isEffectiveAt(scheduled, AT)).toBe(false);
  });

  it('includes an instant inside a closed window', () => {
    const closed = candidate({
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
      effectiveTo: new Date('2027-01-01T00:00:00Z'),
    });
    expect(isEffectiveAt(closed, AT)).toBe(true);
  });
});

describe('selectPrice', () => {
  it('returns null when nothing applies — never a zero price', () => {
    expect(selectPrice([], AT)).toBeNull();
  });

  it('resolves the tenant-wide book when there is nothing more specific', () => {
    expect(selectPrice([candidate()], AT, 'store-1')).toEqual({
      unitPriceMinor: 1000,
      currencyCode: 'AED',
      priceBookId: 'book-tenant',
      priceBookVersionId: 'version-1',
    });
  });

  it('prefers a location-scoped book over the tenant-wide one', () => {
    const local = candidate({
      priceBookId: 'book-store',
      priceBookCode: 'STORE-1',
      priceBookLocationId: 'store-1',
      priceBookVersionId: 'version-local',
      unitPriceMinor: 850,
    });
    const chosen = selectPrice([candidate(), local], AT, 'store-1');
    expect(chosen?.unitPriceMinor).toBe(850);
    expect(chosen?.priceBookId).toBe('book-store');
  });

  it('ignores a location-scoped book belonging to another store', () => {
    const elsewhere = candidate({
      priceBookId: 'book-store-2',
      priceBookLocationId: 'store-2',
      unitPriceMinor: 1,
    });
    const chosen = selectPrice([candidate(), elsewhere], AT, 'store-1');
    expect(chosen?.priceBookId).toBe('book-tenant');
  });

  it('ignores every location-scoped book when no location is given', () => {
    const local = candidate({
      priceBookId: 'book-store',
      priceBookLocationId: 'store-1',
      unitPriceMinor: 850,
    });
    expect(selectPrice([local], AT)).toBeNull();
  });

  it('answers historically: a superseded version still covers its window', () => {
    const old = candidate({
      priceBookVersionId: 'version-1',
      versionNumber: 1,
      status: 'SUPERSEDED',
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
      effectiveTo: new Date('2026-06-01T00:00:00Z'),
      unitPriceMinor: 900,
    });
    const current = candidate({
      priceBookVersionId: 'version-2',
      versionNumber: 2,
      effectiveFrom: new Date('2026-06-01T00:00:00Z'),
      unitPriceMinor: 1100,
    });
    const then = selectPrice(
      [old, current],
      new Date('2026-03-01T00:00:00Z'),
    );
    expect(then?.unitPriceMinor).toBe(900);
    const now = selectPrice([old, current], AT);
    expect(now?.unitPriceMinor).toBe(1100);
  });

  it('breaks ties deterministically so a retry prices identically', () => {
    const a = candidate({
      priceBookId: 'book-a',
      priceBookCode: 'AAA',
      priceBookVersionId: 'v-a',
      unitPriceMinor: 100,
    });
    const b = candidate({
      priceBookId: 'book-b',
      priceBookCode: 'BBB',
      priceBookVersionId: 'v-b',
      unitPriceMinor: 200,
    });
    expect(selectPrice([a, b], AT)).toEqual(selectPrice([b, a], AT));
  });
});

describe('lineTotalMinor', () => {
  it('multiplies in integer minor units — no floating point in the money path', () => {
    expect(lineTotalMinor(1099, 3)).toBe(3297);
  });
});

describe('computeBasketTotals', () => {
  const priced = (unit: number, quantity: number) => ({
    unitPriceMinor: unit,
    lineTotalMinor: unit * quantity,
    currencyCode: 'AED',
  });

  it('sums a fully priced basket', () => {
    expect(computeBasketTotals([priced(1000, 2), priced(250, 1)])).toEqual({
      subtotalMinor: 2250,
      totalMinor: 2250,
      currencyCode: 'AED',
    });
  });

  it('refuses to total a basket with any unpriced line', () => {
    // All-or-nothing: a partial total would understate the order silently.
    expect(
      computeBasketTotals([
        priced(1000, 1),
        { unitPriceMinor: null, lineTotalMinor: null, currencyCode: null },
      ]),
    ).toBeNull();
  });

  it('refuses to total a mixed-currency basket', () => {
    expect(
      computeBasketTotals([
        priced(1000, 1),
        { unitPriceMinor: 500, lineTotalMinor: 500, currencyCode: 'SAR' },
      ]),
    ).toBeNull();
  });

  it('returns null for an empty basket', () => {
    expect(computeBasketTotals([])).toBeNull();
  });

  it('keeps total and subtotal distinct so tax can land later without a reshape', () => {
    const totals = computeBasketTotals([priced(1000, 1)]);
    expect(totals?.totalMinor).toBe(totals?.subtotalMinor);
  });
});

describe('normalization', () => {
  it('uppercases price book codes like SKUs', () => {
    expect(normalizePriceBookCode(' retail-01 ')).toBe('RETAIL-01');
  });

  it('uppercases currency codes', () => {
    expect(normalizeCurrencyCode('aed')).toBe('AED');
  });
});
