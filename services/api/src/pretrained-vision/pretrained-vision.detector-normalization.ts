import type {
  DetectorDetection,
  DetectorFrameResult,
  LocalDetectorResult,
} from '../local-vision-runtime/local-vision-runtime.port';
import {
  DetectionLabel,
  HandSignalSummary,
  NormalizedBox,
  NormalizedDetection,
} from './pretrained-vision.types';

/**
 * PURE normalization of a LOCAL detector runtime result into the Phase
 * 19 provider-evidence vocabulary (no I/O, no Nest). The runtime port
 * already delivers safe output (roles, class indexes, clamped numbers,
 * normalized boxes); this layer only decides WHAT the evidence means:
 *
 * - PRODUCT role      -> 'PRODUCT'
 * - HAND role         -> 'HAND'
 * - PRODUCT box overlapping a HAND box in the same frame
 *                     -> 'PRODUCT_IN_HAND'
 * - PERSON / OBJECT   -> never a detection; PERSON adds a note only
 *
 * Per-frame caps (2 product + 1 hand, by confidence) bound the rows;
 * when the whole timeline still exceeds the sanitizer's 64-detection
 * ceiling, frames are evenly subsampled HERE (first and last frame
 * always kept) so the sanitizer never truncates the clip's tail. The
 * hand signal and presence timeline are derived from ALL frames before
 * that subsampling. Detector detections carry NO quality block: no
 * per-frame sharpness/occlusion/brightness is measured for them, and
 * the classical crop's numbers belong to the classical baseline only.
 * Multi-product shelves: appearance / disappearance is decided on the
 * per-frame PRODUCT COUNT (median of the first third vs the last third -
 * "4 bottles, then 3" is a pickup-shaped change even though products
 * stay present throughout), and the product that vanished / appeared is
 * localized by IoU-matching early boxes to late boxes; its box becomes
 * `eventBox` and its per-frame track drives movement / hand proximity.
 * Nothing here decides anything
 * downstream: the action candidate stays a CANDIDATE and the service
 * forces review for every real pretrained contribution.
 */

const PRODUCTS_PER_FRAME = 2;
const HANDS_PER_FRAME = 1;
/** Minimum intersection-over-union for "product in hand". Tiny: a hand
 *  usually covers a sliver of the product box, and either center being
 *  inside the other box also qualifies. */
const IN_HAND_MIN_IOU = 0.05;
/** Same ceiling as sanitizeProviderEvidence - kept in sync by a test. */
export const MAX_EVIDENCE_DETECTIONS = 64;
/** Minimum IoU for "the same product" across early and late frames (and
 *  along the event product's track). Products on a shelf barely move
 *  until they are taken, so a generous floor is enough. */
const SAME_PRODUCT_MIN_IOU = 0.3;

export interface DetectorNormalizationInput {
  frames: DetectorFrameResult[];
  /** Whether the model has at least one class mapped to HAND — a COCO
   *  model does not, so it can never emit a hand signal. */
  handRoleSupported: boolean;
}

export interface DetectorNormalizationOutput {
  detections: NormalizedDetection[];
  handSignal: HandSignalSummary | null;
  objectDisappeared: boolean | null;
  objectAppeared: boolean | null;
  /** The product that vanished / appeared (multi-product shelves), or
   *  null when no single product could be localized. */
  eventBox: NormalizedBox | null;
  /** That product's box in every sampled frame it was seen in, in time
   *  order (empty when there is no event box). */
  eventTrack: NormalizedBox[];
  /** True when the model has no HAND role but a person was seen while
   *  the product count changed — the only contact evidence such a model
   *  can give. Feeds buildInteractionFeatures.contactProxy. */
  contactProxy: boolean;
  notes: string[];
}

function intersectionOverUnion(a: NormalizedBox, b: NormalizedBox): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, right - left) * Math.max(0, bottom - top);
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}

