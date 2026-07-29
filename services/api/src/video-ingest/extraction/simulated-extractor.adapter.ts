import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  BufferInspectionSession,
  CropBox,
  ExtractedImage,
  ExtractFrameAtOptions,
  FrameCountExceededError,
  FrameExceedsBudgetError,
  FrameExtractionOptions,
  ScreeningDeadlineExceededError,
  VideoFrameExtractorPort,
  VideoProbeResult,
} from './video-frame-extractor.port';

export const SIMULATED_EXTRACTOR_KIND = 'simulated';

/**
 * Deterministic probe values for simulated extraction: a 10-second 720p
 * clip at 30 fps. Fixed (not derived from file bytes) so tests and dev
 * flows are fully reproducible without media tooling.
 */
export const SIMULATED_PROBE: VideoProbeResult = {
  durationMs: 10_000,
  width: 1280,
  height: 720,
  fps: 30,
};

// A minimal, VALID 1x1 opaque-black PNG. Simulated artifacts carry these
// bytes regardless of the requested dimensions — the artifact ROW records
// the honest requested frame/crop geometry, while the payload is an inert
// placeholder (nothing in Phase 10 decodes artifact bytes). Real pixels
// arrive only through the optional local binary adapter.
const PLACEHOLDER_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4' +
    '890000000d4944415478da63f8ffff3f0005fe02fea72d3e4b0000000049454e' +
    '44ae426082',
  'hex',
);

/**
 * The default Phase 10 extractor: NO media tooling, no child processes, no
 * npm video dependency. Bytes are deterministic placeholders; geometry and
 * timestamps are computed honestly from the probe and the request, so every
 * downstream contract (bounds validation, artifact rows, Phase 9 descriptor)
 * behaves exactly as it will with a real extractor.
 */
@Injectable()
export class SimulatedVideoFrameExtractor extends VideoFrameExtractorPort {
  readonly kind = SIMULATED_EXTRACTOR_KIND;

  // Placeholder bytes, NOT the stored media: byte-inspecting surfaces (the
  // quarantine screening preview) must refuse to serve from this adapter —
  // a screener looking at placeholders would be attesting blind.
  readonly readsRealBytes = false;

  probe(storageKey: string): Promise<VideoProbeResult> {
    // The key is unused except to keep the contract honest — a simulated
    // probe never touches storage.
    void storageKey;
    return Promise.resolve({ ...SIMULATED_PROBE });
  }

  inspectBuffer(data: Buffer): Promise<BufferInspectionSession> {
    // Trivial by design: the simulated adapter never reads real bytes
    // (readsRealBytes=false already makes the pre-storage screen refuse to
    // treat its frames as a real look at the footage), so the session is
    // the deterministic probe plus the EXHAUSTIVE placeholder stream — one
    // placeholder PNG per SOURCE frame (fps × duration, mirroring the real
    // adapter's every-frame contract), PUSHED one at a time exactly like
    // the streaming adapter — and a no-op close: fully in-memory, nothing
    // ever touches disk.
    void data;
    return Promise.resolve({
      probe: () => Promise.resolve({ ...SIMULATED_PROBE }),
      streamFrames: async (options: {
        maxFrames: number;
        maxBytesPerFrame: number;
        deadlineMs: number;
        onFrame: (frame: Buffer, index: number) => Promise<'continue' | 'stop'>;
      }) => {
        // Same budget contract as the real adapter: a degenerate cap fits
        // no frame, and any frame over the cap is the budget verdict.
        if (
          !Number.isInteger(options.maxBytesPerFrame) ||
          options.maxBytesPerFrame <= 0
        ) {
          throw new FrameExceedsBudgetError();
        }
        // Same frame-count contract too: a degenerate cap fits no frames,
        // and a stream past the cap is the controlled count verdict.
        if (!Number.isInteger(options.maxFrames) || options.maxFrames <= 0) {
          throw new FrameCountExceededError();
        }
        // The deadline is CONTRACTUAL here, not timed: no simulated decode
        // can overrun a wall clock, but a degenerate budget is the same
        // controlled verdict the real adapter gives before spawning.
        if (!Number.isInteger(options.deadlineMs) || options.deadlineMs <= 0) {
          throw new ScreeningDeadlineExceededError();
        }
        const totalFrames = Math.ceil(
          (SIMULATED_PROBE.fps * SIMULATED_PROBE.durationMs) / 1000,
        );
        if (totalFrames > options.maxFrames) {
          throw new FrameCountExceededError();
        }
        let framesSeen = 0;
        for (let index = 0; index < totalFrames; index += 1) {
          const frame = this.placeholderImage(
            SIMULATED_PROBE.width,
            SIMULATED_PROBE.height,
            Math.round((index * 1000) / SIMULATED_PROBE.fps),
          ).data;
          if (frame.length > options.maxBytesPerFrame) {
            throw new FrameExceedsBudgetError();
          }
          framesSeen += 1;
          // Push-based like the real adapter: one frame in the caller's
          // hands at a time, and an early stop is a normal resolution.
          if ((await options.onFrame(frame, index)) === 'stop') {
            return { framesSeen, stoppedEarly: true };
          }
        }
        return { framesSeen, stoppedEarly: false };
      },
      close: () => Promise.resolve(),
    });
  }

  extractFrames(
    storageKey: string,
    probe: VideoProbeResult,
    options: FrameExtractionOptions,
  ): Promise<ExtractedImage[]> {
    void storageKey;
    const frames: ExtractedImage[] = [];
    // Duration is an EXCLUSIVE endpoint (no frame exists at durationMs) —
    // strictly-less keeps the simulated adapter consistent with real
    // extraction, where a seek to the duration returns no output.
    for (
      let timestampMs = options.startMs;
      timestampMs < probe.durationMs && frames.length < options.maxFrames;
      timestampMs += options.intervalMs
    ) {
      frames.push(this.placeholderImage(probe.width, probe.height, timestampMs));
    }
    return Promise.resolve(frames);
  }

  extractFrameAt(
    storageKey: string,
    probe: VideoProbeResult,
    timestampMs: number,
    options?: ExtractFrameAtOptions,
  ): Promise<ExtractedImage> {
    void storageKey;
    const image = this.placeholderImage(probe.width, probe.height, timestampMs);
    // Honor a caller budget trivially: the placeholder either fits or the
    // contract's budget verdict applies — same behavior as a real adapter.
    if (options?.maxBytes !== undefined && image.data.length > options.maxBytes) {
      return Promise.reject(new FrameExceedsBudgetError());
    }
    return Promise.resolve(image);
  }

  extractCrop(
    storageKey: string,
    probe: VideoProbeResult,
    timestampMs: number,
    box: CropBox,
  ): Promise<ExtractedImage> {
    void storageKey;
    void probe;
    return Promise.resolve(
      this.placeholderImage(box.width, box.height, timestampMs),
    );
  }

  private placeholderImage(
    width: number,
    height: number,
    timestampMs: number,
  ): ExtractedImage {
    // Payload varies by geometry+timestamp (appended digest) so distinct
    // artifacts get distinct checksums — mirroring real extraction, where
    // two different crops never share a checksum.
    const marker = createHash('sha256')
      .update(`${width}x${height}@${timestampMs}`)
      .digest();
    return {
      data: Buffer.concat([PLACEHOLDER_PNG, marker]),
      width,
      height,
      mimeType: 'image/png',
      timestampMs,
    };
  }
}
