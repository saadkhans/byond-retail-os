import { execFile } from 'node:child_process';
import { Injectable } from '@nestjs/common';
import { VideoStoragePort } from '../storage/video-storage.port';
import {
  CropBox,
  ExtractedImage,
  ExtractionFailedError,
  ExtractorUnavailableError,
  FrameExtractionOptions,
  VideoFrameExtractorPort,
  VideoProbeResult,
} from './video-frame-extractor.port';

export const FFMPEG_EXTRACTOR_KIND = 'ffmpeg';

// OPTIONAL system binaries resolved from PATH — never an npm dependency,
// never a user-supplied path. The adapter only runs when the operator set
// VIDEO_FFMPEG_ENABLED=true; the simulated extractor is the default.
const FFMPEG_BINARY = 'ffmpeg';
const FFPROBE_BINARY = 'ffprobe';

// Decoded PNG frames are bounded (a single 4K PNG is well under this); the
// cap exists so a hostile container cannot balloon the parent process.
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;

/** Integers only — a non-integer here means a validation layer was skipped. */
function assertBoundedInt(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 2_147_483_647) {
    throw new ExtractionFailedError();
  }
  void field;
  return value;
}

/**
 * Argument builders are PURE and exported for tests: every numeric value is
 * asserted to be a bounded non-negative integer before it becomes an
 * argument, arguments are passed as a vector to execFile (NO shell, no
 * string interpolation into a command line), and the only path argument is
 * the storage adapter's root-confined internal path.
 */
export function buildProbeArgs(internalPath: string): string[] {
  return [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    '-select_streams',
    'v:0',
    internalPath,
  ];
}

export function buildFrameArgs(
  internalPath: string,
  timestampMs: number,
): string[] {
  const ts = assertBoundedInt(timestampMs, 'timestampMs');
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-ss',
    (ts / 1000).toFixed(3),
    '-i',
    internalPath,
    '-frames:v',
    '1',
    '-f',
    'image2pipe',
    '-vcodec',
    'png',
    'pipe:1',
  ];
}

export function buildCropArgs(
  internalPath: string,
  timestampMs: number,
  box: CropBox,
): string[] {
  const ts = assertBoundedInt(timestampMs, 'timestampMs');
  const width = assertBoundedInt(box.width, 'width');
  const height = assertBoundedInt(box.height, 'height');
  const x = assertBoundedInt(box.x, 'x');
  const y = assertBoundedInt(box.y, 'y');
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-ss',
    (ts / 1000).toFixed(3),
    '-i',
    internalPath,
    '-frames:v',
    '1',
    '-vf',
    `crop=${width}:${height}:${x}:${y}`,
    '-f',
    'image2pipe',
    '-vcodec',
    'png',
    'pipe:1',
  ];
}

interface ProbeStream {
  width?: number;
  height?: number;
  r_frame_rate?: string;
  duration?: string;
}

interface ProbeOutput {
  streams?: ProbeStream[];
  format?: { duration?: string };
}

export function parseProbeOutput(stdout: string): VideoProbeResult {
  let parsed: ProbeOutput;
  try {
    parsed = JSON.parse(stdout) as ProbeOutput;
  } catch {
    throw new ExtractionFailedError();
  }
  const stream = parsed.streams?.[0];
  const durationSeconds = Number(
    stream?.duration ?? parsed.format?.duration ?? Number.NaN,
  );
  const width = stream?.width ?? 0;
  const height = stream?.height ?? 0;
  const [num, den] = (stream?.r_frame_rate ?? '').split('/').map(Number);
  const fps = num && den ? num / den : Number.NaN;
  if (
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    !Number.isInteger(width) ||
    width <= 0 ||
    !Number.isInteger(height) ||
    height <= 0 ||
    !Number.isFinite(fps) ||
    fps <= 0
  ) {
    throw new ExtractionFailedError();
  }
  return {
    durationMs: Math.round(durationSeconds * 1000),
    width,
    height,
    fps,
  };
}

type RunCommand = (
  binary: string,
  args: string[],
) => Promise<{ stdout: Buffer }>;

const defaultRunCommand: RunCommand = (binary, args) =>
  new Promise((resolvePromise, rejectPromise) => {
    execFile(
      binary,
      args,
      {
        encoding: 'buffer',
        maxBuffer: MAX_OUTPUT_BYTES,
        timeout: COMMAND_TIMEOUT_MS,
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
  });

/**
 * OPTIONAL local extraction via the system ffmpeg/ffprobe binaries. Command
 * execution is injectable so tests never spawn a process; failures map to
 * controlled errors that never echo stderr, binary paths, or file paths.
 */
@Injectable()
export class FfmpegVideoFrameExtractor extends VideoFrameExtractorPort {
  readonly kind = FFMPEG_EXTRACTOR_KIND;

  constructor(
    private readonly storage: VideoStoragePort,
    private readonly runCommand: RunCommand = defaultRunCommand,
  ) {
    super();
  }

  private async run(binary: string, args: string[]): Promise<Buffer> {
    try {
      const { stdout } = await this.runCommand(binary, args);
      return stdout;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ExtractorUnavailableError();
      }
      throw new ExtractionFailedError();
    }
  }

  async probe(storageKey: string): Promise<VideoProbeResult> {
    const stdout = await this.run(
      FFPROBE_BINARY,
      buildProbeArgs(this.storage.internalPathFor(storageKey)),
    );
    return parseProbeOutput(stdout.toString('utf8'));
  }

  async extractFrames(
    storageKey: string,
    probe: VideoProbeResult,
    options: FrameExtractionOptions,
  ): Promise<ExtractedImage[]> {
    const frames: ExtractedImage[] = [];
    for (
      let timestampMs = options.startMs;
      timestampMs <= probe.durationMs && frames.length < options.maxFrames;
      timestampMs += options.intervalMs
    ) {
      frames.push(await this.extractFrameAt(storageKey, probe, timestampMs));
    }
    return frames;
  }

  async extractFrameAt(
    storageKey: string,
    probe: VideoProbeResult,
    timestampMs: number,
  ): Promise<ExtractedImage> {
    const data = await this.run(
      FFMPEG_BINARY,
      buildFrameArgs(this.storage.internalPathFor(storageKey), timestampMs),
    );
    if (data.length === 0) {
      throw new ExtractionFailedError();
    }
    return {
      data,
      width: probe.width,
      height: probe.height,
      mimeType: 'image/png',
      timestampMs,
    };
  }

  async extractCrop(
    storageKey: string,
    probe: VideoProbeResult,
    timestampMs: number,
    box: CropBox,
  ): Promise<ExtractedImage> {
    void probe;
    const data = await this.run(
      FFMPEG_BINARY,
      buildCropArgs(this.storage.internalPathFor(storageKey), timestampMs, box),
    );
    if (data.length === 0) {
      throw new ExtractionFailedError();
    }
    return {
      data,
      width: box.width,
      height: box.height,
      mimeType: 'image/png',
      timestampMs,
    };
  }
}
