/**
 * TIER-1 VOCABULARY — tracking metadata, and nothing else.
 *
 * ARCHITECTURE.md draws the line this file enforces: continuous
 * lightweight tracking "produces tracking metadata, never product
 * decisions". Every type here therefore describes WHERE something moved
 * and WHETHER a zone looks occupied — never WHICH product, never a SKU, a
 * catalog id, a candidate list, or a confidence attached to an identity.
 *
 * Product identity is tier 3 and lives in the API (pickup fusion, the
 * visual retriever, the VLM verifier). If a field describing a product
 * ever appears in this file, the pipeline has stopped proposing moments
 * and started deciding outcomes — `tracking.no-product-decision.spec.ts`
 * fails on exactly that.
 */

/**
 * A box in NORMALIZED frame coordinates (0..1 of width/height), so a
 * downscale change never invalidates a stored zone or a recorded region.
 * Origin is top-left, matching the decoded frame buffer's row order.
 */
export interface NormalizedBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A contiguous area whose pixels changed materially between frames. */
export interface MotionRegion {
  box: NormalizedBox;
  /**
   * Fraction of the region's pixels that changed (0..1). An INTENSITY of
   * change, not a likelihood that anything in particular happened.
   */
  intensity: number;
}

/**
 * Coarse presence signals. Deliberately boolean-with-confidence rather
 * than a bounding box per person: tier 1 runs continuously on every frame
 * and must stay cheap, and downstream only needs "is someone at the
 * shelf" to decide whether a moment is worth a heavy look.
 */
export interface PresenceSignal {
  personLikely: boolean;
  handLikely: boolean;
  /** 0..1 — confidence in the PRESENCE call, never in an identity. */
  confidence: number;
}

/** How occupied one configured shelf zone looks in this frame. */
export interface ZoneOccupancy {
  /** Operator-assigned zone code (e.g. a planogram cell). Opaque here. */
  zoneCode: string;
  occupied: boolean;
  /** 0..1 — fraction of the zone's area showing motion this frame. */
  coverage: number;
}

/**
 * One tier-1 observation: the complete output of tracking for one sampled
 * frame. Serialisable, small, and free of media — an observation may be
 * logged and queued, so it may never carry pixels, paths or URLs.
 */
export interface TrackingObservation {
  /** Monotonic index within the current tracking run. */
  frameIndex: number;
  capturedAt: Date;
  /** 0..1 — fraction of the whole frame that changed. */
  motionRatio: number;
  motionRegions: MotionRegion[];
  presence: PresenceSignal;
  zones: ZoneOccupancy[];
}

/** A configured shelf zone the tracker measures occupancy against. */
export interface ShelfZone {
  zoneCode: string;
  box: NormalizedBox;
}

/** Clamps a value into 0..1, keeping every published ratio well-formed. */
export function clampUnit(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Fraction of `box` that `region` covers, in normalized coordinates. */
export function overlapFraction(
  box: NormalizedBox,
  region: NormalizedBox,
): number {
  const left = Math.max(box.x, region.x);
  const top = Math.max(box.y, region.y);
  const right = Math.min(box.x + box.width, region.x + region.width);
  const bottom = Math.min(box.y + box.height, region.y + region.height);
  if (right <= left || bottom <= top) {
    return 0;
  }
  const area = box.width * box.height;
  if (area <= 0) {
    return 0;
  }
  return clampUnit(((right - left) * (bottom - top)) / area);
}
