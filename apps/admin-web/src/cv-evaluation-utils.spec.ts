import { describe, expect, it } from 'vitest';
import {
  decisionTone,
  formatRate,
  passBadge,
  testTypeLabel,
} from './cv-evaluation-utils';

describe('formatRate', () => {
  it('renders percent with numerator/denominator', () => {
    expect(formatRate({ numerator: 5, denominator: 6, rate: 5 / 6 })).toBe(
      '83% · 5/6',
    );
  });

  it('renders a dash when the denominator is empty', () => {
    expect(formatRate({ numerator: 0, denominator: 0, rate: null })).toBe('—');
  });

  it('renders 0% honestly (not a dash)', () => {
    expect(formatRate({ numerator: 0, denominator: 4, rate: 0 })).toBe(
      '0% · 0/4',
    );
  });
});

describe('passBadge', () => {
  it('maps pass to an ok badge', () => {
    expect(passBadge(true)).toEqual({ label: 'PASS', tone: 'ok' });
  });
  it('maps fail to a down badge', () => {
    expect(passBadge(false)).toEqual({ label: 'FAIL', tone: 'down' });
  });
  it('maps unlabeled (null) to a warn badge', () => {
    expect(passBadge(null)).toEqual({ label: 'UNLABELED', tone: 'warn' });
  });
});

describe('testTypeLabel', () => {
  it('humanizes known scenarios', () => {
    expect(testTypeLabel('TWO_SIMILAR_PICK_ONE')).toBe(
      'Two similar, remove one',
    );
  });
  it('maps null and UNLABELED to Unlabeled', () => {
    expect(testTypeLabel(null)).toBe('Unlabeled');
    expect(testTypeLabel('UNLABELED')).toBe('Unlabeled');
  });
  it('falls back to the raw code for unknown values', () => {
    expect(testTypeLabel('SOMETHING_NEW')).toBe('SOMETHING_NEW');
  });
});

describe('decisionTone', () => {
  it('READY_TO_SETTLE_SHADOW is ok', () => {
    expect(decisionTone('READY_TO_SETTLE_SHADOW')).toBe('ok');
  });
  it('review decisions are warn', () => {
    expect(decisionTone('NEEDS_EVENT_REVIEW')).toBe('warn');
    expect(decisionTone('NEEDS_JOURNEY_REVIEW')).toBe('warn');
  });
  it('FAILED is down', () => {
    expect(decisionTone('FAILED')).toBe('down');
  });
});
