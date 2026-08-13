import {
  AnalysisFrame,
  AnalysisGeometry,
  analyzePickup,
} from './pickup-analyzer';
import {
  ReferenceImage,
  RgbImage,
  cropRgb,
  matchProduct,
} from './product-matcher';

/**
 * The eight validation scenarios required before production sign-off,
 * pinned against the CURRENT classical algorithm. These tests document
 * honest behavior — including the known limitations — and MUST NOT drive
 * algorithm changes on their own: the acceptance gate is real BYOND
 * footage scored on the validation dashboard, not synthetic scenes
 * (see the phase requirement "do not modify the algorithm yet based on
 * synthetic tests alone").
 *
 * Verdict legend per scenario:
 *  - WORKS: current algorithm handles it within scope
 *  - HONEST-REFUSAL: refuses to claim rather than guessing
 *  - DOCUMENTED-LIMITATION: known failure shape, pinned so any future
 *    change is visible in review
 */

const GEOMETRY: AnalysisGeometry = { width: 48, height: 36 };
const BOX_A = { x: 6, y: 10, width: 10, height: 12 };
const BOX_B = { x: 30, y: 10, width: 10, height: 12 };
const THRESHOLD = 0.62;

type Rgb = [number, number, number];
const BLUE: Rgb = [40, 80, 210];
const GREEN: Rgb = [40, 180, 70];

function blank(gray: number): Buffer {
  return Buffer.alloc(GEOMETRY.width * GEOMETRY.height * 3, gray);
}

/** Vertical/horizontal striped tile — orientation is the spatial signal. */
function paintStripes(
  frame: Buffer,
  frameWidth: number,
  box: { x: number; y: number; width: number; height: number },
  color: Rgb,
  orientation: 'v' | 'h',
  period = 4,
): void {
  const dark: Rgb = [
    Math.floor(color[0] * 0.4),
    Math.floor(color[1] * 0.4),
    Math.floor(color[2] * 0.4),
  ];
  for (let y = 0; y < box.height; y += 1) {
    for (let x = 0; x < box.width; x += 1) {
      const on =
        orientation === 'v'
          ? Math.floor(x / (period / 2)) % 2 === 0
          : Math.floor(y / (period / 2)) % 2 === 0;
      const rgb = on ? color : dark;
      const offset = ((box.y + y) * frameWidth + (box.x + x)) * 3;
      frame[offset] = rgb[0];
      frame[offset + 1] = rgb[1];
      frame[offset + 2] = rgb[2];
    }
  }
}

function paintHand(frame: Buffer, x: number, y: number, w = 8, h = 14): void {
  for (let yy = y; yy < Math.min(GEOMETRY.height, y + h); yy += 1) {
    for (let xx = x; xx < Math.min(GEOMETRY.width, x + w); xx += 1) {
      const offset = (yy * GEOMETRY.width + xx) * 3;
      frame[offset] = 224;
      frame[offset + 1] = 172;
      frame[offset + 2] = 138;
    }
  }
}

function toFrames(buffers: Buffer[]): AnalysisFrame[] {
  return buffers.map((rgb, index) => ({ index, timestampMs: index * 400, rgb }));
}

function stripeTile(color: Rgb, orientation: 'v' | 'h', edge = 48): RgbImage {
  const image = Buffer.alloc(edge * edge * 3);
  paintStripes(
    image,
    edge,
    { x: 0, y: 0, width: edge, height: edge },
    color,
    orientation,
    8,
  );
  return { width: edge, height: edge, rgb: image };
}

