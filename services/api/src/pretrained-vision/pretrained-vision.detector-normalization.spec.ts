import type {
  DetectorDetection,
  DetectorFrameResult,
} from '../local-vision-runtime/local-vision-runtime.port';
import {
  MAX_EVIDENCE_DETECTIONS,
  boundDetectionsAcrossTimeline,
  boxesOverlap,
  deriveObjectCountChange,
  deriveObjectPresenceChange,
  localizeEventProduct,
  normalizeDetectorFrames,
  normalizeDetectorResult,
  sampledContactDurationMs,
  samplingIntervalMs,
  selectFrameDetections,
} from './pretrained-vision.detector-normalization';
import { buildInteractionFeatures, sanitizeProviderEvidence } from './pretrained-vision.types';

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
    // No per-detection quality is measured for the detector: never the
    // classical crop's numbers (Codex P2).
    expect(out.detections.every((row) => row.quality === null)).toBe(true);
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
      // Single product 1 → 0 is a count decrease, and it was localized.
      'PRODUCT_COUNT_DECREASED',
      'EVENT_PRODUCT_LOCALIZED',
    ]);
  });

  it('a model without a HAND class yields no hand signal, no PRODUCT_IN_HAND, and a note', () => {
    const out = normalizeDetectorFrames({
      handRoleSupported: false,
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

  it('caps per frame AND bounds the whole timeline to the sanitizer ceiling without dropping the tail (Codex P2)', () => {
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
      frames: crowded,
    });
    // 2 products + 1 hand per frame → 96 raw rows; bounded to ≤ 64 by
    // subsampling FRAMES, keeping the first and the LAST frame.
    expect(out.detections.length).toBeLessThanOrEqual(MAX_EVIDENCE_DETECTIONS);
    const timestamps = out.detections.map((row) => row.timestampMs);
    expect(timestamps[0]).toBe(0);
    expect(timestamps[timestamps.length - 1]).toBe(31 * 250);
    expect(new Set(timestamps).size).toBeGreaterThanOrEqual(21);
    const perFrame = new Map<number, number>();
    for (const row of out.detections) {
      perFrame.set(row.timestampMs, (perFrame.get(row.timestampMs) ?? 0) + 1);
    }
    expect([...perFrame.values()].every((count) => count <= 3)).toBe(true);
    expect(out.detections.filter((row) => row.confidence === 0.7)).toHaveLength(0);
    expect(out.detections.filter((row) => row.confidence === 0.5)).toHaveLength(0);
    expect(out.notes).toContain('DETECTIONS_SUBSAMPLED');
    // The hand signal still spans the FULL clip (derived before bounding).
    expect(out.handSignal?.contactEndMs).toBe(31 * 250);
    // And the sanitizer would not have to truncate anything.
    expect(
      sanitizeProviderEvidence({
        provider: 'YOLO_LOCAL',
        availability: 'READY',
        detections: out.detections,
      }).detections,
    ).toHaveLength(out.detections.length);
  });

  it('a grab visible in exactly ONE sampled frame is a positive-duration contact (Codex P2)', () => {
    const out = normalizeDetectorFrames({
      handRoleSupported: true,
      frames: [
        frame(0, [det('PRODUCT', 0.8, productBox)]),
        frame(500, [det('PRODUCT', 0.8, productBox), det('HAND', 0.7, handBox)]),
        frame(1000, []),
        frame(1500, []),
      ],
    });
    expect(out.handSignal).toMatchObject({
      contactStartMs: 500,
      contactEndMs: 500,
      contactDurationMs: 500,
      nearShelfZone: true,
    });
    expect(out.notes).toContain('PRODUCT_IN_HAND_DETECTED');
    // Single-frame sample: no interval is known → 1 ms, never 0.
    const single = normalizeDetectorFrames({
      handRoleSupported: true,
      frames: [frame(700, [det('PRODUCT', 0.8, productBox), det('HAND', 0.7, handBox)])],
    });
    expect(single.handSignal?.contactDurationMs).toBe(1);
    expect(samplingIntervalMs([])).toBe(1);
    expect(samplingIntervalMs([2000, 0, 500, 1500])).toBe(500);
    expect(sampledContactDurationMs(500, 500, 500)).toBe(500);
    expect(sampledContactDurationMs(500, 2000, 500)).toBe(1500);
  });

  it('boundDetectionsAcrossTimeline keeps first and last frames and never exceeds the limit', () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      label: 'PRODUCT' as const,
      timestampMs: i * 100,
      box: productBox,
      confidence: 0.5 + i / 100,
      quality: null,
    }));
    const doubled = rows.flatMap((row) => [row, { ...row, confidence: 0.4 }]);
    const bounded = boundDetectionsAcrossTimeline(doubled, 7);
    expect(bounded.length).toBeLessThanOrEqual(7);
    expect(bounded[0].timestampMs).toBe(0);
    expect(bounded[bounded.length - 1].timestampMs).toBe(900);
    expect(boundDetectionsAcrossTimeline(rows, 64)).toBe(rows);
    // One frame alone over the limit → its highest-confidence rows.
    const oneFrame = Array.from({ length: 5 }, (_, i) => ({ ...rows[0], confidence: i / 10 }));
    expect(boundDetectionsAcrossTimeline(oneFrame, 2).map((row) => row.confidence)).toEqual([0.4, 0.3]);
  });

  it('sorts frames by timestamp before deriving the timeline', () => {
    const out = normalizeDetectorFrames({
      handRoleSupported: false,
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
      classDigest: '0123456789abcdef0123456789abcdef',
      roleClassCounts: { PRODUCT: 1, HAND: 1, PERSON: 0, OBJECT: 0 },
    };
    expect(normalizeDetectorResult({ frames, model }).handSignal?.handPresent).toBe(true);
    expect(
      normalizeDetectorResult(
        { frames, model: { ...model, roleClassCounts: { ...model.roleClassCounts, HAND: 0 } } },
      ).handSignal,
    ).toBeNull();
    expect(normalizeDetectorResult({ frames, model: null }).handSignal).toBeNull();
  });
});

