import { plainToInstance } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

export enum NodeEnv {
  Development = 'development',
  Test = 'test',
  Production = 'production',
}

class EnvironmentVariables {
  @IsString()
  @MinLength(1)
  DATABASE_URL!: string;

  // HS256 signing secret. Fail fast on short secrets — 32+ chars required.
  // Placeholder-looking values are additionally rejected below.
  @IsString()
  @MinLength(32)
  JWT_SECRET!: string;

  // Access token lifetime: positive integer + REQUIRED unit (3600s, 15m,
  // 1h, 7d). Unitless values are rejected: jsonwebtoken interprets a
  // unitless STRING as milliseconds, so "900" would issue tokens that
  // expire in 0.9s. Zero durations ("0s", "0m") are rejected too — they
  // pass jsonwebtoken but every issued token is already expired, taking
  // authenticated access down.
  @IsOptional()
  @Matches(/^0*[1-9]\d*(ms|s|m|h|d)$/, {
    message:
      'JWT_EXPIRES_IN requires a positive, non-zero duration with an ' +
      'explicit unit, e.g. 3600s, 15m, 1h, 7d (unitless or zero values ' +
      'are rejected)',
  })
  JWT_EXPIRES_IN?: string;

  // Express "trust proxy" setting — controls how req.ip is derived behind
  // reverse proxies/load balancers (the login throttle keys on req.ip).
  // Safe default: unset/false (X-Forwarded-For is NOT trusted). Set only
  // when the deployment intentionally trusts its upstream proxy chain.
  @IsOptional()
  @Matches(/^(true|false|loopback|linklocal|uniquelocal|\d+)$/i, {
    message:
      'TRUST_PROXY must be true, false, loopback, linklocal, uniquelocal, or a hop count',
  })
  TRUST_PROXY?: string;

  // Login throttle: attempts per (IP + email) within the window.
  @IsOptional()
  @IsInt()
  @Min(1)
  LOGIN_THROTTLE_LIMIT?: number;

  // Login throttle: total attempts per IP within the window, regardless of
  // which emails are attempted (bounds credential stuffing).
  @IsOptional()
  @IsInt()
  @Min(1)
  LOGIN_THROTTLE_IP_LIMIT?: number;

  @IsOptional()
  @IsInt()
  @Min(1000)
  LOGIN_THROTTLE_WINDOW_MS?: number;

  // Comma-separated list of browser origins allowed by CORS (the admin
  // web app). Default: the local Vite dev server. Never a wildcard.
  // No MinLength: deployments that materialize unset vars as CORS_ORIGINS=
  // must still boot — parseCorsOrigins maps blank to the safe default.
  @IsOptional()
  @IsString()
  CORS_ORIGINS?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(65535)
  PORT?: number;

  @IsOptional()
  @IsEnum(NodeEnv)
  NODE_ENV?: NodeEnv;

  // Phase 10 — local/dev video storage ONLY. The root is a server-side
  // directory (relative paths resolve against the API working directory);
  // uploaded test videos and extracted frame/crop artifacts live under it
  // behind server-generated keys. It is never exposed through the API and
  // never accepts user-supplied paths.
  @IsOptional()
  @IsString()
  @MinLength(1)
  VIDEO_STORAGE_ROOT?: string;

  // Upload size ceiling in bytes. Conservative default (50 MiB) — Phase 10
  // ingests short controlled test clips, not production footage. HARD upper
  // bound (256 MiB): uploads buffer in memory, so an unbounded value would
  // let one request hold gigabytes of heap, and anything above the
  // PostgreSQL signed-Int range would overflow VideoAsset.sizeBytes after
  // the bytes were already stored. A deployment typo fails at boot instead.
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(268_435_456)
  VIDEO_MAX_UPLOAD_BYTES?: number;

  // Opt-in switch for the OPTIONAL local system ffmpeg binary adapter. Off
  // by default: the simulated extractor serves dev/test without any media
  // tooling installed, and CI never shells out.
  @IsOptional()
  @Matches(/^(true|false)$/i, {
    message: 'VIDEO_FFMPEG_ENABLED must be true or false',
  })
  VIDEO_FFMPEG_ENABLED?: string;

  // Opt-in switch for the OPTIONAL local system OCR (frame-text
  // recognition) binary adapter used by the pre-storage upload frame
  // screen — same strict boolean idiom as VIDEO_FFMPEG_ENABLED. MUST be
  // declared here: validateSync runs with whitelist:true, so an
  // undeclared key is STRIPPED before ConfigService is constructed and
  // the module would silently always select the simulated recognizer.
  @IsOptional()
  @Matches(/^(true|false)$/i, {
    message: 'VIDEO_OCR_ENABLED must be true or false',
  })
  VIDEO_OCR_ENABLED?: string;