function centerInside(inner: NormalizedBox, outer: NormalizedBox): boolean {
  const cx = inner.x + inner.width / 2;
  const cy = inner.y + inner.height / 2;
  return (
    cx >= outer.x &&
    cx <= outer.x + outer.width &&
    cy >= outer.y &&
    cy <= outer.y + outer.height
  );
}

/** A product box "is in hand" when it overlaps a hand box in the same
 *  frame: IoU above a small floor, or either box's center inside the
 *  other. */
export function boxesOverlap(product: NormalizedBox, hand: NormalizedBox): boolean {
  return (
    intersectionOverUnion(product, hand) > IN_HAND_MIN_IOU ||
    centerInside(product, hand) ||
    centerInside(hand, product)
  );
}

function byConfidenceDesc(a: DetectorDetection, b: DetectorDetection): number {
  return b.confidence - a.confidence;
}

/** Product / hand detections of one frame, capped by confidence. */
export function selectFrameDetections(frame: DetectorFrameResult): {
  products: DetectorDetection[];
  hands: DetectorDetection[];
  personSeen: boolean;
} {
  const products = frame.detections
    .filter((row) => row.role === 'PRODUCT')
    .sort(byConfidenceDesc)
    .slice(0, PRODUCTS_PER_FRAME);
  const hands = frame.detections
    .filter((row) => row.role === 'HAND')
    .sort(byConfidenceDesc)
    .slice(0, HANDS_PER_FRAME);
  const personSeen = frame.detections.some((row) => row.role === 'PERSON');
  return { products, hands, personSeen };
}

/**
 * Object appearance / disappearance from the sampled timeline: product
 * present in the first third of frames and absent in the last third
 * means it DISAPPEARED (pickup-shaped); the inverse means it APPEARED
 * (return-shaped). Anything else is inconclusive (null) — the action
 * candidate then resolves to UNKNOWN and stays review-required.
 */
