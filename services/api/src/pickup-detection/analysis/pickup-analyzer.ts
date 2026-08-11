/**
 * Phase 10 MVP pickup analysis — CLASSICAL change detection over decoded
 * analysis frames. No neural network runs here; the signals are honest
 * pixel arithmetic:
 *
 * - MOTION TIMELINE: mean absolute RGB difference between consecutive
 *   frames. A pickup (hand enters, grabs, leaves) reads as one sustained
 *   motion bump; the strongest sample inside it is the PEAK.
 * - REMOVAL REGION: per-pixel difference between the pre-event background
 *   (median of the first quiet frames) and the post-event background
 *   (median of the last quiet frames). A removed product leaves exactly one
 *   stable changed region; its bounding box localizes the pickup.
 *
 * Scope-matched to the MVP contract: fixed camera, one person, ONE pickup
 * per clip. The analyzer reports `pickupDetected: false` rather than
 * guessing when the signals do not support that shape (no motion bump, or
 * no stable removal region).
 *
 * Everything here is pure TypeScript over RGB24 buffers — deterministic
 * and unit-testable without any media tooling.
 */

export interface AnalysisFrame {
  /** Zero-based index in the analysis sample stream. */
  index: number;
  /** Position of this sample in the source clip. */
  timestampMs: number;
  /** Tightly packed RGB24 pixels, length = width * height * 3. */
  rgb: Buffer;
}