/** Standard single-pickup clip builder with hooks for the scenarios. */
function pickupClip(options: {
  productColor?: Rgb;
  orientation?: 'v' | 'h';
  brightnessAfter?: number;
  removeBoth?: boolean;
  putBack?: boolean;
  cameraShiftAfter?: number;
  occludeDuringGrab?: boolean;
} = {}): AnalysisFrame[] {
  const color = options.productColor ?? BLUE;
  const orientation = options.orientation ?? 'v';
  const buffers: Buffer[] = [];
  const drawScene = (opts: {
    productA: boolean;
    productB: boolean;
    handX: number | null;
    brightness?: number;
    shift?: number;
  }) => {
    const brightness = opts.brightness ?? 120;
    const shift = opts.shift ?? 0;
    const frame = blank(brightness);
    if (opts.productA) {
      paintStripes(
        frame,
        GEOMETRY.width,
        { ...BOX_A, x: BOX_A.x + shift },
        color,
        orientation,
      );
    }
    if (opts.productB) {
      paintStripes(
        frame,
        GEOMETRY.width,
        { ...BOX_B, x: BOX_B.x + shift },
        GREEN,
        'h',
      );
    }
    if (opts.handX !== null) {
      paintHand(frame, opts.handX + shift, 8);
    }
    return frame;
  };
  // 0-5 quiet, both products present.
  for (let i = 0; i < 6; i += 1) {
    buffers.push(drawScene({ productA: true, productB: true, handX: null }));
  }
  // 6-9 hand sweeps to product A and grabs it.
  buffers.push(drawScene({ productA: true, productB: true, handX: 38 }));
  buffers.push(
    drawScene({
      productA: !options.occludeDuringGrab,
      productB: true,
      handX: 20,
    }),
  );
  buffers.push(
    drawScene({
      productA: false,
      productB: !options.removeBoth ? true : false,
      handX: 8,
    }),
  );
  buffers.push(
    drawScene({
      productA: false,
      productB: !options.removeBoth,
      handX: 30,
    }),
  );
  // 10-15 quiet aftermath.
  for (let i = 0; i < 6; i += 1) {
    buffers.push(
      drawScene({
        productA: options.putBack ?? false,
        productB: !options.removeBoth,
        handX: null,
        brightness: options.brightnessAfter,
        shift:
          options.cameraShiftAfter !== undefined
            ? options.cameraShiftAfter
            : 0,
      }),
    );
  }
  return toFrames(buffers);
}

const REFERENCES: ReferenceImage[] = [
  { productId: 'p-blue-v', sku: 'SKU-BLUE-V', image: stripeTile(BLUE, 'v') },
  { productId: 'p-green-h', sku: 'SKU-GREEN-H', image: stripeTile(GREEN, 'h') },
];

function matchRemovedRegion(frames: AnalysisFrame[]) {
  const analysis = analyzePickup(frames, GEOMETRY);
  expect(analysis.pickupDetected).toBe(true);
  const crop = cropRgb(
    { width: GEOMETRY.width, height: GEOMETRY.height, rgb: frames[0].rgb },
    analysis.removalBox!,
  );
  return { analysis, candidates: matchProduct(crop, REFERENCES) };
}