export function deriveObjectPresenceChange(productPresentByFrame: boolean[]): {
  objectDisappeared: boolean | null;
  objectAppeared: boolean | null;
} {
  const total = productPresentByFrame.length;
  if (total < 3) {
    return { objectDisappeared: null, objectAppeared: null };
  }
  const third = Math.floor(total / 3);
  const early = productPresentByFrame.slice(0, third);
  const late = productPresentByFrame.slice(total - third);
  const earlyPresent = early.some(Boolean);
  const latePresent = late.some(Boolean);
  if (earlyPresent && !latePresent) {
    return { objectDisappeared: true, objectAppeared: false };
  }
  if (!earlyPresent && latePresent) {
    return { objectDisappeared: false, objectAppeared: true };
  }
  if (earlyPresent && latePresent) {
    // Present throughout — a touch without a take, or no interaction.
    return { objectDisappeared: false, objectAppeared: false };
  }
  return { objectDisappeared: null, objectAppeared: null };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Count-based appearance / disappearance for MULTI-PRODUCT shelves: the
 * MEDIAN product count of the first third of frames against the last
 * third (a median shrugs off one flickering frame). A lower late count
 * is pickup-shaped (`objectDisappeared`), a higher one return-shaped
 * (`objectAppeared`). Equal counts fall back to the any-present rule of
 * deriveObjectPresenceChange, so a single product that vanished still
 * reads as a disappearance and "present throughout" as no change. No
 * product anywhere is inconclusive (nulls). Exported for tests.
 */
export function deriveObjectCountChange(productCountByFrame: number[]): {
  objectDisappeared: boolean | null;
  objectAppeared: boolean | null;
  countDecreased: boolean;
  countIncreased: boolean;
} {
  const total = productCountByFrame.length;
  const none = {
    objectDisappeared: null,
    objectAppeared: null,
    countDecreased: false,
    countIncreased: false,
  };
  if (total < 3 || !productCountByFrame.some((count) => count > 0)) {
    return none;
  }
  const third = Math.floor(total / 3);
  const early = median(productCountByFrame.slice(0, third));
  const late = median(productCountByFrame.slice(total - third));
  if (late < early) {
    return {
      objectDisappeared: true,
      objectAppeared: false,
      countDecreased: true,
      countIncreased: false,
    };
  }
  if (late > early) {
    return {
      objectDisappeared: false,
      objectAppeared: true,
      countDecreased: false,
      countIncreased: true,
    };
  }
  const presence = deriveObjectPresenceChange(
    productCountByFrame.map((count) => count > 0),
  );
  return { ...presence, countDecreased: false, countIncreased: false };
}

/**
 * Localize the product an event is ABOUT. Early = first third of frames,
 * late = last third; the representative frame of each side is the first
 * frame whose product count equals that side's median (a frame the
 * median describes, never a flicker). Early boxes are greedily matched to
 * late boxes by IoU (best pairs first, floor SAME_PRODUCT_MIN_IOU); for a
 * disappearance the event product is the highest-confidence UNMATCHED
 * early box, for an appearance the highest-confidence unmatched LATE box.
 * Its track is its best-IoU product box in every frame where one
 * overlaps it. Exported for tests.
 */
export function localizeEventProduct(
  frames: DetectorFrameResult[],
  kind: 'DISAPPEARED' | 'APPEARED',
): { eventBox: NormalizedBox | null; eventTrack: NormalizedBox[] } {
  const total = frames.length;
  if (total < 3) {
    return { eventBox: null, eventTrack: [] };
  }
  const productsOf = (frame: DetectorFrameResult) =>
    frame.detections.filter((row) => row.role === 'PRODUCT').sort(byConfidenceDesc);
  const third = Math.floor(total / 3);
  const earlyFrames = frames.slice(0, third);
  const lateFrames = frames.slice(total - third);
  const representative = (side: DetectorFrameResult[]) => {
    const target = median(side.map((frame) => productsOf(frame).length));
    return side.find((frame) => productsOf(frame).length === target) ?? side[0];
  };
  const earlyBoxes = productsOf(representative(earlyFrames));
  const lateBoxes = productsOf(representative(lateFrames));

  const pairs: { early: number; late: number; iou: number }[] = [];
  earlyBoxes.forEach((early, earlyIndex) => {
    lateBoxes.forEach((late, lateIndex) => {
      const iou = intersectionOverUnion(early.box, late.box);
      if (iou >= SAME_PRODUCT_MIN_IOU) {
        pairs.push({ early: earlyIndex, late: lateIndex, iou });
      }
    });
  });
  pairs.sort((a, b) => b.iou - a.iou);
  const matchedEarly = new Set<number>();
  const matchedLate = new Set<number>();
  for (const pair of pairs) {
    if (!matchedEarly.has(pair.early) && !matchedLate.has(pair.late)) {
      matchedEarly.add(pair.early);
      matchedLate.add(pair.late);
    }
  }
  const unmatched =
    kind === 'DISAPPEARED'
      ? earlyBoxes.filter((_row, index) => !matchedEarly.has(index))
      : lateBoxes.filter((_row, index) => !matchedLate.has(index));
  const event = unmatched[0]; // already confidence-sorted
  if (!event) {
    return { eventBox: null, eventTrack: [] };
  }
  const eventTrack: NormalizedBox[] = [];
  for (const frame of frames) {
    let best: { iou: number; box: NormalizedBox } | null = null;
    for (const product of productsOf(frame)) {
      const iou = intersectionOverUnion(product.box, event.box);
      if (iou >= SAME_PRODUCT_MIN_IOU && (best === null || iou > best.iou)) {
        best = { iou, box: product.box };
      }
    }
    if (best) {
      eventTrack.push(best.box);
    }
  }
  return { eventBox: event.box, eventTrack };
}

/** Smallest positive gap between consecutive sampled timestamps; 1 ms
 *  when the sample has no such gap (single frame). Exported for tests. */
export function samplingIntervalMs(timestamps: number[]): number {
  const sorted = [...timestamps].sort((a, b) => a - b);
  let smallest = Number.POSITIVE_INFINITY;
  for (let i = 1; i < sorted.length; i += 1) {
    const gap = sorted[i] - sorted[i - 1];
    if (gap > 0 && gap < smallest) {
      smallest = gap;
    }
  }
  return Number.isFinite(smallest) ? smallest : 1;
}

/**
 * A contact seen in the sampled frames spans at least one sampling
 * interval: a grab visible in exactly ONE frame is still a contact, not
 * a zero-length one (Codex P2 - contactDurationMs 0 read as "no
 * contact" downstream). Exported for tests.
 */
export function sampledContactDurationMs(
  firstContactMs: number,
  lastContactMs: number,
  intervalMs: number,
): number {
  return Math.max(1, Math.max(intervalMs, lastContactMs - firstContactMs));
}

/**
 * Keep the detection list within `limit` by evenly subsampling FRAMES
 * (never individual rows), always retaining the first and last frame, so
 * a crowded 32-frame clip loses interior coverage rather than its tail.
 * Exported for tests.
 */
export function boundDetectionsAcrossTimeline(
  detections: NormalizedDetection[],
  limit: number,
): NormalizedDetection[] {
  if (detections.length <= limit) {
    return detections;
  }
  const timestamps = [...new Set(detections.map((row) => row.timestampMs))].sort(
    (a, b) => a - b,
  );
  const byTimestamp = new Map<number, NormalizedDetection[]>();
  for (const row of detections) {
    const bucket = byTimestamp.get(row.timestampMs) ?? [];
    bucket.push(row);
    byTimestamp.set(row.timestampMs, bucket);
  }
  for (let keep = timestamps.length - 1; keep >= 1; keep -= 1) {
    const picked = new Set<number>();
    for (let i = 0; i < keep; i += 1) {
      const position =
        keep === 1 ? 0 : Math.round((i * (timestamps.length - 1)) / (keep - 1));
      picked.add(timestamps[position]);
    }
    const rows = timestamps
      .filter((timestamp) => picked.has(timestamp))
      .flatMap((timestamp) => byTimestamp.get(timestamp) ?? []);
    if (rows.length <= limit) {
      return rows;
    }
  }
  // A single frame alone exceeds the limit: keep its highest-confidence rows.
  return [...(byTimestamp.get(timestamps[timestamps.length - 1]) ?? [])]
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, limit);
}