  // Master switch for the ONLY upload mode Phase 10 supports: controlled
  // INTERNAL TEST clips. Off by default — with it unset/false the ingestion
  // endpoint accepts nothing at all. Same strict boolean idiom as
  // VIDEO_FFMPEG_ENABLED / VIDEO_OCR_ENABLED, and MUST stay declared here
  // (validateSync runs with whitelist:true, so an undeclared key is
  // STRIPPED before ConfigService is constructed and the gate would read as
  // permanently off). assertTestMediaIngestNonProduction below additionally
  // FAILS startup whenever it is true outside an explicit
  // development/test NODE_ENV.
  @IsOptional()
  @Matches(/^(true|false)$/i, {
    message: 'VIDEO_TEST_MEDIA_INGEST_ENABLED must be true or false',
  })
  VIDEO_TEST_MEDIA_INGEST_ENABLED?: string;

  // UNSUPPORTED — the historical unscreened-upload bypass is GONE in every
  // environment. The variable stays DECLARED (whitelist compatibility:
  // env files that carry it as false/unset must still boot), but
  // assertScreeningBypassUnsupported below FAILS startup whenever it is
  // true — development, test, and production alike: the payment invariant
  // (raw media is never persisted before screening) has no dev/test
  // exception.
  @IsOptional()
  @Matches(/^(true|false)$/i, {
    message: 'VIDEO_UNSAFE_ALLOW_UNSCREENED_UPLOADS must be true or false',
  })
  VIDEO_UNSAFE_ALLOW_UNSCREENED_UPLOADS?: string;

  // Ceiling on the probed duration (ms) eligible for the mandatory
  // pre-storage upload frame screen: EVERY started second of an upload is
  // OCR-screened at 1 fps before any byte reaches durable storage, so
  // this bounds the synchronous upload request. Longer clips are a
  // controlled 400 BEFORE any storage write. Default 30000 (30 s);
  // bounds 1 s .. 5 min so a deployment typo fails at boot instead of
  // making uploads either unscreenable or unboundedly slow.
  @IsOptional()
  @IsInt()
  @Min(1000)
  @Max(300_000)
  VIDEO_MAX_SCREENING_DURATION_MS?: number;

  // Ceiling on the DECODED FRAME COUNT eligible for the mandatory
  // pre-storage upload frame screen: the screen decodes and OCR-inspects
  // EVERY source frame (no sampling), so this caps the synchronous
  // per-upload OCR work. Clips whose estimated frame count
  // (ceil(fps × duration)) exceeds it are a controlled 400 BEFORE any
  // decode, and an exhaustive decode that still yields more frames (VFR
  // clips) is the same controlled rejection. Default 900 (30 fps × 30 s);
  // bounds 30 .. 3600 so a deployment typo fails at boot instead of making
  // uploads either unscreenable or unboundedly slow.
  @IsOptional()
  @IsInt()
  @Min(30)
  @Max(3600)
  VIDEO_MAX_SCREENING_FRAMES?: number;

  // UPLOAD-WIDE screening deadline (ms): the aggregate wall-clock budget for
  // decoding + OCR-screening ONE upload, not a per-frame or per-probe
  // allowance. Without it a pathologically slow clip (or a wedged external
  // binary) could hold an HTTP request open and pin CPU indefinitely, so the
  // whole screen is abandoned — a controlled rejection BEFORE any byte
  // reaches durable storage — once the budget is spent. Default 30000
  // (30 s); bounds 1 s .. 5 min so a deployment typo fails at boot instead
  // of making uploads either unscreenable or unboundedly slow.
  @IsOptional()
  @IsInt()
  @Min(1000)
  @Max(300_000)
  VIDEO_SCREENING_TIMEOUT_MS?: number;
}

// Placeholder markers — banned in EVERY environment (staging and preview
// deployments often run with non-production NODE_ENV, and this secret signs
// all access tokens). Note /secret/ itself is banned: a generated value
// (hex/base64 random bytes) never contains the word.
const PLACEHOLDER_JWT_PATTERNS = [
  /change[-_ ]?me/i,
  /replace[-_ ]?me/i,
  /placeholder/i,
  /example/i,
  /dev[-_]?only/i,
  /test[-_]?only/i,
  /secret/i,
  /insecure/i,
  /password/i,
];

/**
 * Parses the validated TRUST_PROXY value into what Express expects.
 * Fail-safe default: false — proxy headers are never trusted implicitly.
 */
export function parseTrustProxy(
  value: string | undefined,
): boolean | number | string {
  if (value === undefined || value === '') {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'false') {
    return false;
  }
  if (normalized === 'true') {
    return true;
  }
  if (/^\d+$/.test(normalized)) {
    return Number(normalized);
  }
  // loopback | linklocal | uniquelocal (validated upstream).
  return normalized;
}

/**
 * Parses CORS_ORIGINS (comma-separated) into the explicit origin allowlist
 * handed to Express CORS. Fail-safe default: only the local admin-web dev
 * server. A wildcard is never produced — an empty/blank value falls back to
 * the default rather than allowing everything.
 */
export function parseCorsOrigins(value: string | undefined): string[] {
  const origins = (value ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0 && origin !== '*');
  return origins.length > 0 ? origins : ['http://localhost:5173'];
}