// --------------------------------------------- Phase 21: shelf counts

/** A 2x2 fridge shelf: four bottles at fixed positions; the hand takes
 *  the middle-left one. */
const SHELF = {
  topLeft: { x: 0.1, y: 0.2, width: 0.15, height: 0.2 },
  topRight: { x: 0.7, y: 0.2, width: 0.15, height: 0.2 },
  midLeft: { x: 0.12, y: 0.55, width: 0.15, height: 0.2 },
  midRight: { x: 0.72, y: 0.55, width: 0.15, height: 0.2 },
};

const NO_QUALITY = {
  pre: null,
  peak: null,
  post: null,
  occlusion: null,
  sharpness: null,
  brightness: null,
};

function shelfFrame(
  timestampMs: number,
  boxes: { x: number; y: number; width: number; height: number }[],
  extra: DetectorDetection[] = [],
): DetectorFrameResult {
  return frame(timestampMs, [
    ...boxes.map((box, index) => det('PRODUCT', 0.85 - index * 0.03, box)),
    ...extra,
  ]);
}

/** 15 frames: 4 bottles for 5 frames, a person for 4 frames while the
 *  mid-left bottle goes, then 3 bottles for 6 frames. */
function fridgePickupFrames(): DetectorFrameResult[] {
  const all = [SHELF.topLeft, SHELF.topRight, SHELF.midLeft, SHELF.midRight];
  const three = [SHELF.topLeft, SHELF.topRight, SHELF.midRight];
  const person = det('PERSON', 0.7, { x: 0, y: 0.4, width: 0.4, height: 0.6 });
  const frames: DetectorFrameResult[] = [];
  for (let i = 0; i < 5; i += 1) frames.push(shelfFrame(i * 500, all));
  for (let i = 5; i < 9; i += 1) frames.push(shelfFrame(i * 500, three, [person]));
  for (let i = 9; i < 15; i += 1) frames.push(shelfFrame(i * 500, three));
  return frames;
}

describe('deriveObjectCountChange (multi-product shelves)', () => {
  it('a lower late median count is a disappearance even though products stay present', () => {
    expect(deriveObjectCountChange([4, 4, 4, 4, 4, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3])).toEqual({
      objectDisappeared: true,
      objectAppeared: false,
      countDecreased: true,
      countIncreased: false,
    });
  });

  it('a higher late median count is an appearance (return-shaped)', () => {
    expect(deriveObjectCountChange([3, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4, 4])).toEqual({
      objectDisappeared: false,
      objectAppeared: true,
      countDecreased: false,
      countIncreased: true,
    });
  });

  it('one flickering frame does not move the median', () => {
    // 4 bottles throughout, one early frame misses one, one late frame
    // doubles one — the medians stay 4 and 4: present throughout.
    expect(deriveObjectCountChange([4, 3, 4, 4, 4, 4, 4, 4, 4, 5, 4, 4])).toEqual({
      objectDisappeared: false,
      objectAppeared: false,
      countDecreased: false,
      countIncreased: false,
    });
  });

  it('a single product that vanishes still reads as a disappearance', () => {
    expect(deriveObjectCountChange([1, 1, 1, 1, 0, 0])).toMatchObject({
      objectDisappeared: true,
      objectAppeared: false,
      countDecreased: true,
    });
  });

  it('no product anywhere or too few frames is inconclusive', () => {
    expect(deriveObjectCountChange([0, 0, 0, 0, 0, 0])).toMatchObject({
      objectDisappeared: null,
      objectAppeared: null,
    });
    expect(deriveObjectCountChange([2, 1])).toMatchObject({
      objectDisappeared: null,
      objectAppeared: null,
    });
  });
});

