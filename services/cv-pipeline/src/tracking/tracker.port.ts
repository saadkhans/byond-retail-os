import { RgbFrame } from './frame-source.port';
import { TrackingObservation } from './tracking.types';

/**
 * TIER 1. Turns a downscaled frame into tracking metadata.
 *
 * Swappable by design: the deterministic tracker in this package keeps
 * CI free of model weights, a frame-difference tracker covers the pilot,
 * and a future adapter can drive a Python worker exactly as the API's
 * `python-yolo-worker.runner.ts` does — all behind this interface, none
 * of them visible to the trigger layer.
 *
 * A tracker MUST NOT emit a product identity. See `tracking.types.ts`.
 */
export abstract class TrackerPort {
  /** Opaque strategy key for metrics. Never a vendor or model name. */
  abstract readonly kind: string;

  /**
   * Observe one frame. Stateful by nature — motion is a comparison
   * against what came before — so implementations keep their own
   * previous-frame state and `reset()` clears it.
   *
   * Returns null when the tracker has no opinion yet (the first frame of
   * a run has nothing to compare against). A null observation is not an
   * error and must not be counted as one.
   */
  abstract observe(frame: RgbFrame, frameIndex: number): TrackingObservation | null;

  /** Forget prior frames. Called when a run starts or a source reconnects,
   *  so a gap in the stream cannot read as a frame full of motion. */
  abstract reset(): void;
}
