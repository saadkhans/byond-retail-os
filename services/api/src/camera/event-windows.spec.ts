import { AnalysisFrame } from '../pickup-detection/analysis/pickup-analyzer';
import {
  DEFAULT_EVENT_WINDOW_CONFIG,
  extractEventWindows,
  motionSamples,
  motionScoreBetween,
  parseShelfZone,
} from './event-windows';

const CONFIG = { minScore: 10, minDurationMs: 400, cooldownMs: 1000 };

function sample(timestampMs: number, motionScore: number) {
  return { timestampMs, motionScore };
}

/** Solid-gray synthetic frame. */
function frame(index: number, timestampMs: number, gray: number): AnalysisFrame {
  const rgb = Buffer.alloc(6 * 6 * 3, gray);
  return { index, timestampMs, rgb };
}

describe('extractEventWindows (heuristic MVP — no ML tracking)', () => {
  it('returns nothing for empty input', () => {
    expect(extractEventWindows([], CONFIG)).toEqual([]);
  });

  it('groups contiguous above-threshold samples into one window', () => {
    const windows = extractEventWindows(
      [
        sample(0, 0),
        sample(500, 12),
        sample(1000, 30),
        sample(1500, 15),
        sample(2000, 2),
      ],
      CONFIG,
    );
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ startMs: 500, peakMs: 1000, endMs: 1500 });
  });

  it('discards a single-sample spike shorter than minDurationMs', () => {
    const windows = extractEventWindows(
      [sample(0, 0), sample(500, 99), sample(1000, 0)],
      CONFIG,
    );
    expect(windows).toEqual([]);
  });

  it('suppresses a second window starting inside the cooldown', () => {
    const windows = extractEventWindows(
      [
        sample(0, 20),
        sample(500, 20),
        sample(1000, 0), // window A ends at 500
        sample(1200, 20), // starts 700ms after A's end — inside 1000ms cooldown
        sample(1700, 20),
        sample(2200, 0),
      ],
      CONFIG,
    );
    expect(windows).toHaveLength(1);
    expect(windows[0].endMs).toBe(500);
  });

  it('admits a second window once the cooldown has elapsed', () => {
    const windows = extractEventWindows(
      [
        sample(0, 20),
        sample(500, 20),
        sample(1000, 0),
        sample(1600, 20), // 1100ms after A's end
        sample(2100, 20),
        sample(2600, 0),
      ],
      CONFIG,
    );
    expect(windows).toHaveLength(2);
  });

  it('confidence normalizes against the floor and saturates at 1', () => {
    const [low] = extractEventWindows(
      [sample(0, 10), sample(500, 10), sample(1000, 0)],
      CONFIG,
    );
    // Peak exactly at the floor → 10 / (10 * 4) = 0.25.
    expect(low.confidence).toBeCloseTo(0.25);
    const [saturated] = extractEventWindows(
      [sample(0, 500), sample(500, 500), sample(1000, 0)],
      CONFIG,
    );
    expect(saturated.confidence).toBe(1);
  });

  it('ships sane defaults (documented heuristics, not ML)', () => {
    expect(DEFAULT_EVENT_WINDOW_CONFIG.minDurationMs).toBeGreaterThan(0);
    expect(DEFAULT_EVENT_WINDOW_CONFIG.cooldownMs).toBeGreaterThan(0);
  });
});

describe('motion scoring', () => {
  const geometry = { width: 6, height: 6 };

  it('identical frames score zero; a uniform change scores its magnitude', () => {
    const a = frame(0, 0, 100);
    const b = frame(1, 500, 100);
    const c = frame(2, 1000, 130);
    expect(motionScoreBetween(a, b, geometry, null)).toBe(0);
    expect(motionScoreBetween(b, c, geometry, null)).toBeCloseTo(30);
  });

  it('zone restriction ignores motion outside the named grid cell', () => {
    const a = frame(0, 0, 0);
    const b = frame(1, 500, 0);
    // Paint ONLY the top-left 2×2 cell (zone-r1c1) white in frame b.
    for (let y = 0; y < 2; y += 1) {
      for (let x = 0; x < 2; x += 1) {
        const offset = (y * 6 + x) * 3;
        b.rgb[offset] = 255;
        b.rgb[offset + 1] = 255;
        b.rgb[offset + 2] = 255;
      }
    }
    const inZone = motionScoreBetween(a, b, geometry, { row: 1, col: 1 });
    const otherZone = motionScoreBetween(a, b, geometry, { row: 3, col: 3 });
    expect(inZone).toBeCloseTo(255);
    expect(otherZone).toBe(0);
  });

  it('motionSamples scores frame 0 as zero (no previous frame)', () => {
    const samples = motionSamples(
      [frame(0, 0, 0), frame(1, 500, 90)],
      geometry,
      null,
    );
    expect(samples[0].motionScore).toBe(0);
    expect(samples[1].motionScore).toBeCloseTo(90);
  });
});

describe('parseShelfZone', () => {
  it('parses the shelfZoneFor grid vocabulary', () => {
    expect(parseShelfZone('zone-r2c3')).toEqual({ row: 2, col: 3 });
  });

  it('rejects unknown formats and blanks (full-frame scoring)', () => {
    expect(parseShelfZone('zone-r4c1')).toBeNull();
    expect(parseShelfZone('freezer-left')).toBeNull();
    expect(parseShelfZone(null)).toBeNull();
    expect(parseShelfZone(undefined)).toBeNull();
  });
});
