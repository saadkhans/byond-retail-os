/**
 * Decoded-pixel access for the pickup analyzer: downscaled RGB24 analysis
 * frames of a STORED (screened, validated) video, and RGB24 decodes of the
 * per-SKU reference images. Everything arrives via ffmpeg's rawvideo pipe
 * so the analyzer/matcher stay dependency-free.
 *
 * Confinement mirrors the Phase 10 extraction adapter: the binary name is
 * confined to this file, arguments are fixed vectors (no shell), paths come
 * only from the local storage adapter or the operator-configured reference
 * directory (never from a request), and failures map to the SAME controlled
 * error types the extraction port defines — no stderr, argv, or path ever
 * escapes.
 */

import { execFile } from 'node:child_process';
import { Injectable } from '@nestjs/common';
import {
  ExtractionFailedError,
  VideoProbeResult,
} from '../../video-ingest/extraction/video-frame-extractor.port';
import { classifyCommandError } from '../../video-ingest/extraction/ffmpeg-extractor.adapter';
import { AnalysisFrame, AnalysisGeometry } from './pickup-analyzer';
import { RgbImage } from './product-matcher';

const FFMPEG_BINARY = 'ffmpeg';

/** Per-EXEC output ceiling. One exec's rawvideo pipe must fit this cap, so
 *  whole-clip decodes are split into `-ss`/`-frames:v` chunks whose frame
 *  count is derived from the frame size (see decodeAnalysisFrames) — a
 *  single unchunked exec overflows for supported inputs (portrait 192x340
 *  at the permitted fps ceiling of 15 is ~84 MiB over 30 s). */
const MAX_DECODE_BYTES = 64 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 60_000;

/** AGGREGATE retained-bytes ceiling across ALL chunks of one whole-clip
 *  decode. Chunking bounds each exec, but the analyzer needs every sampled
 *  frame at once (motion analysis and background windows are random-access
 *  over the clip), so without this ceiling frame size x fps x duration is
 *  unbounded: a 300 s portrait clip at 5 fps retains ~280 MiB and ~840 MiB
 *  at the validated fps ceiling of 15. When the requested cadence would
 *  exceed the budget the decoder DOWNSAMPLES fps so a valid asset never
 *  fails outright — worst case it retains exactly this many frame bytes
 *  (plus one in-flight <= 64 MiB chunk pipe while decoding). */
const MAX_AGGREGATE_DECODE_BYTES = 192 * 1024 * 1024;

/** Reference images decode straight to the matcher's working size. */
export const REFERENCE_DECODE_EDGE = 96;

/** ONE bounded chunk of the sampled clip: `-ss` before `-i` is an input
 *  seek (keyframe jump + accurate decode-forward, timestamps reset to the
 *  seek point so the fps filter samples from the chunk start), and
 *  `-frames:v` hard-caps the post-filter output so the pipe can never
 *  exceed `maxFrames` frames regardless of clip duration. */
export function buildAnalysisFramesArgs(
  internalPath: string,
  fps: number,
  width: number,
  height: number,
  seekMs: number,
  maxFrames: number,
): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-ss',
    (seekMs / 1000).toFixed(3),
    '-i',
    internalPath,
    '-frames:v',
    String(maxFrames),
    '-vf',
    `fps=${fps},scale=${width}:${height}`,
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    'pipe:1',
  ];
}

/** Seek-and-decode of ONE frame at `seekMs` — `-ss` before `-i` is an
 *  input seek (keyframe jump + accurate decode-forward), and `-frames:v 1`
 *  stops the pipe after a single frame, so the output is one frame's
 *  bytes regardless of clip duration. */
export function buildFrameAtArgs(
  internalPath: string,
  seekMs: number,
  width: number,
  height: number,
): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-ss',
    (seekMs / 1000).toFixed(3),
    '-i',
    internalPath,
    '-frames:v',
    '1',
    '-vf',
    `scale=${width}:${height}`,
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    'pipe:1',
  ];
}

export function buildReferenceDecodeArgs(
  internalPath: string,
  edge: number,
): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    internalPath,
    '-frames:v',
    '1',
    '-vf',
    `scale=${edge}:${edge}`,
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    'pipe:1',
  ];
}