export interface AnalysisGeometry {
  width: number;
  height: number;
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PickupWindow {
  /** First sample where sustained motion begins. */
  eventStartMs: number;
  /** Sample with the strongest motion inside the window. */
  eventPeakMs: number;
  /** First sample after which motion returns to baseline. */
  eventEndMs: number;
  /** Indexes into the analysis stream for the same three instants. */
  startIndex: number;
  peakIndex: number;
  endIndex: number;
}

export interface PickupAnalysis {
  pickupDetected: boolean;
  /** Present only when pickupDetected. */
  window: PickupWindow | null;
  /** Removal region in ANALYSIS coordinates. Present only when detected. */
  removalBox: BoundingBox | null;
  /** Mean |Δ| motion energy per consecutive-frame pair (index i = frames i-1→i). */
  motionTimeline: number[];
  /**
   * Why detection was refused, for the audit trail / error surface. Fixed
   * vocabulary, never interpolated content.
   */
  rejectReason: 'NO_MOTION_EVENT' | 'NO_REMOVAL_REGION' | 'TOO_FEW_FRAMES' | null;
}

/** Tunables — exported so tests and config can pin them explicitly. */
export interface PickupAnalyzerOptions {
  /**
   * A motion sample counts as "active" above baseline + this fraction of
   * (peak - baseline). 0.25 keeps slow lighting drift below the line while
   * catching the hand's entry/exit ramps.
   */
  activationFraction?: number;
  /** Per-channel |Δ| that marks a background pixel as CHANGED (0..255). */
  removalPixelThreshold?: number;
  /** Quiet frames pooled into each background model. */
  backgroundFrames?: number;
  /** Minimum changed-pixel count for a credible removal region. */
  minRemovalPixels?: number;
  /** Minimum ratio of peak motion to baseline motion for a real event. */
  minPeakToBaselineRatio?: number;
}

const DEFAULTS: Required<PickupAnalyzerOptions> = {
  // 0.12: the hand's entry/exit ramps carry far less motion energy than
  // the grab instant, and a higher fraction cut the walk-back short —
  // the window then started AT the peak and the "quiet before" frames
  // still contained the moving hand.
  activationFraction: 0.12,
  removalPixelThreshold: 40,
  backgroundFrames: 3,
  minRemovalPixels: 12,
  minPeakToBaselineRatio: 3,
};

/**
 * The quiet frames on each side of the event. FROM THE CLIP ENDPOINTS, not
 * window-adjacent: the MVP scope is a fixed camera with ONE pickup per
 * clip, so the opening frames are the canonical "product present" state
 * and the closing frames the canonical "product gone" state — and unlike
 * window-adjacent slices they can never contain the hand even when the
 * detected window under-covers the true event. Frames inside the window
 * are excluded when the event runs into either endpoint.
 */
export function backgroundWindows(
  frames: AnalysisFrame[],
  window: PickupWindow,
  count: number,
): { before: Buffer[]; after: Buffer[] } {
  const before = frames
    .slice(0, Math.max(1, Math.min(count, window.startIndex)))
    .map((frame) => frame.rgb);
  const afterStart = Math.max(window.endIndex + 1, frames.length - count);
  const after = frames.slice(afterStart).map((frame) => frame.rgb);
  return { before, after };
}

/** Mean absolute per-byte difference between two same-length RGB buffers. */
export function meanAbsoluteDifference(a: Buffer, b: Buffer): number {
  const length = Math.min(a.length, b.length);
  if (length === 0) {
    return 0;
  }
  let total = 0;
  for (let index = 0; index < length; index += 1) {
    total += Math.abs(a[index] - b[index]);
  }
  return total / length;
}

/** Per-pixel-channel median across frames — a quiet background model that
 *  a single outlier frame (a hand mid-entry) cannot drag. */
export function medianBackground(frames: Buffer[]): Buffer {
  if (frames.length === 0) {
    return Buffer.alloc(0);
  }
  const length = frames[0].length;
  const out = Buffer.alloc(length);
  const samples = new Array<number>(frames.length);
  for (let index = 0; index < length; index += 1) {
    for (let frame = 0; frame < frames.length; frame += 1) {
      samples[frame] = frames[frame][index];
    }
    samples.sort((left, right) => left - right);
    out[index] = samples[Math.floor(samples.length / 2)];
  }
  return out;
}

/**
 * Bounding box of pixels whose background difference exceeds the threshold
 * in ANY channel. Returns null below `minRemovalPixels` — a handful of
 * noisy pixels is not a removed product.
 */
export function changedRegionBox(
  before: Buffer,
  after: Buffer,
  geometry: AnalysisGeometry,
  pixelThreshold: number,
  minRemovalPixels: number,
): BoundingBox | null {
  let minX = geometry.width;
  let minY = geometry.height;
  let maxX = -1;
  let maxY = -1;
  let changed = 0;
  for (let y = 0; y < geometry.height; y += 1) {
    for (let x = 0; x < geometry.width; x += 1) {
      const offset = (y * geometry.width + x) * 3;
      const delta = Math.max(
        Math.abs(before[offset] - after[offset]),
        Math.abs(before[offset + 1] - after[offset + 1]),
        Math.abs(before[offset + 2] - after[offset + 2]),
      );
      if (delta > pixelThreshold) {
        changed += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (changed < minRemovalPixels || maxX < minX || maxY < minY) {
    return null;
  }
  return {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
}

/**
 * Locate the single sustained motion bump: baseline is the median motion
 * sample; the event is the contiguous run of "active" samples containing
 * the global peak. A flat timeline (peak not clearly above baseline) is NO
 * event — the MVP never invents a pickup out of noise.
 */
export function findMotionWindow(
  motionTimeline: number[],
  frames: AnalysisFrame[],
  options: Required<PickupAnalyzerOptions>,
): PickupWindow | null {
  if (motionTimeline.length < 3) {
    return null;
  }
  const sorted = [...motionTimeline].sort((a, b) => a - b);
  const baseline = sorted[Math.floor(sorted.length / 2)];
  let peakIndex = 0;
  for (let index = 1; index < motionTimeline.length; index += 1) {
    if (motionTimeline[index] > motionTimeline[peakIndex]) {
      peakIndex = index;
    }
  }
  const peak = motionTimeline[peakIndex];
  if (peak <= 0 || peak < baseline * options.minPeakToBaselineRatio) {
    return null;
  }
  const activation = baseline + (peak - baseline) * options.activationFraction;
  let start = peakIndex;
  while (start > 0 && motionTimeline[start - 1] > activation) {
    start -= 1;
  }
  let end = peakIndex;
  while (
    end < motionTimeline.length - 1 &&
    motionTimeline[end + 1] > activation
  ) {
    end += 1;
  }
  // motionTimeline[i] is the transition frames[i] -> frames[i+1]; report
  // the window on SOURCE timestamps (start = the frame the motion enters,
  // end = the frame after it settles).
  return {
    eventStartMs: frames[start].timestampMs,
    eventPeakMs: frames[peakIndex].timestampMs,
    eventEndMs: frames[Math.min(end + 1, frames.length - 1)].timestampMs,
    startIndex: start,
    peakIndex,
    endIndex: Math.min(end + 1, frames.length - 1),
  };
}

export function analyzePickup(
  frames: AnalysisFrame[],
  geometry: AnalysisGeometry,
  options: PickupAnalyzerOptions = {},
): PickupAnalysis {
  const resolved = { ...DEFAULTS, ...options };
  if (frames.length < resolved.backgroundFrames * 2 + 2) {
    return {
      pickupDetected: false,
      window: null,
      removalBox: null,
      motionTimeline: [],
      rejectReason: 'TOO_FEW_FRAMES',
    };
  }
  const motionTimeline: number[] = [];
  for (let index = 1; index < frames.length; index += 1) {
    motionTimeline.push(
      meanAbsoluteDifference(frames[index - 1].rgb, frames[index].rgb),
    );
  }
  const window = findMotionWindow(motionTimeline, frames, resolved);
  if (window === null) {
    return {
      pickupDetected: false,
      window: null,
      removalBox: null,
      motionTimeline,
      rejectReason: 'NO_MOTION_EVENT',
    };
  }
  // Background models from the CLIP ENDPOINTS (see backgroundWindows) so
  // the moving hand can never contaminate either side.
  const { before: beforeFrames, after: afterFrames } = backgroundWindows(
    frames,
    window,
    resolved.backgroundFrames,
  );
  if (beforeFrames.length === 0 || afterFrames.length === 0) {
    return {
      pickupDetected: false,
      window,
      removalBox: null,
      motionTimeline,
      rejectReason: 'NO_REMOVAL_REGION',
    };
  }
  const removalBox = changedRegionBox(
    medianBackground(beforeFrames),
    medianBackground(afterFrames),
    geometry,
    resolved.removalPixelThreshold,
    resolved.minRemovalPixels,
  );
  if (removalBox === null) {
    return {
      pickupDetected: false,
      window,
      removalBox: null,
      motionTimeline,
      rejectReason: 'NO_REMOVAL_REGION',
    };
  }
  return {
    pickupDetected: true,
    window,
    removalBox,
    motionTimeline,
    rejectReason: null,
  };
}
