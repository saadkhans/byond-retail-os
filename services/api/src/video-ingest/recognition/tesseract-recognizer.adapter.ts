import { execFile } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { Injectable } from '@nestjs/common';
import {
  FrameTextRecognitionFailedError,
  FrameTextRecognitionInfrastructureError,
  FrameTextRecognizerPort,
  FrameTextRecognizerUnavailableError,
} from './frame-text-recognizer.port';

export const TESSERACT_RECOGNIZER_KIND = 'tesseract';

// OPTIONAL system binary resolved from PATH — never an npm dependency,
// never a user-supplied path. The adapter only runs when the operator set
// VIDEO_OCR_ENABLED=true; the simulated recognizer is the default. The
// binary name is CONFINED to this file and the module wiring (pinned by
// the vendor-neutrality spec, exactly like the extraction binaries).
const TESSERACT_BINARY = 'tesseract';

// Recognized text is bounded: a frame of a test clip yields at most a few
// KiB of text, so 1 MiB is generous — the cap exists so a pathological
// output can never balloon the parent process.
export const MAX_RECOGNIZED_TEXT_BYTES = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;

// How long a READINESS answer (see checkToolingReady) stays good — the same
// rationale, and the same value, as the extraction adapter's TTL: a
// pre-buffer upload gate must be cheap, so it cannot spawn a child per
// request, and an unmemoized NEGATIVE would turn one missing binary into a
// spawn storm of one failed exec per rejected upload.
export const TOOLING_READY_TTL_MS = 60_000;

// The readiness probe now runs a REAL recognition pass over a synthetic
// image (see below), so its ceiling has to cover loading the default
// language data once on a cold page cache — a bare version banner did not.
// It is still an order of magnitude under the recognition ceiling: a host
// that cannot initialize its OCR language data and read a 32x32 blank image
// in this long cannot screen inside a request either, and the memoized
// answer means at most one such wait per TTL.
export const TOOLING_READY_TIMEOUT_MS = 5_000;

// The probe image is blank, so a correct tool emits a handful of bytes; the
// cap bounds a hostile PATH entry. An overrun rejects, which reads as NOT
// ready (fail-closed). The output itself is never inspected.
const TOOLING_READY_MAX_OUTPUT_BYTES = 64 * 1024;

/**
 * Fixed argument vector: the frame bytes travel over STDIN and the text
 * comes back over STDOUT, so the pixels NEVER touch a disk path, no temp
 * file exists to clean or leak, and no user-influenced value ever becomes
 * an argument. No language flag is passed, so the tool resolves its DEFAULT
 * language data — which is precisely the configuration readiness must
 * exercise. Exported for tests.
 */
export function buildRecognizeArgs(): string[] {
  return ['stdin', 'stdout'];
}

/**
 * The READINESS vector is the RECOGNITION vector — deliberately, and by
 * construction rather than by copied literals.
 *
 * A `--version` probe exits zero on a host whose default language data is
 * missing or unreadable, which is the single most likely real-world OCR
 * misconfiguration. The gate would then admit the upload, multer would
 * buffer the whole file, and the first genuine `recognize()` call would be
 * what finally failed — exactly the pre-buffer gate this exists to enforce,
 * defeated. Driving the SAME argv over the SAME stdin/stdout wiring means
 * the probe fails in every way a real recognition would.
 *
 * Exported for tests.
 */
export function buildToolingReadyArgs(): string[] {
  return buildRecognizeArgs();
}

/**
 * ---------------------------------------------------------------------
 * The readiness probe's input image.
 *
 * SYNTHETIC AND GENERATED IN MEMORY — never sample media, never a fixture
 * on disk, never anything checked into the repository. It is a blank white
 * 32x32 8-bit greyscale image hand-assembled here from the format's own
 * primitives (a length/type/payload/CRC32 chunk stream, the pixel rows
 * deflated with Node's built-in compressor), so the probe needs no image
 * library, no new dependency, and no file the media policy would have to
 * reason about.
 *
 * Blank on purpose: readiness asks whether the tool INITIALIZES and RUNS.
 * The recognized text is irrelevant and is never read, so the image carries
 * no glyphs to recognize and nothing to assert about.
 * ---------------------------------------------------------------------
 */
const PROBE_IMAGE_EDGE_PIXELS = 32;

/** Table-driven CRC32 (the checksum the chunk format specifies), built once
 *  on first use. Inline so no dependency is added for eight lines of math. */
let crcTable: Uint32Array | null = null;

function crc32(bytes: Buffer): number {
  if (crcTable === null) {
    const table = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      table[index] = value >>> 0;
    }
    crcTable = table;
  }
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** One length-prefixed, CRC-suffixed chunk. */
function buildImageChunk(type: string, payload: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length, 0);
  const typedPayload = Buffer.concat([Buffer.from(type, 'ascii'), payload]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(typedPayload), 0);
  return Buffer.concat([length, typedPayload, checksum]);
}

