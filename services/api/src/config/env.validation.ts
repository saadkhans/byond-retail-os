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
  @IsOptional()
  @IsString()
  @MinLength(1)
  CORS_ORIGINS?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(65535)
  PORT?: number;

  @IsOptional()
  @IsEnum(NodeEnv)
  NODE_ENV?: NodeEnv;
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

export function assertJwtSecretUsable(secret: string): void {
  // Never echo the secret value in errors.
  if (PLACEHOLDER_JWT_PATTERNS.some((pattern) => pattern.test(secret))) {
    throw new Error(
      'JWT_SECRET looks like a placeholder; generate a real secret, e.g. ' +
        'node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"',
    );
  }
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
  return validated;
}
