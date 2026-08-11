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

/** Analysis frames are deliberately small; 64 MiB bounds even a dense
 *  sampling of a 30 s clip with generous slack. */
const MAX_DECODE_BYTES = 64 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 60_000;

/** Reference images decode straight to the matcher's working size. */
export const REFERENCE_DECODE_EDGE = 96;

export function buildAnalysisFramesArgs(
  internalPath: string,
  fps: number,
  width: number,
  height: number,
): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    internalPath,
    '-vf',
    `fps=${fps},scale=${width}:${height}`,
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
   * Decode the stored clip into analysis frames at `fps`, downscaled to
   * `geometry`. Timestamps are the fps filter's sample cadence — sample i
   * represents t = i / fps.
   */
  async decodeAnalysisFrames(
    internalPath: string,
    fps: number,
    geometry: AnalysisGeometry,
  ): Promise<AnalysisFrame[]> {
    let stdout: Buffer;
    try {
      ({ stdout } = await this.runCommand(
        FFMPEG_BINARY,
        buildAnalysisFramesArgs(internalPath, fps, geometry.width, geometry.height),
        MAX_DECODE_BYTES,
      ));
    } catch (error) {
      throw classifyCommandError(error);
    }
    const frameBytes = geometry.width * geometry.height * 3;
    const frameCount = Math.floor(stdout.length / frameBytes);
    if (frameCount === 0) {
      throw new ExtractionFailedError();
    }
    const frames: AnalysisFrame[] = [];
    for (let index = 0; index < frameCount; index += 1) {
      frames.push({
        index,
        timestampMs: Math.round((index * 1000) / fps),
        rgb: stdout.subarray(index * frameBytes, (index + 1) * frameBytes),
      });
    }
    return frames;
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
