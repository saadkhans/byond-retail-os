/**
 * Phase 10 pre-storage frame-text recognition contract. Implementations
 * receive DECODED FRAME BYTES (an in-memory image produced by the
 * extraction port — never a path, never the video container) and return the
 * text visible in the frame so the upload pipeline can screen it with the
 * SAME fused free-text predicate that guards every other persisted surface
 * (Luhn-wins PAN windows, credential fragments, fused labels). Two adapters
 * exist: a deterministic simulated recognizer (default — dev/test need no
 * OCR tooling; it never reads the pixels) and an OPTIONAL local
 * system-binary adapter behind an env opt-in, mirroring the extraction
 * port's adapter split exactly.
 */

/** Controlled failure: the configured recognizer cannot run on this host. */
export class FrameTextRecognizerUnavailableError extends Error {
  constructor() {
    // No binary names, paths, or stderr — a controlled, generic message.
    super('The configured frame text recognizer is not available on this host');
    this.name = 'FrameTextRecognizerUnavailableError';
  }
}

/**
 * Controlled failure: the recognition TOOLING could not run to completion —
 * killed (timeout or external signal), refused by the OS (EACCES, EAGAIN,
 * ENOMEM, ...), or its output overran the parent's buffer cap. Says
 * NOTHING about the frame itself, so callers must treat it as
 * transient/retryable and must never take it as a screening verdict.
 */
export class FrameTextRecognitionInfrastructureError extends Error {
  constructor() {
    // No binary names, signals, errno values, or paths — controlled message.
    super('Frame text recognition is temporarily unavailable; retry later');
    this.name = 'FrameTextRecognitionInfrastructureError';
  }
}

/**
 * Controlled failure: the tool RAN and reported it could not process the
 * frame (numeric exit code). Distinct from the infrastructure class so
 * callers can tell "the tool never got to judge the frame" from "the tool
 * judged the frame unprocessable" — but for PRE-STORAGE screening both
 * directions FAIL CLOSED: an unreadable frame is an incomplete screen,
 * never a pass.
 */
export class FrameTextRecognitionFailedError extends Error {
  constructor() {
    super('The frame could not be processed for text recognition');
    this.name = 'FrameTextRecognitionFailedError';
  }
}

export abstract class FrameTextRecognizerPort {
  /** Opaque adapter key recorded nowhere yet — identifies the strategy. */
  abstract readonly kind: string;

  /**
   * TRUE only when recognize() genuinely reads the supplied frame pixels.
   * The simulated adapter reports false: its result is a deterministic
   * placeholder that ignores the buffer entirely, so any surface whose
   * PURPOSE is screening real pixels (the pre-storage frame screen) must
   * refuse to rely on an adapter that does not read them — "no text found"
   * from a recognizer that never looked would be a blind pass.
   */
  abstract readonly readsRealPixels: boolean;

  /**
   * Cheap, cached check that the underlying tooling can actually run.
   *
   * `readsRealPixels` is a STATIC CAPABILITY CLAIM — "this strategy reads
   * the pixels" — and it stays true even on a host where the OCR binary is
   * missing, non-executable, or broken. A pre-buffer upload gate that
   * trusts the flag alone therefore lets the whole multipart body be
   * buffered before anything discovers there is nothing to screen with.
   * This is the RUNTIME half: it actually invokes the tooling (a trivial
   * version/no-op call) and reports whether it ran.
   *
   * Contract for implementations — identical to the extraction port's:
   * - MEMOIZE the answer for a short TTL, NEGATIVE results included (a
   *   per-request spawn would defeat a cheap gate; an uncached negative
   *   turns a missing binary into a spawn storm).
   * - NEVER throw and never reject: an unusable tool is `false`.
   * - Return a BOOLEAN and nothing else — no paths, argv, errno text, or
   *   stderr may escape through this seam.
   * - It proves the tooling RUNS, never that a frame is clean.
   */
  abstract checkToolingReady(): Promise<boolean>;

  /**
   * Recognize the text visible in one decoded frame image (PNG bytes from
   * the extraction port). Returns the recognized text — possibly empty —
   * and NEVER persists or logs the frame or the text.
   */
  abstract recognize(frame: Buffer): Promise<string>;
}
