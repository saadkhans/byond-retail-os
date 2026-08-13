import { AnalysisFrame, AnalysisGeometry } from './analysis/pickup-analyzer';
import { RgbImage } from './analysis/product-matcher';

/**
 * Repository-owned media-access port for classical-v1 pickup detection and
 * the reference-image flows — STORAGE-KEY-based pixel access, mirroring the
 * fusion pipeline's PickupMediaDecoder contract. Core services hand the
 * port the managed storage key they read from the asset/reference row;
 * resolving that key to a local filesystem path (internalPathFor) — or, for
 * a future object-store deployment, to a download — happens inside the
 * bound adapter alone. Swapping storage providers or the decode tooling is
 * a module-composition change, never an edit to classical-v1 core logic.
 */
export abstract class PickupMediaPort {
  /** Whole-clip downscaled analysis frames at `fps` (or the highest
   *  budget-fitting cadence below it — timestamps carry the truth).
   *  `durationMs` (probed metadata) lets the decode enforce its aggregate
   *  memory budget by downsampling instead of failing a valid asset. */
  abstract decodeAnalysisFrames(
    storageKey: string,
    fps: number,
    geometry: AnalysisGeometry,
    durationMs: number,
  ): Promise<AnalysisFrame[]>;

  /** ONE stored reference image at the matcher's working size. */
  abstract decodeReferenceImage(storageKey: string): Promise<RgbImage>;
}
