import {
  AnalysisFrame,
  AnalysisGeometry,
  analyzePickup,
  changedRegionBox,
  meanAbsoluteDifference,
  medianBackground,
} from './pickup-analyzer';

/**
 * Deterministic synthetic scene: a fixed camera looks at a gray shelf; a
 * red product sits at a known box; a bright "hand" blob sweeps through
 * mid-clip; afterwards the product is GONE. The analyzer must find the
 * motion window and the removal region from pixels alone.
 */
const GEOMETRY: AnalysisGeometry = { width: 40, height: 30 };
const PRODUCT = { x: 10, y: 8, width: 10, height: 10 };

function solidFrame(gray: number): Buffer {
  return Buffer.alloc(GEOMETRY.width * GEOMETRY.height * 3, gray);
}

function paintRect(
  frame: Buffer,
  rect: { x: number; y: number; width: number; height: number },
  rgb: [number, number, number],
): void {
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      const offset = (y * GEOMETRY.width + x) * 3;
      frame[offset] = rgb[0];
      frame[offset + 1] = rgb[1];
      frame[offset + 2] = rgb[2];
    }
  }
}

function sceneFrame(options: {
  productPresent: boolean;
  handX: number | null;
}): Buffer {
  const frame = solidFrame(120);
  if (options.productPresent) {
    paintRect(frame, PRODUCT, [200, 30, 30]);
  }
  if (options.handX !== null) {
    paintRect(
      frame,
      { x: options.handX, y: 6, width: 6, height: 14 },
      [250, 240, 230],
    );
  }
  return frame;
}

/** 16 samples at 500 ms cadence: quiet(0-5) → hand sweep(6-9) → quiet, product gone(10-15). */
function pickupClip(): AnalysisFrame[] {
  const frames: Buffer[] = [];
  for (let index = 0; index <= 5; index += 1) {
    frames.push(sceneFrame({ productPresent: true, handX: null }));
  }
  frames.push(sceneFrame({ productPresent: true, handX: 30 }));
  frames.push(sceneFrame({ productPresent: true, handX: 18 }));
  frames.push(sceneFrame({ productPresent: false, handX: 12 }));
  frames.push(sceneFrame({ productPresent: false, handX: 28 }));
  for (let index = 10; index <= 15; index += 1) {
    frames.push(sceneFrame({ productPresent: false, handX: null }));
  }
  return frames.map((rgb, index) => ({
    index,
    timestampMs: index * 500,
    rgb,
  }));
}

describe('pickup-analyzer primitives', () => {
  it('meanAbsoluteDifference is 0 for identical frames and scales with change', () => {
    const quiet = sceneFrame({ productPresent: true, handX: null });
    expect(meanAbsoluteDifference(quiet, quiet)).toBe(0);
    const busy = sceneFrame({ productPresent: true, handX: 12 });
    expect(meanAbsoluteDifference(quiet, busy)).toBeGreaterThan(0.5);
  });

  it('medianBackground suppresses a single outlier frame', () => {
    const quiet = sceneFrame({ productPresent: true, handX: null });
    const outlier = sceneFrame({ productPresent: true, handX: 12 });
    const background = medianBackground([quiet, outlier, quiet]);
    expect(background.equals(quiet)).toBe(true);
  });

  it('changedRegionBox localizes the removed product and ignores noise floors', () => {
    const before = sceneFrame({ productPresent: true, handX: null });
    const after = sceneFrame({ productPresent: false, handX: null });
    const box = changedRegionBox(before, after, GEOMETRY, 40, 12);
    expect(box).toEqual({
      x: PRODUCT.x,
      y: PRODUCT.y,
      width: PRODUCT.width,
      height: PRODUCT.height,
    });
    expect(changedRegionBox(before, before, GEOMETRY, 40, 12)).toBeNull();
  });
});

describe('analyzePickup', () => {
  it('detects the staged pickup: window brackets the hand sweep, box is the product', () => {
    const result = analyzePickup(pickupClip(), GEOMETRY);
    expect(result.pickupDetected).toBe(true);
    expect(result.rejectReason).toBeNull();
    expect(result.removalBox).toEqual({
      x: PRODUCT.x,
      y: PRODUCT.y,
      width: PRODUCT.width,
      height: PRODUCT.height,
    });
    const window = result.window!;
    // The hand enters at sample 6 (3000 ms) and settles by sample 10 (5000 ms).
    expect(window.eventStartMs).toBeGreaterThanOrEqual(2500);
    expect(window.eventStartMs).toBeLessThanOrEqual(3500);
    expect(window.eventPeakMs).toBeGreaterThanOrEqual(window.eventStartMs);
    expect(window.eventEndMs).toBeGreaterThanOrEqual(window.eventPeakMs);
    expect(window.eventEndMs).toBeLessThanOrEqual(5500);
  });

  it('refuses a motionless clip (NO_MOTION_EVENT) instead of inventing an event', () => {
    const frames: AnalysisFrame[] = Array.from({ length: 16 }, (_, index) => ({
      index,
      timestampMs: index * 500,
      rgb: sceneFrame({ productPresent: true, handX: null }),
    }));
    const result = analyzePickup(frames, GEOMETRY);
    expect(result.pickupDetected).toBe(false);
    expect(result.rejectReason).toBe('NO_MOTION_EVENT');
  });

  it('refuses motion with no removal (hand sweeps, product stays)', () => {
    const frames: Buffer[] = [];
    for (let index = 0; index <= 5; index += 1) {
      frames.push(sceneFrame({ productPresent: true, handX: null }));
    }
    frames.push(sceneFrame({ productPresent: true, handX: 30 }));
    frames.push(sceneFrame({ productPresent: true, handX: 18 }));
    frames.push(sceneFrame({ productPresent: true, handX: 12 }));
    frames.push(sceneFrame({ productPresent: true, handX: 28 }));
    for (let index = 10; index <= 15; index += 1) {
      frames.push(sceneFrame({ productPresent: true, handX: null }));
    }
    const result = analyzePickup(
      frames.map((rgb, index) => ({ index, timestampMs: index * 500, rgb })),
      GEOMETRY,
    );
    expect(result.pickupDetected).toBe(false);
    expect(result.rejectReason).toBe('NO_REMOVAL_REGION');
  });

  it('refuses clips with too few samples', () => {
    const result = analyzePickup(
      pickupClip().slice(0, 4),
      GEOMETRY,
    );
    expect(result.pickupDetected).toBe(false);
    expect(result.rejectReason).toBe('TOO_FEW_FRAMES');
  });
});
