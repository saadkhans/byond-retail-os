import { rankRegionsForFallback } from './event-detection';
import {
  AnalysisFrame,
  AnalysisGeometry,
  findMotionWindow,
  meanAbsoluteDifference,
} from '../../pickup-detection/analysis/pickup-analyzer';
import {
  cellBox,
  cellCenterNormalized,
  localizedMotionTimeline,
} from './localized-motion';

const GEOMETRY: AnalysisGeometry = { width: 96, height: 72 };
const OPTIONS = {
  activationFraction: 0.12,
  removalPixelThreshold: 40,
  backgroundFrames: 3,
  minRemovalPixels: 12,
  minPeakToBaselineRatio: 3,
};

/** Deterministic LCG so the noise field is reproducible across runs. */
function noiseSource(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function noisyFrame(gray: number, amplitude: number, rand: () => number): Buffer {
  const frame = Buffer.alloc(GEOMETRY.width * GEOMETRY.height * 3);
  for (let index = 0; index < frame.length; index += 1) {
    frame[index] = Math.max(
      0,
      Math.min(255, Math.round(gray + (rand() * 2 - 1) * amplitude)),
    );
  }
  return frame;
}

function paint(
  frame: Buffer,
  box: { x: number; y: number; width: number; height: number },
  value: number,
): void {
  for (let y = box.y; y < box.y + box.height; y += 1) {
    for (let x = box.x; x < box.x + box.width; x += 1) {
      if (x < 0 || y < 0 || x >= GEOMETRY.width || y >= GEOMETRY.height) continue;
      const off = (y * GEOMETRY.width + x) * 3;
      frame[off] = value;
      frame[off + 1] = value;
      frame[off + 2] = value;
    }
  }
}

function toFrames(buffers: Buffer[]): AnalysisFrame[] {
  return buffers.map((rgb, index) => ({ index, timestampMs: index * 200, rgb }));
}

/** Frame-wide sensor noise (amplitude ~8 like a handheld phone) plus one
 *  12×12 blob crossing the lower-left cells on frames 5..9. */
function noisyClipWithBlob(withBlob: boolean): AnalysisFrame[] {
  const rand = noiseSource(7);
  const buffers: Buffer[] = [];
  for (let index = 0; index < 16; index += 1) {
    const frame = noisyFrame(120, 8, rand);
    if (withBlob && index >= 5 && index <= 9) {
      paint(frame, { x: 4 + (index - 5) * 6, y: 52, width: 12, height: 12 }, 250);
    }
    buffers.push(frame);
  }
  return toFrames(buffers);
}

/** A permanently flickering region (an ad screen) in the top-left cells
 *  and NO moving blob anywhere else. */
function flickeringScreenClip(): AnalysisFrame[] {
  const rand = noiseSource(11);
  const buffers: Buffer[] = [];
  for (let index = 0; index < 16; index += 1) {
    const frame = noisyFrame(120, 2, rand);
    paint(frame, { x: 0, y: 0, width: 36, height: 18 }, index % 2 === 0 ? 30 : 220);
    buffers.push(frame);
  }
  return toFrames(buffers);
}

describe('localizedMotionTimeline', () => {
  it('finds a small moving blob that frame-wide noise hides from the global timeline', () => {
    const frames = noisyClipWithBlob(true);
    const global: number[] = [];
    for (let index = 1; index < frames.length; index += 1) {
      global.push(meanAbsoluteDifference(frames[index - 1].rgb, frames[index].rgb));
    }
    expect(findMotionWindow(global, frames, OPTIONS)).toBeNull();

    const localized = localizedMotionTimeline(frames, GEOMETRY);
    expect(localized.timeline).toHaveLength(frames.length - 1);
    expect(localized.peakCells).toHaveLength(frames.length - 1);
    const window = findMotionWindow(localized.timeline, frames, OPTIONS);
    expect(window).not.toBeNull();
    expect(window!.peakIndex).toBeGreaterThanOrEqual(4);
    expect(window!.peakIndex).toBeLessThanOrEqual(9);
    // The peak cell contains the blob: rows 52..64 of 72 → row 5 (or 6)
    // of 8; columns 4..46 of 96 → cols 0..3 of 8.
    const cell = localized.peakCells[window!.peakIndex];
    expect(cell.row).toBeGreaterThanOrEqual(5);
    expect(cell.row).toBeLessThanOrEqual(7);
    expect(cell.col).toBeLessThanOrEqual(3);
  });

  it('is silent on a fully static clip', () => {
    const still = Buffer.alloc(GEOMETRY.width * GEOMETRY.height * 3, 90);
    const frames = toFrames(Array.from({ length: 12 }, () => Buffer.from(still)));
    const localized = localizedMotionTimeline(frames, GEOMETRY);
    expect(localized.timeline.every((value) => value === 0)).toBe(true);
    expect(findMotionWindow(localized.timeline, frames, OPTIONS)).toBeNull();
  });

  it('does not invent an event out of a permanently flickering region', () => {
    const frames = flickeringScreenClip();
    const localized = localizedMotionTimeline(frames, GEOMETRY);
    expect(findMotionWindow(localized.timeline, frames, OPTIONS)).toBeNull();
  });

  it('returns empty timelines for fewer than two frames or a degenerate geometry', () => {
    const frame = Buffer.alloc(GEOMETRY.width * GEOMETRY.height * 3, 90);
    expect(localizedMotionTimeline(toFrames([frame]), GEOMETRY)).toEqual({
      timeline: [],
      peakCells: [],
    });
    expect(
      localizedMotionTimeline(toFrames([frame, frame]), { width: 0, height: 0 }),
    ).toEqual({ timeline: [], peakCells: [] });
  });

  it('handles dimensions that do not divide by the grid', () => {
    const geometry: AnalysisGeometry = { width: 13, height: 11 };
    const a = Buffer.alloc(geometry.width * geometry.height * 3, 10);
    const b = Buffer.alloc(geometry.width * geometry.height * 3, 10);
    // Change only the bottom-right pixel.
    const last = (geometry.width * geometry.height - 1) * 3;
    b[last] = 200;
    b[last + 1] = 200;
    b[last + 2] = 200;
    // Enough quiet transitions that the single change is above the
    // cell's temporal median (otherwise baseline subtraction eats it).
    const frames = toFrames([a, a, a, a, b, a, a, a]);
    const localized = localizedMotionTimeline(frames, geometry, 4);
    expect(localized.timeline).toHaveLength(7);
    expect(localized.peakCells[3]).toEqual({ row: 3, col: 3 });
    expect(localized.timeline[3]).toBeGreaterThan(0);
    expect(localized.timeline[0]).toBe(0);
  });
});

describe('cell helpers', () => {
  it('maps a cell to its normalized center', () => {
    expect(cellCenterNormalized({ row: 0, col: 0 }, 8)).toEqual({ x: 0.0625, y: 0.0625 });
    expect(cellCenterNormalized({ row: 7, col: 7 }, 8)).toEqual({ x: 0.9375, y: 0.9375 });
  });

  it('expands a cell box by one cell on each side and clamps to the frame', () => {
    const corner = cellBox({ row: 0, col: 0 }, GEOMETRY, 8);
    expect(corner).toEqual({ x: 0, y: 0, width: 24, height: 18 });
    const middle = cellBox({ row: 4, col: 4 }, GEOMETRY, 8);
    expect(middle).toEqual({ x: 36, y: 27, width: 36, height: 27 });
    const far = cellBox({ row: 7, col: 7 }, GEOMETRY, 8);
    expect(far.x + far.width).toBe(GEOMETRY.width);
    expect(far.y + far.height).toBe(GEOMETRY.height);
  });
});

describe('rankRegionsForFallback (fallback-mode primary region)', () => {
  const hotspot = { x: 0, y: 464, width: 174, height: 232 }; // lower-left cell neighbourhood
  const lip = { x: 7, y: 402, width: 392, height: 51 }; // shelf lip strip, largest area
  const bottle = { x: 36, y: 532, width: 133, height: 78 }; // product-shaped, in the hotspot
  const sliver = { x: 0, y: 583, width: 39, height: 56 }; // product-shaped but tiny... still ok
  const farBox = { x: 300, y: 100, width: 60, height: 90 }; // product-shaped, far away

  it('puts the product-shaped region nearest the hand hotspot first, not the biggest strip', () => {
    const ranked = rankRegionsForFallback([lip, bottle, farBox], hotspot);
    expect(ranked[0]).toEqual(bottle);
    expect(ranked[ranked.length - 1]).toEqual(lip);
  });

  it('prefers a region inside the hotspot over a nearer-by-center one outside it', () => {
    const ranked = rankRegionsForFallback([farBox, sliver, bottle], hotspot);
    expect(ranked[0]).toEqual(bottle);
  });

  it('is a pure reordering: same members, input untouched', () => {
    const input = [lip, farBox, bottle];
    const ranked = rankRegionsForFallback(input, hotspot);
    expect(ranked).toHaveLength(3);
    expect(new Set(ranked)).toEqual(new Set(input));
    expect(input[0]).toEqual(lip);
  });
});
