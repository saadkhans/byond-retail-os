import type {
  DetectorDetection,
  DetectorFrameResult,
} from '../local-vision-runtime/local-vision-runtime.port';
import {
  boxesOverlap,
  deriveObjectPresenceChange,
  normalizeDetectorFrames,
  normalizeDetectorResult,
  selectFrameDetections,
} from './pretrained-vision.detector-normalization';

const QUALITY = { sharpness: 20, occlusion: 0.1, brightness: 120 };

function det(
  role: DetectorDetection['role'],
  confidence: number,
  box = { x: 0.4, y: 0.4, width: 0.2, height: 0.2 },
  classIndex = 0,
): DetectorDetection {
  return { role, classIndex, confidence, box };
}

function frame(timestampMs: number, detections: DetectorDetection[]): DetectorFrameResult {
  return { frameIndex: Math.round(timestampMs / 500), timestampMs, detections };
}

describe('boxesOverlap (product-in-hand)', () => {
  const product = { x: 0.4, y: 0.4, width: 0.2, height: 0.3 };

  it('overlapping boxes qualify', () => {
    expect(boxesOverlap(product, { x: 0.45, y: 0.5, width: 0.1, height: 0.1 })).toBe(true);
  });

  it('a small hand box whose center sits inside the product qualifies even at tiny IoU', () => {
    expect(boxesOverlap(product, { x: 0.49, y: 0.55, width: 0.02, height: 0.02 })).toBe(true);
  });

  it('disjoint boxes do not qualify', () => {
    expect(boxesOverlap(product, { x: 0.05, y: 0.05, width: 0.1, height: 0.1 })).toBe(false);
  });

  it('a sliver overlap below the IoU floor without a contained center does not qualify', () => {
    // Touches the product's right edge by 0.005 — IoU ≈ 0.002 and neither
    // center falls inside the other box.
    expect(boxesOverlap(product, { x: 0.595, y: 0.4, width: 0.3, height: 0.3 })).toBe(false);
  });
});

describe('selectFrameDetections (per-frame caps)', () => {
  it('keeps the top 2 products and top 1 hand by confidence and flags persons', () => {
    const selected = selectFrameDetections(
      frame(0, [
        det('PRODUCT', 0.3),
        det('PRODUCT', 0.9),
        det('PRODUCT', 0.6),
        det('HAND', 0.5),
        det('HAND', 0.8),
        det('PERSON', 0.95),
        det('OBJECT', 0.99),
      ]),
    );
    expect(selected.products.map((row) => row.confidence)).toEqual([0.9, 0.6]);
    expect(selected.hands.map((row) => row.confidence)).toEqual([0.8]);
    expect(selected.personSeen).toBe(true);
  });
});

describe('deriveObjectPresenceChange', () => {
  it('present early, absent late → disappeared', () => {
    expect(deriveObjectPresenceChange([true, true, true, false, false, false])).toEqual({
      objectDisappeared: true,
      objectAppeared: false,
    });
  });

  it('absent early, present late → appeared', () => {
    expect(deriveObjectPresenceChange([false, false, false, true, true, true])).toEqual({
      objectDisappeared: false,
      objectAppeared: true,
    });
  });

  it('present throughout → neither (touch-shaped)', () => {
    expect(deriveObjectPresenceChange([true, true, true, true, true, true])).toEqual({
      objectDisappeared: false,
      objectAppeared: false,
    });
  });

  it('absent throughout or too few frames → inconclusive (null)', () => {
    expect(deriveObjectPresenceChange([false, false, false])).toEqual({
      objectDisappeared: null,
      objectAppeared: null,
    });
    expect(deriveObjectPresenceChange([true, false])).toEqual({
      objectDisappeared: null,
      objectAppeared: null,
    });
  });
});

