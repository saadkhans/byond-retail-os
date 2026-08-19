import { describe, expect, it } from 'vitest';
import {
  evaluationStatusTone,
  formatAccuracy,
  verdictTone,
} from './pilot-evaluation-utils';

describe('pilot-evaluation-utils', () => {
  it('formats accuracies as percentages and NULL as unknown — never 0%', () => {
    expect(formatAccuracy(1)).toBe('100%');
    expect(formatAccuracy(0.5)).toBe('50%');
    expect(formatAccuracy(0.123)).toBe('12.3%');
    expect(formatAccuracy(0)).toBe('0%');
    // A null rate means the denominator was zero — unknown, not zero.
    expect(formatAccuracy(null)).toBe('—');
  });

  it('status tones: OPEN ok · COMPLETED neutral · CANCELLED down', () => {
    expect(evaluationStatusTone('OPEN')).toBe('ok');
    expect(evaluationStatusTone('COMPLETED')).toBe('');
    expect(evaluationStatusTone('CANCELLED')).toBe('down');
  });

  it('verdict tones: CORRECT ok · UNCERTAIN warn · everything else down', () => {
    expect(verdictTone('CORRECT')).toBe('ok');
    expect(verdictTone('UNCERTAIN')).toBe('warn');
    for (const verdict of [
      'INCORRECT',
      'FALSE_TOUCH',
      'WRONG_SKU',
      'WRONG_ACTION',
      'MISSED_EVENT',
    ]) {
      expect(verdictTone(verdict)).toBe('down');
    }
  });
});