export function normalizeDetectorFrames(
  input: DetectorNormalizationInput,
): DetectorNormalizationOutput {
  const frames = [...input.frames].sort((a, b) => a.timestampMs - b.timestampMs);
  const detections: NormalizedDetection[] = [];
  const productPresentByFrame: boolean[] = [];
  // Product COUNT per frame from ALL detections (before per-frame caps):
  // the shelf-level change signal must see every product, not the two
  // strongest rows the evidence keeps.
  const productCountByFrame: number[] = [];
  let personSeen = false;
  let handSeen = false;
  let inHandSeen = false;
  let firstHandMs: number | null = null;
  let lastHandMs: number | null = null;
  let firstContactMs: number | null = null;
  let lastContactMs: number | null = null;

  for (const frame of frames) {
    const selected = selectFrameDetections(frame);
    personSeen = personSeen || selected.personSeen;
    productPresentByFrame.push(selected.products.length > 0);
    productCountByFrame.push(
      frame.detections.filter((row) => row.role === 'PRODUCT').length,
    );
    const hands = input.handRoleSupported ? selected.hands : [];
    if (hands.length) {
      handSeen = true;
      firstHandMs = firstHandMs ?? frame.timestampMs;
      lastHandMs = frame.timestampMs;
    }
    for (const product of selected.products) {
      const inHand = hands.some((hand) => boxesOverlap(product.box, hand.box));
      if (inHand) {
        inHandSeen = true;
        firstContactMs = firstContactMs ?? frame.timestampMs;
        lastContactMs = frame.timestampMs;
      }
      const label: DetectionLabel = inHand ? 'PRODUCT_IN_HAND' : 'PRODUCT';
      detections.push({
        label,
        timestampMs: frame.timestampMs,
        box: product.box,
        confidence: product.confidence,
        // No per-detection quality measurement exists for the detector -
        // never stamp the classical crop's numbers here (Codex P2).
        quality: null,
      });
    }
    for (const hand of hands) {
      detections.push({
        label: 'HAND',
        timestampMs: frame.timestampMs,
        box: hand.box,
        confidence: hand.confidence,
        quality: null,
      });
    }
  }

  const presence = deriveObjectCountChange(productCountByFrame);
  const localized =
    presence.objectDisappeared === true
      ? localizeEventProduct(frames, 'DISAPPEARED')
      : presence.objectAppeared === true
        ? localizeEventProduct(frames, 'APPEARED')
        : { eventBox: null, eventTrack: [] };

  // Hand signal ONLY when the model can see hands. There is no shelf
  // zone geometry yet, so "near shelf zone" means hand-product contact
  // was observed — documented as such until zones land.
  const handSignal: HandSignalSummary | null = input.handRoleSupported
    ? {
        handPresent: handSeen,
        nearShelfZone: inHandSeen,
        enteredZoneAtMs: firstHandMs,
        contactStartMs: firstContactMs,
        contactEndMs: lastContactMs,
        leftZoneAtMs: lastHandMs,
        contactDurationMs:
          firstContactMs !== null && lastContactMs !== null
            ? sampledContactDurationMs(
                firstContactMs,
                lastContactMs,
                samplingIntervalMs(frames.map((row) => row.timestampMs)),
              )
            : null,
      }
    : null;

  const anyProduct = productPresentByFrame.some(Boolean);
  const notes: string[] = ['LOCAL_DETECTOR_OUTPUT'];
  notes.push(anyProduct ? 'PRODUCT_DETECTED' : 'NO_PRODUCT_FRAME');
  if (inHandSeen) {
    notes.push('PRODUCT_IN_HAND_DETECTED');
  }
  if (input.handRoleSupported) {
    if (handSeen) {
      notes.push('HAND_DETECTED_BY_DETECTOR');
    }
  } else {
    notes.push('HAND_ROLE_UNSUPPORTED_BY_MODEL');
  }
  if (personSeen) {
    notes.push('PERSON_DETECTED');
  }
  if (presence.countDecreased) {
    notes.push('PRODUCT_COUNT_DECREASED');
  }
  if (presence.countIncreased) {
    notes.push('PRODUCT_COUNT_INCREASED');
  }
  if (localized.eventBox) {
    notes.push('EVENT_PRODUCT_LOCALIZED');
  }
  const contactProxy =
    !input.handRoleSupported &&
    personSeen &&
    (presence.countDecreased || presence.countIncreased);
  if (contactProxy) {
    notes.push('PERSON_PRESENCE_CONTACT_PROXY');
  }

  const bounded = boundDetectionsAcrossTimeline(detections, MAX_EVIDENCE_DETECTIONS);
  if (bounded.length < detections.length) {
    notes.push('DETECTIONS_SUBSAMPLED');
  }

  return {
    detections: bounded,
    handSignal,
    objectDisappeared: presence.objectDisappeared,
    objectAppeared: presence.objectAppeared,
    eventBox: localized.eventBox,
    eventTrack: localized.eventTrack,
    contactProxy,
    notes,
  };
}

/** Convenience over a whole runtime result: reads the HAND role support
 *  from the model descriptor. */
export function normalizeDetectorResult(
  result: Pick<LocalDetectorResult, 'frames' | 'model'>,
): DetectorNormalizationOutput {
  return normalizeDetectorFrames({
    frames: result.frames,
    handRoleSupported: (result.model?.roleClassCounts.HAND ?? 0) > 0,
  });
}