describe('normalizeDetectorFrames', () => {
  const productBox = { x: 0.4, y: 0.4, width: 0.2, height: 0.25 };
  const handBox = { x: 0.45, y: 0.5, width: 0.12, height: 0.12 };

  it('maps roles to labels, derives PRODUCT_IN_HAND from overlap, and builds the hand signal', () => {
    const out = normalizeDetectorFrames({
      handRoleSupported: true,
      cropQuality: QUALITY,
      frames: [
        frame(0, [det('PRODUCT', 0.8, productBox)]),
        frame(500, [det('PRODUCT', 0.8, productBox), det('HAND', 0.7, handBox)]),
        frame(1000, [det('PRODUCT', 0.8, productBox), det('HAND', 0.7, handBox)]),
        frame(1500, [det('HAND', 0.7, handBox), det('PERSON', 0.9)]),
        frame(2000, []),
        frame(2500, []),
      ],
    });
    expect(out.detections.map((row) => [row.timestampMs, row.label])).toEqual([
      [0, 'PRODUCT'],
      [500, 'PRODUCT_IN_HAND'],
      [500, 'HAND'],
      [1000, 'PRODUCT_IN_HAND'],
      [1000, 'HAND'],
      [1500, 'HAND'],
    ]);
    // Product detections carry the classical crop quality; hands none.
    expect(out.detections[0].quality).toEqual(QUALITY);
    expect(out.detections[2].quality).toBeNull();
    expect(out.handSignal).toEqual({
      handPresent: true,
      nearShelfZone: true,
      enteredZoneAtMs: 500,
      contactStartMs: 500,
      contactEndMs: 1000,
      leftZoneAtMs: 1500,
      contactDurationMs: 500,
    });
    expect(out.objectDisappeared).toBe(true);
    expect(out.objectAppeared).toBe(false);
    expect(out.notes).toEqual([
      'LOCAL_DETECTOR_OUTPUT',
      'PRODUCT_DETECTED',
      'PRODUCT_IN_HAND_DETECTED',
      'HAND_DETECTED_BY_DETECTOR',
      'PERSON_DETECTED',
    ]);
  });

  it('a model without a HAND class yields no hand signal, no PRODUCT_IN_HAND, and a note', () => {
    const out = normalizeDetectorFrames({
      handRoleSupported: false,
      cropQuality: QUALITY,
      frames: [
        frame(0, [det('PRODUCT', 0.8, productBox), det('HAND', 0.7, handBox)]),
        frame(500, [det('PRODUCT', 0.8, productBox)]),
        frame(1000, [det('PRODUCT', 0.8, productBox)]),
      ],
    });
    expect(out.handSignal).toBeNull();
    expect(out.detections.every((row) => row.label === 'PRODUCT')).toBe(true);
    expect(out.notes).toContain('HAND_ROLE_UNSUPPORTED_BY_MODEL');
    expect(out.notes).not.toContain('HAND_DETECTED_BY_DETECTOR');
  });

  it('a hand-capable model that saw no hand reports handPresent false with null timings', () => {
    const out = normalizeDetectorFrames({
      handRoleSupported: true,
      cropQuality: QUALITY,
      frames: [frame(0, [det('PRODUCT', 0.8, productBox)]), frame(500, []), frame(1000, [])],
    });
    expect(out.handSignal).toEqual({
      handPresent: false,
      nearShelfZone: false,
      enteredZoneAtMs: null,
      contactStartMs: null,
      contactEndMs: null,
      leftZoneAtMs: null,
      contactDurationMs: null,
    });
    expect(out.notes).not.toContain('PRODUCT_IN_HAND_DETECTED');
  });

  it('caps detections per frame so 32 crowded frames stay under the 64-detection ceiling', () => {
    const crowded = Array.from({ length: 32 }, (_, index) =>
      frame(index * 250, [
        det('PRODUCT', 0.9, productBox),
        det('PRODUCT', 0.8, productBox),
        det('PRODUCT', 0.7, productBox),
        det('HAND', 0.6, handBox),
        det('HAND', 0.5, handBox),
      ]),
    );
    const out = normalizeDetectorFrames({
      handRoleSupported: true,
      cropQuality: QUALITY,
      frames: crowded,
    });
    // 2 products + 1 hand per frame → 96 raw; the sanitizer trims to 64
    // downstream, but no frame exceeds its own cap here.
    const perFrame = new Map<number, number>();
    for (const row of out.detections) {
      perFrame.set(row.timestampMs, (perFrame.get(row.timestampMs) ?? 0) + 1);
    }
    expect([...perFrame.values()].every((count) => count <= 3)).toBe(true);
    expect(out.detections.filter((row) => row.confidence === 0.7)).toHaveLength(0);
    expect(out.detections.filter((row) => row.confidence === 0.5)).toHaveLength(0);
  });

  it('sorts frames by timestamp before deriving the timeline', () => {
    const out = normalizeDetectorFrames({
      handRoleSupported: false,
      cropQuality: QUALITY,
      frames: [
        frame(2000, []),
        frame(0, [det('PRODUCT', 0.8, productBox)]),
        frame(1000, [det('PRODUCT', 0.8, productBox)]),
        frame(2500, []),
        frame(500, [det('PRODUCT', 0.8, productBox)]),
        frame(1500, []),
      ],
    });
    expect(out.detections.map((row) => row.timestampMs)).toEqual([0, 500, 1000]);
    expect(out.objectDisappeared).toBe(true);
  });

  it('no product anywhere → NO_PRODUCT_FRAME and inconclusive presence', () => {
    const out = normalizeDetectorFrames({
      handRoleSupported: false,
      cropQuality: { sharpness: null, occlusion: null, brightness: null },
      frames: [frame(0, [det('PERSON', 0.9)]), frame(500, []), frame(1000, [])],
    });
    expect(out.detections).toEqual([]);
    expect(out.notes).toContain('NO_PRODUCT_FRAME');
    expect(out.notes).toContain('PERSON_DETECTED');
    expect(out.objectDisappeared).toBeNull();
    expect(out.objectAppeared).toBeNull();
  });
});

describe('normalizeDetectorResult', () => {
  it('reads HAND support from the model descriptor role counts', () => {
    const frames = [
      frame(0, [det('PRODUCT', 0.8), det('HAND', 0.7)]),
      frame(500, [det('PRODUCT', 0.8)]),
      frame(1000, [det('PRODUCT', 0.8)]),
    ];
    const model = {
      modelId: 'm',
      task: 'DETECT' as const,
      runtime: 'ULTRALYTICS' as const,
      format: 'PT' as const,
      version: '1',
      inputSize: 640,
      classCount: 2,
      roleClassCounts: { PRODUCT: 1, HAND: 1, PERSON: 0, OBJECT: 0 },
    };
    expect(normalizeDetectorResult({ frames, model }, QUALITY).handSignal?.handPresent).toBe(true);
    expect(
      normalizeDetectorResult(
        { frames, model: { ...model, roleClassCounts: { ...model.roleClassCounts, HAND: 0 } } },
        QUALITY,
      ).handSignal,
    ).toBeNull();
    expect(normalizeDetectorResult({ frames, model: null }, QUALITY).handSignal).toBeNull();
  });
});
