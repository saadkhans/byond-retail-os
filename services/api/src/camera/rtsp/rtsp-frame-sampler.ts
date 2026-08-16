import { spawn } from 'node:child_process';
import { Injectable, Logger } from '@nestjs/common';
import { RgbImage } from '../../pickup-detection/analysis/product-matcher';

/**
 * Phase 13 — minimal RTSP frame sampler (SHADOW pilot).
 *
 * One ffmpeg spawn per sampled frame: connect, grab a single frame as
 * raw RGB24 at the requested geometry, exit. No long-running stream
 * process, no recording, no stream infrastructure — a live session is a
 * loop of these calls.
 *
 * SOURCE SECRECY IS THE CONTRACT OF THIS MODULE. The stream location is
 * resolved from operator-managed runtime configuration
 * (CAMERA_RTSP_SOURCE_<SLOT>, where <SLOT> is the camera's
 * server-recognized credential slot name) and is used exclusively as the
 * ffmpeg input argument: it is never returned, never thrown, never
 * logged, never interpolated into any message, and never persisted.
 * Callers learn only `configured: boolean` and controlled error codes.
 *
 * Dev affordance (deliberate): the configured value may be ANY
 * ffmpeg-readable input — an rtsp:// URL on a real camera, or a local
 * file path during development — the sampler does not care. Like the
 * seed flags, the env key is read directly from process.env because its
 * name is dynamic (one per slot) and cannot be declared statically in
 * env.validation.
 */

export const RTSP_SAMPLE_ERROR_CODES = [
  'RTSP_SOURCE_NOT_CONFIGURED',
  'RTSP_CONNECT_FAILED',
  'RTSP_FRAME_SAMPLE_FAILED',
  'RTSP_TIMEOUT',
  'RTSP_UNSUPPORTED_IN_ENV',
] as const;
export type RtspSampleErrorCode = (typeof RTSP_SAMPLE_ERROR_CODES)[number];

export type RtspSampleResult =
  | { ok: true; image: RgbImage; sampledAt: Date }
  | { ok: false; code: RtspSampleErrorCode };

const FFMPEG_BINARY = 'ffmpeg';
/** Same conservative floor/ceiling band as the pilot replay. */
export const RTSP_SAMPLE_MIN_TIMEOUT_MS = 1000;
export const RTSP_SAMPLE_MAX_TIMEOUT_MS = 60_000;

const ENV_PREFIX = 'CAMERA_RTSP_SOURCE_';

@Injectable()
export class RtspFrameSampler {
  private readonly logger = new Logger(RtspFrameSampler.name);

  /** Presence check ONLY — the resolved value never leaves this module. */
  resolveSource(credentialRef: string): { configured: boolean } {
    return { configured: this.sourceFor(credentialRef) !== null };
  }

  /** ffmpeg availability probe: `ffmpeg -version` starts and exits 0. */
  checkFfmpeg(): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (value: boolean) => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };
      try {
        const child = spawn(FFMPEG_BINARY, ['-version'], {
          stdio: ['ignore', 'ignore', 'ignore'],
        });
        child.on('error', () => settle(false));
        child.on('close', (code) => settle(code === 0));
      } catch {
        settle(false);
      }
    });
  }

  /**
   * Sample ONE frame from the configured source as raw RGB24 at the
   * requested geometry. Errors are CONTROLLED CODES only — stderr and
   * exception text never leave this module (they can echo the input
   * argument), and nothing here persists anything.
   */
  async sampleFrame(
    credentialRef: string,
    opts: { width: number; height: number; timeoutMs: number },
  ): Promise<RtspSampleResult> {
    const source = this.sourceFor(credentialRef);
    if (source === null) {
      return { ok: false, code: 'RTSP_SOURCE_NOT_CONFIGURED' };
    }
    const timeoutMs = Math.max(
      RTSP_SAMPLE_MIN_TIMEOUT_MS,
      Math.min(opts.timeoutMs, RTSP_SAMPLE_MAX_TIMEOUT_MS),
    );
    const expectedBytes = opts.width * opts.height * 3;
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      // TCP transport for real RTSP sources: UDP loss produces corrupt
      // frames on typical store networks. Non-RTSP inputs (the dev file
      // affordance) take no transport flag.
      ...(source.startsWith('rtsp') ? ['-rtsp_transport', 'tcp'] : []),
      '-i',
      source,
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-s',
      `${opts.width}x${opts.height}`,
      'pipe:1',
    ];
    return new Promise<RtspSampleResult>((resolve) => {
      let settled = false;
      const settle = (result: RtspSampleResult) => {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      };
      let child;
      try {
        // Args vector, NO shell — the input value is a single argv entry
        // and can never be interpreted as shell syntax.
        child = spawn(FFMPEG_BINARY, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch {
        settle({ ok: false, code: 'RTSP_UNSUPPORTED_IN_ENV' });
        return;
      }
      const chunks: Buffer[] = [];
      let collected = 0;
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
        settle({ ok: false, code: 'RTSP_TIMEOUT' });
      }, timeoutMs);
      child.stdout.on('data', (chunk: Buffer) => {
        // Bounded collection: never more than one frame's bytes + slack.
        if (collected <= expectedBytes * 2) {
          chunks.push(chunk);
          collected += chunk.length;
        }
      });
      // stderr is consumed and DISCARDED: ffmpeg error text echoes the
      // input argument, which must never reach logs or callers.
      child.stderr.on('data', () => undefined);
      child.on('error', () => {
        clearTimeout(timer);
        // Spawn-level failure = no usable ffmpeg in this environment.
        settle({ ok: false, code: 'RTSP_UNSUPPORTED_IN_ENV' });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (settled) {
          return;
        }
        const stdout = Buffer.concat(chunks);
        if (code !== 0 || stdout.length === 0) {
          settle({ ok: false, code: 'RTSP_CONNECT_FAILED' });
          return;
        }
        if (stdout.length !== expectedBytes) {
          settle({ ok: false, code: 'RTSP_FRAME_SAMPLE_FAILED' });
          return;
        }
        settle({
          ok: true,
          image: { width: opts.width, height: opts.height, rgb: stdout },
          sampledAt: new Date(),
        });
      });
    });
  }

  /** Env resolution, private by design: `${ENV_PREFIX}${slot}`. */
  private sourceFor(credentialRef: string): string | null {
    // Slot names are server-recognized identifiers (validated upstream) —
    // still, never interpolate anything else into the env key.
    if (!/^[A-Z0-9_]{1,80}$/.test(credentialRef)) {
      return null;
    }
    const value = process.env[`${ENV_PREFIX}${credentialRef}`];
    return value && value.trim().length > 0 ? value.trim() : null;
  }
}
