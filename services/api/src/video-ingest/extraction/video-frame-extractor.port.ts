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

/**
 * Controlled failure: the decoded frame did not fit the CALLER-supplied
 * byte cap (ExtractFrameAtOptions.maxBytes) — the cap the caller chose,
 * not the adapter's own per-invocation ceiling. Distinct from
 * ExtractionInfrastructureError (which the same low-level overflow maps to
 * when the adapter's OWN ceiling fired) so a caller running a deliberately
 * tight budget — the screening preview shrinking its per-response
 * allowance — can treat the overflow as "this frame doesn't fit, skip it"
 * instead of a retryable infrastructure failure.
 */
export class FrameExceedsBudgetError extends Error {
  constructor() {
    super('The decoded frame exceeds the caller-supplied byte budget');
    this.name = 'FrameExceedsBudgetError';
  }
}

export interface ExtractFrameAtOptions {
  /**
   * Optional decoded-byte cap for THIS invocation, always clamped by the
   * adapter's own per-invocation ceiling. When the decoded frame cannot
   * fit under a supplied cap the adapter throws FrameExceedsBudgetError
   * (never a partial frame), letting budgeted callers skip the frame.
   */
  maxBytes?: number;
}

/**
 * One IN-MEMORY inspection of unstored bytes — the seam behind the
 * pre-storage upload frame screen. The session is opened from a Buffer
 * (never a storage key: the whole point is that the unscreened bytes have
 * NOT touched durable storage and never will before the screen passes),
 * exposes the probe result plus frame extraction over the same bytes, and
 * MUST be closed in every path. An implementation that needs a real file
 * (a system-binary adapter) materializes an EPHEMERAL scratch file outside
 * durable storage and removes it on close(); a close failure surfaces as
 * the adapter's infrastructure classification so callers fail closed
 * rather than leaving unscreened bytes behind. A crash that skips close()
 * entirely (SIGKILL, host restart) is recovered lazily: such an adapter
 * sweeps its own abandoned scratch dirs before opening the next session.
 */
export interface BufferInspectionSession {
  /** Probe of the in-memory bytes (already validated/bounded). */
  readonly probe: VideoProbeResult;

  /** Extract one frame from the inspected bytes (same error contract as
   *  extractFrameAt: FrameUnavailableError past the last decodable frame,
   *  budget/infrastructure/content errors as on the storage-key path). */
  extractFrameAt(
    timestampMs: number,
    options?: ExtractFrameAtOptions,
  ): Promise<ExtractedImage>;

  /** Release every ephemeral resource. Idempotent; MUST run in every
   *  path (success, screening hit, and failure alike). */
  close(): Promise<void>;
}

export abstract class VideoFrameExtractorPort {
  /** Opaque adapter key recorded nowhere yet — identifies the strategy. */
  abstract readonly kind: string;

  /**
   * TRUE only when probe/extract genuinely read the stored media bytes.
   * The simulated adapter reports false: its probe and frames are
   * deterministic placeholders that ignore the storage key entirely, so
   * any surface whose PURPOSE is human inspection of the real bytes (the
   * quarantine screening preview) must refuse to serve from an adapter
   * that does not read them — a screener approving footage over
   * placeholder images would be a blind attestation.
   */
  abstract readonly readsRealBytes: boolean;

  abstract probe(storageKey: string): Promise<VideoProbeResult>;

  /**
   * Open an inspection session over IN-MEMORY bytes that must not reach
   * durable storage before screening (see BufferInspectionSession). A
   * probe failure inside the open cleans up any ephemeral resources
   * before rethrowing — the caller only owns close() once the session
   * exists.
   */
  abstract inspectBuffer(data: Buffer): Promise<BufferInspectionSession>;

  abstract extractFrames(
    storageKey: string,
    probe: VideoProbeResult,
    options: FrameExtractionOptions,
  ): Promise<ExtractedImage[]>;

  abstract extractFrameAt(
    storageKey: string,
    probe: VideoProbeResult,
    timestampMs: number,
    options?: ExtractFrameAtOptions,
  ): Promise<ExtractedImage>;

  abstract extractCrop(
    storageKey: string,
    probe: VideoProbeResult,
    timestampMs: number,
    box: CropBox,
  ): Promise<ExtractedImage>;
}