/** Even-dimensioned analysis geometry preserving the source aspect. */
export function analysisGeometryFor(
  probe: VideoProbeResult,
  targetWidth: number,
): AnalysisGeometry {
  const width = Math.max(16, Math.min(targetWidth, probe.width));
  const evenWidth = width - (width % 2);
  const scaledHeight = Math.round((probe.height * evenWidth) / probe.width);
  const evenHeight = Math.max(16, scaledHeight - (scaledHeight % 2));
  return { width: evenWidth, height: evenHeight };
}

type RunCommand = (
  binary: string,
  args: string[],
  maxOutputBytes: number,
) => Promise<{ stdout: Buffer }>;

const defaultRunCommand: RunCommand = (binary, args, maxOutputBytes) =>
  new Promise((resolvePromise, rejectPromise) => {
    execFile(
      binary,
      args,
      {
        encoding: 'buffer',
        maxBuffer: maxOutputBytes,
        timeout: COMMAND_TIMEOUT_MS,
        windowsHide: true,
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

@Injectable()
export class PickupAnalysisFrameDecoder {
  constructor(private readonly runCommand: RunCommand = defaultRunCommand) {}

  /**
   * Decode the stored clip into analysis frames at `fps` (or the highest
   * budget-fitting cadence below it), downscaled to `geometry`. Timestamps
   * are the fps filter's sample cadence — sample i represents t = i / fps
   * at the EFFECTIVE fps actually decoded.
   *
   * Decoding is CHUNKED so no single exec's output can outgrow
   * MAX_DECODE_BYTES: each chunk seeks to the next unsampled instant
   * (frames decoded so far / fps) and hard-caps its output at the frame
   * count that fits the budget. Frame size x sampled frame count is
   * otherwise unbounded — portrait geometry at the top of the validated
   * PICKUP_ANALYSIS_FPS range (15) overflows a single 64 MiB exec on an
   * ordinary 30 s clip, and landscape at the default fps overflows past
   * ~216 s while screening admits clips up to 300 s. A short chunk (fewer
   * frames than requested) marks end of clip; a chunk seeked past the last
   * frame decodes nothing and also terminates.
   *
   * AGGREGATE memory is bounded too, by two mechanisms:
   * - each frame's pixels are COPIED out of the chunk pipe (a subarray
   *   view would pin its whole <= 64 MiB stdout buffer for as long as any
   *   frame of that chunk is alive);
   * - when `durationMs` x `fps` would retain more than
   *   MAX_AGGREGATE_DECODE_BYTES, the cadence is downsampled to the
   *   highest fps that fits — a valid asset NEVER fails on length, and
   *   the frame total is hard-capped even against lying metadata.
   */
  async decodeAnalysisFrames(
    internalPath: string,
    fps: number,
    geometry: AnalysisGeometry,
    durationMs: number,
  ): Promise<AnalysisFrame[]> {
    const frameBytes = geometry.width * geometry.height * 3;
    const framesPerChunk = Math.max(1, Math.floor(MAX_DECODE_BYTES / frameBytes));
    const maxTotalFrames = Math.max(
      1,
      Math.floor(MAX_AGGREGATE_DECODE_BYTES / frameBytes),
    );
    const durationSeconds = Math.max(1, durationMs) / 1000;
    // Downsample instead of failing: the highest cadence whose sampled
    // total fits the aggregate budget (floored to a millifps so the frame
    // count can never round back over the ceiling).
    const effectiveFps =
      Math.ceil(durationSeconds * fps) > maxTotalFrames
        ? Math.max(
            0.001,
            Math.floor((maxTotalFrames * 1000) / durationSeconds) / 1000,
          )
        : fps;
    const frames: AnalysisFrame[] = [];
    for (;;) {
      // Seek to the first instant the previous chunks did not sample; the
      // fps filter then resumes the i / fps cadence from the seek point.
      const seekMs = Math.round((frames.length * 1000) / effectiveFps);
      // The per-exec cap also never asks for frames the aggregate budget
      // cannot retain (a probe that under-reported duration would
      // otherwise keep the loop decoding past the ceiling).
      const chunkCap = Math.min(framesPerChunk, maxTotalFrames - frames.length);
      let stdout: Buffer;
      try {
        ({ stdout } = await this.runCommand(
          FFMPEG_BINARY,
          buildAnalysisFramesArgs(
            internalPath,
            effectiveFps,
            geometry.width,
            geometry.height,
            seekMs,
            chunkCap,
          ),
          Math.max(MAX_DECODE_BYTES, frameBytes),
        ));
      } catch (error) {
        throw classifyCommandError(error);
      }
      const chunkFrames = Math.min(
        chunkCap,
        Math.floor(stdout.length / frameBytes),
      );
      for (let chunkIndex = 0; chunkIndex < chunkFrames; chunkIndex += 1) {
        const index = frames.length;
        frames.push({
          index,
          timestampMs: Math.round((index * 1000) / effectiveFps),
          // COPY, never a subarray view: a view pins the chunk's whole
          // stdout buffer until the last frame of the clip is released.
          rgb: Buffer.from(
            stdout.subarray(chunkIndex * frameBytes, (chunkIndex + 1) * frameBytes),
          ),
        });
      }
      if (chunkFrames < chunkCap || frames.length >= maxTotalFrames) {
        break;
      }
    }
    if (frames.length === 0) {
      throw new ExtractionFailedError();
    }
    return frames;
  }

  /**
   * Decode ONE frame at (or just after) `timestampMs`, downscaled to
   * `geometry`. Full-resolution passes use this PER-TIMESTAMP seek so the
   * output budget is a single frame's bytes — a whole-clip decode at full
   * resolution overflows MAX_DECODE_BYTES for ordinary 20-30 s clips.
   * A seek at the very tail of the container can land past the last
   * frame's PTS and produce no output; one retry from 1 s earlier (every
   * accepted clip is several seconds long, so a frame exists there) keeps
   * end-of-clip events decodable before failing controlled. The returned
   * frame's `timestampMs` is the ACTUAL seek instant that produced pixels
   * — a fallback decode reports the earlier instant, never the requested
   * one, so callers persist the true timestamp into evidence.
   */
  async decodeFrameAt(
    internalPath: string,
    timestampMs: number,
    geometry: AnalysisGeometry,
  ): Promise<AnalysisFrame> {
    const frameBytes = geometry.width * geometry.height * 3;
    const seeks = [...new Set([timestampMs, Math.max(0, timestampMs - 1000)])];
    for (const seekMs of seeks) {
      let stdout: Buffer;
      try {
        ({ stdout } = await this.runCommand(
          FFMPEG_BINARY,
          buildFrameAtArgs(internalPath, seekMs, geometry.width, geometry.height),
          frameBytes * 2,
        ));
      } catch (error) {
        throw classifyCommandError(error);
      }
      if (stdout.length >= frameBytes) {
        return {
          index: 0,
          // The instant that actually decoded — on a tail retry this is
          // the fallback seek, not the requested timestamp.
          timestampMs: seekMs,
          rgb: stdout.subarray(0, frameBytes),
        };
      }
    }
    throw new ExtractionFailedError();
  }

  /** Decode ONE reference image to the matcher's working size. */
  async decodeReferenceImage(internalPath: string): Promise<RgbImage> {
    let stdout: Buffer;
    try {
      ({ stdout } = await this.runCommand(
        FFMPEG_BINARY,
        buildReferenceDecodeArgs(internalPath, REFERENCE_DECODE_EDGE),
        REFERENCE_DECODE_EDGE * REFERENCE_DECODE_EDGE * 3 * 4,
      ));
    } catch (error) {
      throw classifyCommandError(error);
    }
    const expected = REFERENCE_DECODE_EDGE * REFERENCE_DECODE_EDGE * 3;
    if (stdout.length < expected) {
      throw new ExtractionFailedError();
    }
    return {
      width: REFERENCE_DECODE_EDGE,
      height: REFERENCE_DECODE_EDGE,
      rgb: stdout.subarray(0, expected),
    };
  }
}