describe('validation scenarios (current-behavior pins — no tuning from these)', () => {
  it('visually similar SKUs: same color, different stripe orientation — WORKS via structure', () => {
    // Two SKUs share the SAME blue palette; only NCC separates them.
    const similar: ReferenceImage[] = [
      { productId: 'p-blue-v', sku: 'SKU-BLUE-V', image: stripeTile(BLUE, 'v') },
      { productId: 'p-blue-h', sku: 'SKU-BLUE-H', image: stripeTile(BLUE, 'h') },
    ];
    const frames = pickupClip({ orientation: 'v' });
    const analysis = analyzePickup(frames, GEOMETRY);
    const crop = cropRgb(
      { width: GEOMETRY.width, height: GEOMETRY.height, rgb: frames[0].rgb },
      analysis.removalBox!,
    );
    const candidates = matchProduct(crop, similar);
    expect(candidates[0].sku).toBe('SKU-BLUE-V');
    expect(candidates[0].score).toBeGreaterThan(candidates[1].score);
  });

  it('different lighting: mild global brightness shift after the pickup — WORKS', () => {
    // +18 gray levels stays under the 40-level removal threshold, so the
    // removal region remains product-only and the match still lands.
    const { analysis, candidates } = matchRemovedRegion(
      pickupClip({ brightnessAfter: 138 }),
    );
    expect(analysis.removalBox!.width).toBeLessThan(GEOMETRY.width / 2);
    expect(candidates[0].sku).toBe('SKU-BLUE-V');
    expect(candidates[0].score).toBeGreaterThanOrEqual(THRESHOLD);
  });

  it('partial hand occlusion during the grab — WORKS (backgrounds come from clip endpoints)', () => {
    const { candidates } = matchRemovedRegion(
      pickupClip({ occludeDuringGrab: true }),
    );
    expect(candidates[0].sku).toBe('SKU-BLUE-V');
    expect(candidates[0].score).toBeGreaterThanOrEqual(THRESHOLD);
  });

  it('product rotation: 90°-rotated appearance — DOCUMENTED-LIMITATION (color keeps it above threshold)', () => {
    // The clip shows the blue product HORIZONTALLY striped; the reference
    // library knows it vertically striped. Structure disagrees (NCC lands
    // at its uncorrelated midpoint, 0.5) but COLOR fully agrees, so the
    // combined score sits near 0.75 — ABOVE the 0.62 threshold. The
    // current matcher would claim a same-color product in an unseen pose.
    // Pinned, not fixed: whether this matters in practice (and what the
    // threshold should be) is exactly what the real-footage validation
    // phase measures — the "Match score" rename exists because this
    // number is not a calibrated probability. Mitigation available
    // without algorithm changes: upload rotated reference images.
    const frames = pickupClip({ orientation: 'h' });
    const analysis = analyzePickup(frames, GEOMETRY);
    const crop = cropRgb(
      { width: GEOMETRY.width, height: GEOMETRY.height, rgb: frames[0].rgb },
      analysis.removalBox!,
    );
    const rotationOnly: ReferenceImage[] = [
      { productId: 'p-blue-v', sku: 'SKU-BLUE-V', image: stripeTile(BLUE, 'v') },
    ];
    const candidates = matchProduct(crop, rotationOnly);
    expect(candidates[0].score).toBeGreaterThanOrEqual(THRESHOLD);
    expect(candidates[0].score).toBeLessThan(0.8);
    // (NCC is also stripe-frequency sensitive, so even a rotated
    // reference at a different scale may not raise the score — reference
    // photos should match the camera's viewing scale. Another property
    // for the real-footage phase to quantify, not to patch here.)
  });

  it('no pickup: a fully static clip — WORKS (NO_MOTION_EVENT, nothing invented)', () => {
    const still = toFrames(
      Array.from({ length: 16 }, () => {
        const frame = blank(120);
        paintStripes(frame, GEOMETRY.width, BOX_A, BLUE, 'v');
        paintStripes(frame, GEOMETRY.width, BOX_B, GREEN, 'h');
        return frame;
      }),
    );
    const analysis = analyzePickup(still, GEOMETRY);
    expect(analysis.pickupDetected).toBe(false);
    expect(analysis.rejectReason).toBe('NO_MOTION_EVENT');
  });

  it('pickup AND return in one clip — HONEST-REFUSAL (no net removal, no event)', () => {
    // The product is back on the shelf at the end: the endpoint
    // backgrounds agree, so there is NO removal region. The MVP refuses
    // rather than reporting either half of the round trip — splitting the
    // two sub-events needs the post-MVP tracking phase.
    const analysis = analyzePickup(pickupClip({ putBack: true }), GEOMETRY);
    expect(analysis.pickupDetected).toBe(false);
    expect(analysis.rejectReason).toBe('NO_REMOVAL_REGION');
  });

  it('two-product pickup — DOCUMENTED-LIMITATION (one event, box spans both products)', () => {
    // Both products leave the shelf: the single-event MVP reports ONE
    // window whose removal box covers BOTH tiles. Pinned so a future
    // multi-event upgrade shows up as a deliberate change here.
    const analysis = analyzePickup(pickupClip({ removeBoth: true }), GEOMETRY);
    expect(analysis.pickupDetected).toBe(true);
    const box = analysis.removalBox!;
    expect(box.x).toBeLessThanOrEqual(BOX_A.x);
    expect(box.x + box.width).toBeGreaterThanOrEqual(BOX_B.x + BOX_B.width);
  });

  it('camera movement — DOCUMENTED-LIMITATION (global change reads as a huge removal region)', () => {
    // A 3-px camera shift after the event makes the endpoint backgrounds
    // disagree along every edge: the "removal" box balloons far past any
    // single product. The fixed-camera assumption is REAL — this pin
    // records the failure shape production hardware must avoid (mounted
    // cameras), and the wide box dilutes the crop so no confident claim
    // survives it.
    const analysis = analyzePickup(
      pickupClip({ cameraShiftAfter: 3 }),
      GEOMETRY,
    );
    expect(analysis.pickupDetected).toBe(true);
    expect(analysis.removalBox!.width).toBeGreaterThan(GEOMETRY.width / 2);
    const crop = cropRgb(
      {
        width: GEOMETRY.width,
        height: GEOMETRY.height,
        rgb: pickupClip({ cameraShiftAfter: 3 })[0].rgb,
      },
      analysis.removalBox!,
    );
    const candidates = matchProduct(crop, REFERENCES);
    expect(candidates[0].score).toBeLessThan(THRESHOLD);
  });
});
