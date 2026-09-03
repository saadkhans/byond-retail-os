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
 * Per-frame caps (2 product + 1 hand, by confidence) keep the evidence
 * inside the sanitizer's 64-detection ceiling for a 32-frame sample
 * without silently dropping late frames. Nothing here decides anything
 * downstream: the action candidate stays a CANDIDATE and the service
 * forces review for every real pretrained contribution.
 */

const PRODUCTS_PER_FRAME = 2;
const HANDS_PER_FRAME = 1;
/** Minimum intersection-over-union for "product in hand". Tiny: a hand
 *  usually covers a sliver of the product box, and either center being
 *  inside the other box also qualifies. */
const IN_HAND_MIN_IOU = 0.05;

export interface DetectorNormalizationInput {
  frames: DetectorFrameResult[];
  /** Whether the model has at least one class mapped to HAND — a COCO
   *  model does not, so it can never emit a hand signal. */
  handRoleSupported: boolean;
  cropQuality: {
    sharpness: number | null;
    occlusion: number | null;
    brightness: number | null;
  };
}

export interface DetectorNormalizationOutput {
  detections: NormalizedDetection[];
  handSignal: HandSignalSummary | null;
  objectDisappeared: boolean | null;
  objectAppeared: boolean | null;
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

export function normalizeDetectorFrames(
  input: DetectorNormalizationInput,
): DetectorNormalizationOutput {
  const frames = [...input.frames].sort((a, b) => a.timestampMs - b.timestampMs);
  const detections: NormalizedDetection[] = [];
  const productPresentByFrame: boolean[] = [];
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
        quality: {
          sharpness: input.cropQuality.sharpness,
          occlusion: input.cropQuality.occlusion,
          brightness: input.cropQuality.brightness,
        },
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

  const presence = deriveObjectPresenceChange(productPresentByFrame);

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
            ? Math.max(0, lastContactMs - firstContactMs)
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

  return {
    detections,
    handSignal,
    objectDisappeared: presence.objectDisappeared,
    objectAppeared: presence.objectAppeared,
    notes,
  };
}

/** Convenience over a whole runtime result: reads the HAND role support
 *  from the model descriptor. */
export function normalizeDetectorResult(
  result: Pick<LocalDetectorResult, 'frames' | 'model'>,
  cropQuality: DetectorNormalizationInput['cropQuality'],
): DetectorNormalizationOutput {
  return normalizeDetectorFrames({
    frames: result.frames,
    handRoleSupported: (result.model?.roleClassCounts.HAND ?? 0) > 0,
    cropQuality,
  });
}
