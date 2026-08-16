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
 * (CAMERA_RTSP_SOURCE_<TENANT>_<SLOT>, where <TENANT> is the requesting
 * tenant's id uppercased and <SLOT> is the camera's server-recognized
 * credential slot name) and is used exclusively as the ffmpeg input
 * argument: it is never returned, never thrown, never logged, never
 * interpolated into any message, and never persisted. Callers learn only
 * `configured: boolean` and controlled error codes.
 *
 * TENANT-BOUND RESOLUTION (Codex P1): the tenant id is part of the env
 * key, so a slot name alone resolves NOTHING — tenant B registering the
 * same public slot name can only ever reach configuration an operator
 * explicitly created FOR tenant B. There is deliberately no fallback to
 * an un-prefixed global key (that would recreate the cross-tenant hole),
 * and a missing tenant-scoped key is indistinguishable from
 * non-ownership by design: both are RTSP_SOURCE_NOT_CONFIGURED. Tenant
 * ids are cuids (alphanumeric), so uppercasing them is env-name-safe.
 *
 * CREDENTIAL-FREE SOURCES ONLY (Codex P1): the input value lands in
 * ffmpeg's argv, which is visible to process listings and telemetry —
 * escaping shell injection is not enough. Phase 13 therefore supports
 * credential-free dev/local sources only (a URL carrying userinfo or a
 * token-like query parameter is refused BEFORE any spawn with
 * RTSP_CREDENTIALS_IN_URL_UNSUPPORTED) until a secure non-argv
 * transport exists.
 *
 * Dev affordance (deliberate): the configured value may be ANY
 * ffmpeg-readable input — a credential-free rtsp:// URL on a real
 * camera, or a local file path during development — the sampler does
 * not care. Like the seed flags, the env key is read directly from
 * process.env because its name is dynamic (one per tenant+slot) and
 * cannot be declared statically in env.validation.
 */

export const RTSP_SAMPLE_ERROR_CODES = [
  'RTSP_SOURCE_NOT_CONFIGURED',
  'RTSP_CREDENTIALS_IN_URL_UNSUPPORTED',
  'RTSP_CONNECT_FAILED',
  'RTSP_FRAME_SAMPLE_FAILED',
  'RTSP_TIMEOUT',
  'RTSP_UNSUPPORTED_IN_ENV',
] as const;
export type RtspSampleErrorCode = (typeof RTSP_SAMPLE_ERROR_CODES)[number];

/** Query-parameter names that mark a URL as credential-bearing even
 *  without userinfo — matched case-insensitively on the KEY only (the
 *  value is never inspected, logged, or surfaced). */
const TOKEN_QUERY_KEYS = new Set([
  'token',
  'access_token',
  'apikey',
  'api_key',
  'password',
  'passwd',
  'auth',
  'key',
  'secret',
]);

/**
 * Pure pre-spawn gate (Codex P1): true when a SCHEME-shaped value
 * carries credentials — userinfo (user or user:pass before '@') or a
 * token-like query key. Plain file paths (no `scheme://`) skip the
 * check entirely. A scheme-shaped value `new URL` cannot parse is
 * judged conservatively: an '@' inside its authority section rejects.
 * The value itself never leaves the caller.
 */
export function urlCarriesCredentials(value: string): boolean {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    return false;
  }
  try {
    const url = new URL(value);
    if (url.username !== '' || url.password !== '') {
      return true;
    }
    for (const key of url.searchParams.keys()) {
      if (TOKEN_QUERY_KEYS.has(key.toLowerCase())) {
        return true;
      }
    }
    return false;
  } catch {
    const afterScheme = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
    const slash = afterScheme.indexOf('/');
    const authority = slash === -1 ? afterScheme : afterScheme.slice(0, slash);
    return authority.includes('@');
  }
}

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

  /** Presence check ONLY — the resolved value never leaves this module.
   *  Tenant-bound: the slot resolves only within the requesting tenant's
   *  own configuration namespace. */
  resolveSource(
    tenantId: string,
    credentialRef: string,
  ): { configured: boolean } {
    return { configured: this.sourceFor(tenantId, credentialRef) !== null };
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
    tenantId: string,
    credentialRef: string,
    opts: { width: number; height: number; timeoutMs: number },
  ): Promise<RtspSampleResult> {
    const source = this.sourceFor(tenantId, credentialRef);
    if (source === null) {
      return { ok: false, code: 'RTSP_SOURCE_NOT_CONFIGURED' };
    }
    // Pre-spawn credential gate (Codex P1): argv is visible to process
    // telemetry, so a credential-bearing URL is refused before ffmpeg
    // ever sees it. Phase 13 supports credential-free sources only.
    if (urlCarriesCredentials(source)) {
      return { ok: false, code: 'RTSP_CREDENTIALS_IN_URL_UNSUPPORTED' };
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

  /** Env resolution, private by design and TENANT-BOUND:
   *  `${ENV_PREFIX}${tenantId.toUpperCase()}_${slot}`. There is no
   *  slot-only fallback — absence of a tenant-scoped key (whether the
   *  tenant never configured it or does not own the slot) resolves to
   *  null and surfaces as RTSP_SOURCE_NOT_CONFIGURED. */
  private sourceFor(tenantId: string, credentialRef: string): string | null {
    // Tenant ids are cuids (alphanumeric) and slot names are
    // server-recognized identifiers (validated upstream) — still, never
    // interpolate anything else into the env key.
    if (!/^[A-Za-z0-9]{1,64}$/.test(tenantId)) {
      return null;
    }
    if (!/^[A-Z0-9_]{1,80}$/.test(credentialRef)) {
      return null;
    }
    const value =
      process.env[`${ENV_PREFIX}${tenantId.toUpperCase()}_${credentialRef}`];
    return value && value.trim().length > 0 ? value.trim() : null;
  }
}