/**
 * SINGLE SOURCE OF TRUTH for how the Phase 10 `'true'|'false'` env flags
 * (VIDEO_TEST_MEDIA_INGEST_ENABLED, VIDEO_FFMPEG_ENABLED, VIDEO_OCR_ENABLED,
 * VIDEO_UNSAFE_ALLOW_UNSCREENED_UPLOADS) are interpreted as booleans.
 *
 * INVARIANT: startup validation (the assertions below), the video-ingest
 * module's adapter factories, and the upload gate in the video-assets service
 * MUST all agree on what "enabled" means. This helper IS that definition —
 * every consumer should call it rather than hand-comparing the raw string.
 * A mismatch is a real outage class: a deployment configured with
 * `VIDEO_TEST_MEDIA_INGEST_ENABLED=TRUE` boots fine and selects the real
 * tooling, yet a gate that compares the exact string `'true'` stays closed
 * and 503s every upload.
 *
 * Normalization matches exactly what `@Matches(/^(true|false)$/i)` admits:
 * trim, case-insensitive, `'true'` -> true. `'false'`, `undefined`, and the
 * empty string -> false.
 *
 * FAILS CLOSED on anything else ('yes', '1', 'on', ...) -> false. Such values
 * cannot reach here in a running process — validateSync rejects them at boot
 * — but the helper must never widen "enabled" beyond the validated spelling
 * if it is ever called on unvalidated input.
 */
export function isEnvFlagEnabled(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true';
}

export function assertJwtSecretUsable(secret: string): void {
  // Never echo the secret value in errors.
  if (PLACEHOLDER_JWT_PATTERNS.some((pattern) => pattern.test(secret))) {
    throw new Error(
      'JWT_SECRET looks like a placeholder; generate a real secret, e.g. ' +
        'node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"',
    );
  }
}

/**
 * Startup rule (same post-validate idiom as assertJwtSecretUsable): the
 * pre-storage upload-screening bypass is NOT SUPPORTED — in ANY
 * environment. The payment invariant that raw media is never persisted
 * before screening has no development/test exception, so a config that
 * asks for unscreened uploads fails AT BOOT everywhere; the variable
 * remains declared only so env files carrying it as false/unset keep
 * booting. The video-ingest service no longer reads the flag at all.
 */
export function assertScreeningBypassUnsupported(
  bypass: string | undefined,
): void {
  if (isEnvFlagEnabled(bypass)) {
    throw new Error(
      'VIDEO_UNSAFE_ALLOW_UNSCREENED_UPLOADS is not supported because ' +
        'raw media cannot be persisted before screening.',
    );
  }
}

/**
 * Startup rule (same post-validate idiom as assertScreeningBypassUnsupported):
 * controlled test-media ingestion is a NON-PRODUCTION capability. The flag may
 * only be true when NODE_ENV is EXPLICITLY development or test — production
 * fails, and so does an UNSET/absent NODE_ENV, which is the same hole as
 * production (a deployment that forgets NODE_ENV must not silently become an
 * upload-accepting environment). Non-enum NODE_ENV values never reach here:
 * the NodeEnv enum rejects them upstream in validateSync. false/unset is
 * always fine, in every environment.
 *
 * "true" here means isEnvFlagEnabled — the SAME definition the video-ingest
 * module adapter factories and the upload gate must use, so a `TRUE` spelling
 * can never be enabled at startup yet read as disabled by a consumer (or
 * vice versa).
 */
export function assertTestMediaIngestNonProduction(
  enabled: string | undefined,
  nodeEnv: NodeEnv | undefined,
): void {
  if (!isEnvFlagEnabled(enabled)) {
    return;
  }
  if (nodeEnv === NodeEnv.Development || nodeEnv === NodeEnv.Test) {
    return;
  }
  const environment = nodeEnv === undefined ? 'unset' : nodeEnv;
  throw new Error(
    'VIDEO_TEST_MEDIA_INGEST_ENABLED is not supported when NODE_ENV is ' +
      `${environment} because controlled test-media ingestion is ` +
      'non-production only; it is allowed solely when NODE_ENV is ' +
      'explicitly development or test.',
  );
}

export function validateEnv(
  config: Record<string, unknown>,
): EnvironmentVariables {
  const validated = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(validated, {
    skipMissingProperties: false,
    whitelist: true,
  });
  if (errors.length > 0) {
    // Report property names only — never echo values (DATABASE_URL carries credentials).
    const properties = errors.map((error) => error.property).join(', ');
    throw new Error(`Invalid environment configuration: ${properties}`);
  }
  assertJwtSecretUsable(validated.JWT_SECRET);
  assertScreeningBypassUnsupported(
    validated.VIDEO_UNSAFE_ALLOW_UNSCREENED_UPLOADS,
  );
  assertTestMediaIngestNonProduction(
    validated.VIDEO_TEST_MEDIA_INGEST_ENABLED,
    validated.NODE_ENV,
  );
  return validated;
}
