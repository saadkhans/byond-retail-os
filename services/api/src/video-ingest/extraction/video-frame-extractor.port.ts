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
