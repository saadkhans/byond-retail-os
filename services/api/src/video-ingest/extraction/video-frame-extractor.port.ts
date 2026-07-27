/**
 * Phase 10 frame/crop extraction contract. Implementations receive an
 * INTERNAL storage key (never a user-supplied path) and return image bytes
 * plus honest dimensions; the service owns checksums, persistence, and
 * artifact rows. Two adapters exist in Phase 10: a deterministic simulated
 * extractor (default — dev/test need no media tooling) and an OPTIONAL
 * local system-binary adapter behind an env opt-in. Production
 * streaming/tracking runtimes are later phases behind this same port.
 */

export interface VideoProbeResult {
  durationMs: number;
  width: number;
  height: number;
  fps: number;
}

export interface CropBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FrameExtractionOptions {
  /** Sampling interval between frames (ms). */
  intervalMs: number;
  /** Hard cap on extracted frames (service-enforced ceiling). */
  maxFrames: number;
  /** Start offset into the video (ms). */
  startMs: number;
}

export interface ExtractedImage {
  data: Buffer;
  width: number;
  height: number;
  mimeType: string;
  timestampMs: number;
}

/** Controlled failure: the configured extractor cannot run on this host. */
export class ExtractorUnavailableError extends Error {
  constructor() {
    // No binary names, paths, or stderr — a controlled, generic message.
    super('The configured video extractor is not available on this host');
    this.name = 'ExtractorUnavailableError';
  }
}

/** Controlled failure: the source could not be read as a video. */
export class ExtractionFailedError extends Error {
  constructor() {
    super('The video could not be processed');
    this.name = 'ExtractionFailedError';
  }
}

/**
 * Controlled failure: the extraction TOOLING could not run to completion —
 * the process was killed (timeout or external signal), the OS refused to
 * spawn or resource it (EACCES, EAGAIN, ENOMEM, EMFILE, ...), or its
 * output overran the parent's buffer cap. Says NOTHING about the video
 * itself, so callers must treat it as transient/retryable (503) and must
 * NOT transition the asset to REJECTED or FAILED — distinct from
 * ExtractionFailedError, where the tool ran and reported the content
 * unreadable.
 */
export class ExtractionInfrastructureError extends Error {
  constructor() {
    // No binary names, signals, errno values, or paths — controlled message.
    super('Video processing is temporarily unavailable; retry later');
    this.name = 'ExtractionInfrastructureError';
  }
}

/**
 * Controlled failure: the video is fine but NO frame is decodable at the
 * requested position (a timestamp inside the reported duration can still
 * land after the last decodable frame — real containers routinely report a
 * duration a few hundred ms past the final sample). Distinct from
 * ExtractionFailedError so callers can degrade gracefully: interval
 * sampling stops at end-of-stream instead of failing the whole batch, and
 * an explicit-timestamp request maps to a controlled 400 WITHOUT marking
 * the asset FAILED.
 */
export class FrameUnavailableError extends Error {
  constructor() {
    super('No frame is decodable at the requested position');
    this.name = 'FrameUnavailableError';
  }
}

export abstract class VideoFrameExtractorPort {
  /** Opaque adapter key recorded nowhere yet — identifies the strategy. */
  abstract readonly kind: string;

  abstract probe(storageKey: string): Promise<VideoProbeResult>;

  abstract extractFrames(
    storageKey: string,
    probe: VideoProbeResult,
    options: FrameExtractionOptions,
  ): Promise<ExtractedImage[]>;

  abstract extractFrameAt(
    storageKey: string,
    probe: VideoProbeResult,
    timestampMs: number,
  ): Promise<ExtractedImage>;

  abstract extractCrop(
    storageKey: string,
    probe: VideoProbeResult,
    timestampMs: number,
    box: CropBox,
  ): Promise<ExtractedImage>;
}
