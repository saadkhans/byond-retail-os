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

/**
 * Controlled failure: the source could not be read as a video. The optional
 * message MUST be a fixed, controlled string (never interpolated stderr,
 * paths, or metadata) — used by the in-memory inspection path to say the
 * container layout is unstreamable without echoing anything attacker-tinted.
 */
export class ExtractionFailedError extends Error {
  constructor(message = 'The video could not be processed') {
    super(message);
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

/**
 * Controlled failure: the exhaustive decode produced MORE frames than the
 * caller's maxFrames cap allows. The message is fixed and echoes no counts
 * or caps — the caller (the pre-storage screen) owns the audited verdict.
 * Distinct from FrameExceedsBudgetError (a per-frame BYTE verdict) so the
 * service can record "too many frames to screen" as its own fail-closed
 * rejection reason.
 */
export class FrameCountExceededError extends Error {
  constructor() {
    super('The decoded frame count exceeds the caller-supplied frame cap');
    this.name = 'FrameCountExceededError';
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
 * NOT touched durable storage) and is IN-MEMORY ONLY: no implementation may
 * materialize the unscreened bytes on ANY disk — not the storage root, not
 * an OS temp dir. A system-binary adapter feeds the bytes to its tooling
 * over stdin/pipes; when pipe-based decoding cannot handle a container
 * layout (a non-faststart MP4 with the moov atom at the end cannot be
 * probed from a pipe), the inspection FAILS CLOSED with a controlled
 * ExtractionFailedError — the service rejects the upload rather than ever
 * writing unscreened bytes to disk. close() releases the in-memory
 * references and is trivially idempotent (there is no disk state to
 * recover; a crash leaks nothing).
 */
export interface BufferInspectionSession {
  /** Probe the in-memory bytes. Memoized: repeated calls never re-run the
   *  tooling. Failure classification matches the storage-key probe, except
   *  that a tool-ran-and-refused outcome is reported as a controlled
   *  unstreamable/unsupported-container content failure. */
  probe(): Promise<VideoProbeResult>;

  /**
   * EXHAUSTIVE decode: emit EVERY decoded source frame (no fps filter, no
   * sampling of any kind) in a single pass over the in-memory bytes,
   * returning the encoded frames in decode order. Sampling would let
   * content visible only BETWEEN samples reach storage unscreened — the
   * exhaustive stream is the screening contract. Enforces
   * options.maxBytesPerFrame per frame (violation →
   * FrameExceedsBudgetError) and options.maxFrames on the total (violation
   * → FrameCountExceededError; the adapter prefers stopping early by
   * capping its output buffer near (maxFrames+1)×frame budget so a runaway
   * stream trips the budget classification instead of buffering unbounded
   * output). A successful decode yielding FEW frames returns what it
   * yielded — SUFFICIENCY is the SERVICE's verdict (it holds the probe and
   * the configured screening budget); only zero frames from a successful
   * decode is FrameUnavailableError. Infrastructure failures classify
   * exactly as on the storage-key paths.
   */
  extractAllFrames(options: {
    maxFrames: number;
    maxBytesPerFrame: number;
  }): Promise<Buffer[]>;

  /** Release every in-memory reference. Idempotent; MUST run in every
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
   * ANY disk before screening (see BufferInspectionSession). Opening never
   * runs tooling — the first probe()/extract call does — so the caller
   * always owns close() once the session exists.
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