describe('localizeEventProduct', () => {
  it('finds the bottle that vanished on a 4 → 3 shelf and tracks it through the early frames', () => {
    const { eventBox, eventTrack } = localizeEventProduct(fridgePickupFrames(), 'DISAPPEARED');
    expect(eventBox).toEqual(SHELF.midLeft);
    // Seen in the first 5 frames only (it is gone afterwards).
    expect(eventTrack).toHaveLength(5);
    expect(eventTrack[0]).toEqual(SHELF.midLeft);
  });

  it('finds the bottle that appeared on a 3 → 4 shelf', () => {
    const three = [SHELF.topLeft, SHELF.topRight, SHELF.midRight];
    const all = [SHELF.topLeft, SHELF.topRight, SHELF.midLeft, SHELF.midRight];
    const frames = [
      ...[0, 1, 2, 3].map((i) => shelfFrame(i * 500, three)),
      ...[4, 5, 6, 7, 8].map((i) => shelfFrame(i * 500, all)),
    ];
    expect(localizeEventProduct(frames, 'APPEARED').eventBox).toEqual(SHELF.midLeft);
  });

  it('returns null when every early product matches a late one', () => {
    const all = [SHELF.topLeft, SHELF.topRight, SHELF.midLeft, SHELF.midRight];
    const frames = [0, 1, 2, 3, 4, 5].map((i) => shelfFrame(i * 500, all));
    expect(localizeEventProduct(frames, 'DISAPPEARED')).toEqual({
      eventBox: null,
      eventTrack: [],
    });
  });
});

