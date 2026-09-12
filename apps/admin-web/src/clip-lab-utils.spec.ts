import { describe, expect, it } from 'vitest';
import { frameCoverageLabel, marginLabel, parseRegion, percentLabel } from './clip-lab-utils';

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

describe('parseRegion', () => {
  it('accepts all-blank as no region and a valid rectangle', () => {
    expect(parseRegion({ rx: '', ry: '', rw: '', rh: '' })).toEqual({ region: null, error: null });
    expect(parseRegion({ rx: '0', ry: '0.15', rw: '1', rh: '0.57' })).toEqual({
      region: { x: 0, y: 0.15, width: 1, height: 0.57 },
      error: null,
    });
  });

  it('rejects partial, out-of-range and overflowing rectangles', () => {
    expect(parseRegion({ rx: '0', ry: '', rw: '1', rh: '1' }).error).toMatch(/all four/);
    expect(parseRegion({ rx: '2', ry: '0', rw: '1', rh: '1' }).error).toMatch(/between 0 and 1/);
    expect(parseRegion({ rx: '0.5', ry: '0', rw: '0.9', rh: '1' }).error).toMatch(/inside the frame/);
  });
});
