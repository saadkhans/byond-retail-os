import { ShelfZone } from './tracking.types';

/**
 * Where downscaled frames come from. A port so the camera is swappable:
 * AGENTS.md forbids hardcoding a hardware vendor, and ARCHITECTURE.md
 * puts every external system behind an interface this repository owns.
 *
 * Implementations hand back RAW RGB24 pixels at the requested geometry.
 * The pipeline never stores them, never forwards them, and never writes
 * them to a log or a job descriptor — tier 1 turns pixels into numbers
 * and drops the pixels.
 */

/** Controlled failure vocabulary. NOTHING outside this list ever escapes
 *  a frame source: a message carrying the configured input would leak the
 *  camera address, which `rtsp-frame-sampler.ts` in the API treats as the
 *  contract of the module and so does this one. */
export const FRAME_SOURCE_ERROR_CODES = [
  'SOURCE_NOT_CONFIGURED',
  'SOURCE_CREDENTIALS_UNSUPPORTED',
  'SOURCE_CONNECT_FAILED',
  'FRAME_DECODE_FAILED',
  'FRAME_TIMEOUT',
  'TOOLING_UNAVAILABLE',
] as const;
export type FrameSourceErrorCode = (typeof FRAME_SOURCE_ERROR_CODES)[number];

/** One decoded frame: packed RGB24, row-major, `width * height * 3` bytes. */
export interface RgbFrame {
  data: Buffer;
  width: number;
  height: number;
  capturedAt: Date;
}

export type FrameResult =
  | { ok: true; frame: RgbFrame }
  | { ok: false; code: FrameSourceErrorCode };

export interface FrameSourceOptions {
  width: number;
  height: number;
  timeoutMs: number;
  /**
   * Position within a FILE-BACKED development source. A live camera has
   * no seekable timeline and ignores this; without it a file source
   * returns frame zero forever and tracking sees no motion at all.
   */
  seekMs?: number;
}

export abstract class FrameSourcePort {
  /** Opaque strategy key for metrics and logs. Never a vendor name. */
  abstract readonly kind: string;

  /**
   * TRUE only when this source decodes real camera or file bytes. The
   * simulated source reports false, so any operator surface that implies
   * "this is what the camera sees" can refuse to speak for it.
   */
  abstract readonly readsRealBytes: boolean;

  /** Cheap, memoized check that the underlying tooling can run at all.
   *  Never throws: an unusable tool is `false`, not an error. */
  abstract checkReady(): Promise<boolean>;

  abstract sample(options: FrameSourceOptions): Promise<FrameResult>;
}

/**
 * What the tracker needs to know about the scene. Supplied by
 * configuration, never discovered from pixels — zone geometry is an
 * operator decision that belongs with the planogram, not with tracking.
 */
export interface TrackerContext {
  zones: ShelfZone[];
}
