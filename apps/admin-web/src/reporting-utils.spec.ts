import { describe, expect, it } from 'vitest';
import {
  asOfLabel,
  damagedReturnsNote,
  driftLabel,
  driftTone,
  money,
  percent,
  reconciliationLabel,
  reconciliationTone,
  signed,
} from './reporting-utils';

describe('money', () => {
  it('formats minor units without ever inventing a value for NULL', () => {
    expect(money(1299, 'GBP')).toBe('12.99 GBP');
    expect(money(0, 'GBP')).toBe('0.00 GBP');
    // NULL means UNPRICED, never free.
    expect(money(null, 'GBP')).toBe('—');
  });
});

describe('percent', () => {
  it('shows a rate the API computed', () => {
    expect(percent(0.727)).toBe('72.7%');
    expect(percent(1)).toBe('100.0%');
  });

  it('never turns "not enough data" into 0%', () => {
    // The API returns null when a denominator is zero. Rendering that as 0%
    // would claim the model got everything wrong.
    expect(percent(null)).toBe('not enough data');
  });
});

describe('signed', () => {
  it('shows the direction of a ledger delta', () => {
    expect(signed(5)).toBe('+5');
    expect(signed(-5)).toBe('-5');
    expect(signed(0)).toBe('0');
  });
});

describe('as-of labelling', () => {
  const generatedAt = '2026-09-16T12:00:00.000Z';

  it('says a derived figure is live and uncached', () => {
    const label = asOfLabel({
      generatedAt,
      derivation: 'DERIVED_ON_READ',
      stale: false,
      sourceOfTruth: ['InventoryMovement'],
    });
    expect(label).toContain('Derived on read');
    expect(label).toContain('InventoryMovement');
    expect(label).toContain('Nothing here is cached');
  });

  it('would say plainly that a cached figure is NOT live', () => {
    // Today nothing sets stale: true. If a materialised figure is ever
    // introduced, this is the wording the page falls back to — a stale number
    // is never presented as live.
    const label = asOfLabel({
      generatedAt,
      derivation: 'MATERIALISED',
      stale: true,
      sourceOfTruth: ['SomeRollup'],
    });
    expect(label).toContain('Cached figure');
    expect(label).toContain('NOT live');
  });
});

describe('reconciliation badges', () => {
  it('says so, loudly, when two computations of the same figure disagree', () => {
    expect(reconciliationTone(true)).toBe('ok');
    expect(reconciliationLabel(true)).toBe('Reconciles');
    expect(reconciliationTone(false)).toBe('down');
    expect(reconciliationLabel(false)).toBe('Does not reconcile');
  });
});

describe('drift is a platform defect, not a variance', () => {
  it('names a drifting projection as a platform defect in words', () => {
    expect(driftTone(false)).toBe('down');
    expect(driftLabel(false)).toContain('PLATFORM DEFECT');
    expect(driftLabel(false)).toContain('its own ledger history');
  });

  it('never calls drift a variance', () => {
    expect(driftLabel(false).toLowerCase()).not.toContain('variance');
    expect(driftLabel(true).toLowerCase()).not.toContain('variance');
  });
});

describe('damaged returns are not shrink', () => {
  it('says explicitly that a damaged return writes no ledger movement', () => {
    const note = damagedReturnsNote(4);
    expect(note).toContain('4 unit(s)');
    expect(note).toContain('no ledger movement');
    expect(note).toContain('NOT counted as shrink');
  });

  it('says nothing alarming when there are none', () => {
    expect(damagedReturnsNote(0)).toBe('No damaged returns in this window.');
  });
});
