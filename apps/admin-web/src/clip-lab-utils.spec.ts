import { describe, expect, it } from 'vitest';
import { frameCoverageLabel, marginLabel, percentLabel } from './clip-lab-utils';

describe('Clip Lab confidence formatting', () => {
  it('renders 0..1 signals as whole percentages and clamps', () => {
    expect(percentLabel(0.61)).toBe('61%');
    expect(percentLabel(0.2385)).toBe('24%');
    expect(percentLabel(1)).toBe('100%');
    expect(percentLabel(0)).toBe('0%');
    expect(percentLabel(1.7)).toBe('100%');
    expect(percentLabel(-0.2)).toBe('0%');
  });

  it('shows a dash for missing or invalid values', () => {
    expect(percentLabel(null)).toBe('—');
    expect(percentLabel(undefined)).toBe('—');
    expect(percentLabel(Number.NaN)).toBe('—');
  });

  it('formats the top-two margin in signed percentage points', () => {
    expect(marginLabel(0.021)).toBe('+2 pts');
    expect(marginLabel(0)).toBe('+0 pts');
    expect(marginLabel(-0.05)).toBe('-5 pts');
    expect(marginLabel(null)).toBe('—');
  });

  it('describes detector frame coverage', () => {
    expect(frameCoverageLabel(9, 15)).toBe('product in 9 of 15 sampled frames');
    expect(frameCoverageLabel(null, 15)).toBe('—');
  });
});
