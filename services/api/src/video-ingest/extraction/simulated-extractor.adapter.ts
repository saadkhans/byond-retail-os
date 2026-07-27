import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  CropBox,
  ExtractedImage,
  FrameExtractionOptions,
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

  probe(storageKey: string): Promise<VideoProbeResult> {
    // The key is unused except to keep the contract honest — a simulated
    // probe never touches storage.
    void storageKey;
    return Promise.resolve({ ...SIMULATED_PROBE });
  }

  extractFrames(
    storageKey: string,
    probe: VideoProbeResult,
    options: FrameExtractionOptions,
  ): Promise<ExtractedImage[]> {
    void storageKey;
    const frames: ExtractedImage[] = [];
    for (
      let timestampMs = options.startMs;
      timestampMs <= probe.durationMs && frames.length < options.maxFrames;
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
  ): Promise<ExtractedImage> {
    void storageKey;
    return Promise.resolve(
      this.placeholderImage(probe.width, probe.height, timestampMs),
    );
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