describe('normalizeDetectorFrames — multi-product shelf (Phase 21)', () => {
  it('4 → 3 bottles with a person mid-clip: disappeared, event box = the vanished bottle, movement on its track', () => {
    const out = normalizeDetectorFrames({
      frames: fridgePickupFrames(),
      handRoleSupported: false,
    });
    expect(out.objectDisappeared).toBe(true);
    expect(out.objectAppeared).toBe(false);
    expect(out.eventBox).toEqual(SHELF.midLeft);
    expect(out.eventTrack).toHaveLength(5);
    expect(out.notes).toEqual(
      expect.arrayContaining([
        'PRODUCT_DETECTED',
        'PERSON_DETECTED',
        'PRODUCT_COUNT_DECREASED',
        'EVENT_PRODUCT_LOCALIZED',
      ]),
    );
    expect(out.notes).not.toContain('PRODUCT_COUNT_INCREASED');
    // The count signal saw all four bottles even though the evidence
    // rows keep only the two strongest per frame.
    const firstFrameRows = out.detections.filter((row) => row.timestampMs === 0);
    expect(firstFrameRows).toHaveLength(2);

    // Feature layer: movement is measured on the vanished bottle's own
    // track (a still bottle → 0), never on "first box vs last box" of
    // different products (which would be ~0.6 here).
    const features = buildInteractionFeatures({
      detections: out.detections,
      handSignal: null,
      cropQuality: NO_QUALITY,
      objectDisappeared: out.objectDisappeared,
      objectAppeared: out.objectAppeared,
      topSkuCandidates: [],
      eventBox: out.eventBox,
      eventTrack: out.eventTrack,
    });
    expect(features.eventBox).toEqual(SHELF.midLeft);
    expect(features.bboxMovement).toBe(0);
    expect(features.objectDisappeared).toBe(true);
    // Sanitizer keeps the event box.
    const evidence = sanitizeProviderEvidence({
      provider: 'YOLO_LOCAL',
      availability: 'READY',
      synthetic: false,
      detections: out.detections,
      features,
    });
    expect(evidence.features?.eventBox).toEqual(SHELF.midLeft);
  });

  it('3 → 4 bottles: appeared with the new bottle as the event box', () => {
    const three = [SHELF.topLeft, SHELF.topRight, SHELF.midRight];
    const all = [SHELF.topLeft, SHELF.topRight, SHELF.midLeft, SHELF.midRight];
    const out = normalizeDetectorFrames({
      frames: [
        ...[0, 1, 2, 3].map((i) => shelfFrame(i * 500, three)),
        ...[4, 5, 6, 7, 8, 9].map((i) => shelfFrame(i * 500, all)),
      ],
      handRoleSupported: false,
    });
    expect(out.objectAppeared).toBe(true);
    expect(out.objectDisappeared).toBe(false);
    expect(out.eventBox).toEqual(SHELF.midLeft);
    expect(out.notes).toContain('PRODUCT_COUNT_INCREASED');
  });

  it('a hand-capable model: proximity is measured to the EVENT product, and contact yields PICKUP', () => {
    const all = [SHELF.topLeft, SHELF.topRight, SHELF.midLeft, SHELF.midRight];
    const three = [SHELF.topLeft, SHELF.topRight, SHELF.midRight];
    const hand = det('HAND', 0.8, { x: 0.14, y: 0.6, width: 0.1, height: 0.1 }, 1);
    const frames = [
      ...[0, 1, 2, 3].map((i) => shelfFrame(i * 500, all)),
      shelfFrame(2000, all, [hand]),
      shelfFrame(2500, all, [hand]),
      ...[6, 7, 8, 9, 10, 11].map((i) => shelfFrame(i * 500, three)),
    ];
    const out = normalizeDetectorFrames({ frames, handRoleSupported: true });
    expect(out.eventBox).toEqual(SHELF.midLeft);
    const features = buildInteractionFeatures({
      detections: out.detections,
      handSignal: out.handSignal,
      cropQuality: NO_QUALITY,
      objectDisappeared: out.objectDisappeared,
      objectAppeared: out.objectAppeared,
      topSkuCandidates: [],
      eventBox: out.eventBox,
      eventTrack: out.eventTrack,
    });
    expect(features.handProximity).toBeGreaterThan(0.9);
    expect(features.actionCandidate).toBe('PICKUP');
  });

  it('no products at all: nulls, no event box, no count notes', () => {
    const person = det('PERSON', 0.7, { x: 0, y: 0.4, width: 0.4, height: 0.6 });
    const out = normalizeDetectorFrames({
      frames: [0, 500, 1000, 1500].map((ts) => frame(ts, [person])),
      handRoleSupported: false,
    });
    expect(out.objectDisappeared).toBeNull();
    expect(out.objectAppeared).toBeNull();
    expect(out.eventBox).toBeNull();
    expect(out.eventTrack).toEqual([]);
    expect(out.notes).not.toContain('PRODUCT_COUNT_DECREASED');
    expect(out.notes).not.toContain('EVENT_PRODUCT_LOCALIZED');
  });
});

describe('normalizeDetectorFrames — person-presence contact proxy (models without a HAND role)', () => {
  it('4 → 3 bottles with a person seen: contact proxy raised and the action becomes a PICKUP candidate', () => {
    const out = normalizeDetectorFrames({
      frames: fridgePickupFrames(),
      handRoleSupported: false,
    });
    expect(out.contactProxy).toBe(true);
    expect(out.notes).toContain('PERSON_PRESENCE_CONTACT_PROXY');
    const features = buildInteractionFeatures({
      detections: out.detections,
      handSignal: out.handSignal,
      cropQuality: NO_QUALITY,
      objectDisappeared: out.objectDisappeared,
      objectAppeared: out.objectAppeared,
      topSkuCandidates: [],
      eventBox: out.eventBox,
      eventTrack: out.eventTrack,
      contactProxy: out.contactProxy,
    });
    expect(features.actionCandidate).toBe('PICKUP');
  });

  it('is never raised when the model can see hands (real contact evidence rules)', () => {
    const out = normalizeDetectorFrames({
      frames: fridgePickupFrames(),
      handRoleSupported: true,
    });
    expect(out.contactProxy).toBe(false);
    expect(out.notes).not.toContain('PERSON_PRESENCE_CONTACT_PROXY');
  });

  it('is never raised without a count change, even with a person in frame', () => {
    const all = [SHELF.topLeft, SHELF.topRight, SHELF.midLeft, SHELF.midRight];
    const person = det('PERSON', 0.7, { x: 0.05, y: 0.4, width: 0.3, height: 0.5 });
    const frames = [0, 1, 2, 3, 4, 5].map((i) => shelfFrame(i * 500, all, i === 3 ? [person] : []));
    const out = normalizeDetectorFrames({ frames, handRoleSupported: false });
    expect(out.contactProxy).toBe(false);
  });
});