function buildProbeImage(): Buffer {
  const edge = PROBE_IMAGE_EDGE_PIXELS;

  // The 8-byte format signature.
  const signature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);

  // Header: dimensions, 8 bits per sample, greyscale, deflate compression,
  // adaptive filtering, no interlacing.
  const header = Buffer.alloc(13);
  header.writeUInt32BE(edge, 0);
  header.writeUInt32BE(edge, 4);
  header.writeUInt8(8, 8);
  header.writeUInt8(0, 9);
  header.writeUInt8(0, 10);
  header.writeUInt8(0, 11);
  header.writeUInt8(0, 12);

  // Every row is a filter-type byte followed by its samples; 0xff fills the
  // samples (white) and each row's leading byte is reset to filter type 0
  // ("None"), so no row references another and the bytes stay trivial.
  const stride = edge + 1;
  const rows = Buffer.alloc(edge * stride, 0xff);
  for (let row = 0; row < edge; row += 1) {
    rows[row * stride] = 0x00;
  }

  return Buffer.concat([
    signature,
    buildImageChunk('IHDR', header),
    buildImageChunk('IDAT', deflateSync(rows)),
    buildImageChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Built at most ONCE per process, and only if a readiness probe actually
 *  runs — the simulated recognizer is the default, so most processes never
 *  pay for it at all. */
let probeImage: Buffer | null = null;

/** The synthetic probe image, generated on first use. Exported for tests so
 *  the spec can assert it is a plausible minimal image and nothing more. */
export function toolingReadyProbeImage(): Buffer {
  if (probeImage === null) {
    probeImage = buildProbeImage();
  }
  return probeImage;
}

/** Error shape execFile produces: exit failures carry a NUMERIC code, spawn/
 *  OS failures a STRING errno, kills a signal/killed flag. */
interface CommandError {
  code?: string | number | null;
  killed?: boolean;
  signal?: string | null;
  message?: string;
}

/**
 * Classify a child-process failure the same way the extraction adapter
 * does, so INFRASTRUCTURE problems stay retryable and are never mistaken
 * for a screening verdict:
 *
 * - Missing binary (spawn ENOENT) → FrameTextRecognizerUnavailableError.
 * - Killed process (timeout/external signal) →
 *   FrameTextRecognitionInfrastructureError.
 * - Output overran maxBuffer → FrameTextRecognitionInfrastructureError.
 * - Any other STRING errno (EACCES, EAGAIN, ENOMEM, ...) →
 *   FrameTextRecognitionInfrastructureError.
 * - NUMERIC exit code (the tool RAN and reported failure) or an unknown
 *   error shape → FrameTextRecognitionFailedError.
 *
 * Exported for tests; never echoes stderr, signals, errno values, or paths.
 */
export function classifyRecognizerError(error: unknown): Error {
  const failure = (error ?? {}) as CommandError;
  if (failure.code === 'ENOENT') {
    return new FrameTextRecognizerUnavailableError();
  }
  if (failure.killed === true || typeof failure.signal === 'string') {
    return new FrameTextRecognitionInfrastructureError();
  }
  if (
    failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ||
    (typeof failure.message === 'string' &&
      failure.message.includes('maxBuffer'))
  ) {
    return new FrameTextRecognitionInfrastructureError();
  }
  if (typeof failure.code === 'string') {
    return new FrameTextRecognitionInfrastructureError();
  }
  return new FrameTextRecognitionFailedError();
}

type RunCommand = (
  binary: string,
  args: string[],
  stdinData: Buffer,
  maxOutputBytes: number,
  /** Wall-clock kill timeout for THIS invocation. Absent means the
   *  adapter's own fixed ceiling (COMMAND_TIMEOUT_MS) — recognition passes
   *  nothing; only the cheap readiness probe tightens it. */
  timeoutMs?: number,
) => Promise<{ stdout: Buffer }>;

const defaultRunCommand: RunCommand = (
  binary,
  args,
  stdinData,
  maxOutputBytes,
  timeoutMs,
) =>
  new Promise((resolvePromise, rejectPromise) => {
    const child = execFile(
      binary,
      args,
      {
        encoding: 'buffer',
        maxBuffer: maxOutputBytes,
        timeout: timeoutMs ?? COMMAND_TIMEOUT_MS,
        windowsHide: true,
        // No shell: arguments reach the binary as a vector, so no value can
        // be reinterpreted as shell syntax.
        shell: false,
      },
      (error, stdout) => {
        if (error) {
          rejectPromise(error);
          return;
        }
        resolvePromise({ stdout });
      },
    );
    // The tool may exit before consuming stdin (bad input, missing language
    // data): an unhandled EPIPE on the write side would crash the parent,
    // so stream errors are swallowed — the exec callback carries the real
    // verdict either way.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(stdinData);
  });

/**
 * OPTIONAL local frame-text recognition via the system OCR binary. Command
 * execution is injectable so tests never spawn a process; failures map to
 * controlled errors that never echo stderr, binary names, or paths. The
 * frame is fed over stdin — decoded pixels never touch the filesystem.
 */
@Injectable()
export class TesseractFrameTextRecognizer extends FrameTextRecognizerPort {
  readonly kind = TESSERACT_RECOGNIZER_KIND;

  // Text comes from reading the supplied frame pixels — pixel-screening
  // surfaces (the pre-storage frame screen) may rely on this adapter.
  readonly readsRealPixels = true;

  /**
   * The memoized readiness answer and when it was taken, per ADAPTER
   * INSTANCE (the module registers one, so it is process-wide in practice
   * without a module-level global tests would have to reset).
   */
  private toolingReadyCache: { ready: boolean; checkedAtMs: number } | null =
    null;

  /** The in-flight check, so a burst on a cold cache costs ONE exec. */
  private toolingReadyInFlight: Promise<boolean> | null = null;

  constructor(private readonly runCommand: RunCommand = defaultRunCommand) {
    super();
  }

  /**
   * Does the OCR tooling ACTUALLY run on this host? `readsRealPixels` only
   * says this strategy reads pixels when it works — with VIDEO_OCR_ENABLED=
   * true and no OCR binary installed the flag is still true, so a gate keyed
   * on it alone buffers an entire upload before anything fails. This runs
   * the binary, on the same argv and the same stdin/stdout wiring a real
   * recognition uses, over a synthetic in-memory image — so an installed
   * binary whose DEFAULT LANGUAGE DATA is missing or unreadable is caught
   * here rather than after multer has buffered the upload.
   *
   * MEMOIZED for TOOLING_READY_TTL_MS — negatives included. Never throws:
   * every failure shape (ENOENT, EACCES, nonzero exit, timeout kill, output
   * overrun, a runner rejecting with anything at all) is simply NOT READY.
   * The error is DISCARDED unexamined, so no path, argv, errno, or stderr
   * can escape through this seam — the answer is a bare boolean and the
   * caller composes the controlled message.
   *
   * Readiness says the TOOLING RUNS — it initialized its language data and
   * completed a recognition pass. It says nothing about any frame, and the
   * text the probe produced is never inspected: a ready recognizer that
   * reports no text on a real frame has still proved nothing.
   */
  checkToolingReady(): Promise<boolean> {
    const cached = this.toolingReadyCache;
    if (
      cached !== null &&
      Date.now() - cached.checkedAtMs < TOOLING_READY_TTL_MS
    ) {
      return Promise.resolve(cached.ready);
    }
    if (this.toolingReadyInFlight !== null) {
      return this.toolingReadyInFlight;
    }
    const check = this.runToolingReadyProbe()
      // Belt and braces: the probe already converts every rejection to
      // `false`; this guarantees the handed-out promise cannot reject.
      .catch(() => false)
      .then((ready) => {
        this.toolingReadyCache = { ready, checkedAtMs: Date.now() };
        this.toolingReadyInFlight = null;
        return ready;
      });
    this.toolingReadyInFlight = check;
    return check;
  }

  /** One uncached readiness pass. Never rejects. */
  private async runToolingReadyProbe(): Promise<boolean> {
    try {
      await this.runCommand(
        TESSERACT_BINARY,
        buildToolingReadyArgs(),
        // A synthetic, generated image — never sample media. Feeding a real
        // decodable image over stdin is what forces the tool to initialize
        // its default language data, which is the whole point of the probe.
        toolingReadyProbeImage(),
        TOOLING_READY_MAX_OUTPUT_BYTES,
        TOOLING_READY_TIMEOUT_MS,
      );
      // Exit zero is the ENTIRE verdict. The resolved stdout is discarded
      // unread: what the tool "recognized" in a blank image says nothing,
      // and inspecting or logging it would put tool output on a path that
      // must only ever carry a bare boolean.
      return true;
    } catch {
      // Deliberately UNBOUND: the error is never read, let alone returned
      // or logged. Missing binary, non-executable, unreadable or absent
      // language data (a nonzero exit), killed, output overrun — all of it
      // is one word: not ready.
      return false;
    }
  }

  async recognize(frame: Buffer): Promise<string> {
    try {
      const { stdout } = await this.runCommand(
        TESSERACT_BINARY,
        buildRecognizeArgs(),
        frame,
        MAX_RECOGNIZED_TEXT_BYTES,
      );
      return stdout.toString('utf8');
    } catch (error) {
      throw classifyRecognizerError(error);
    }
  }
}
