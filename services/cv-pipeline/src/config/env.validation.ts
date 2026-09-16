import { plainToInstance } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

/**
 * Boot-time configuration, validated the way the API validates its own:
 * fail fast and loudly on a bad value rather than discover it as a
 * mystery at 3am. Every key is declared here even when it has a default —
 * the API learned that an undeclared key is silently stripped by the
 * whitelist and then read straight from `process.env` anyway, which makes
 * a flag that looks disabled behave as enabled.
 */

export enum NodeEnv {
  Development = 'development',
  Test = 'test',
  Production = 'production',
}

export enum FrameSourceKind {
  Simulated = 'simulated',
  Ffmpeg = 'ffmpeg',
}

export enum TrackerKind {
  Simulated = 'simulated',
  Motion = 'motion',
}

/**
 * The downscale ceiling. ARCHITECTURE.md is explicit that tier 1 runs on
 * a downscaled stream and that high-resolution pixels belong to tier 3
 * only. Enforcing the ceiling in configuration means nobody can quietly
 * turn the tracking loop into a full-resolution pipeline by editing an
 * environment variable.
 */
export const MAX_TRACKING_WIDTH = 640;
export const MAX_TRACKING_HEIGHT = 480;

class EnvironmentVariables {
  @IsOptional()
  @IsEnum(NodeEnv)
  NODE_ENV?: NodeEnv;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  CV_PIPELINE_PORT?: number;

  /**
   * The API's base URL. Required, and required to be http(s) with no
   * userinfo and no query — the same discipline the camera source is held
   * to, because this value is also interpolated into a request.
   */
  @IsString()
  @Matches(/^https?:\/\/[^@?#\s]+$/, {
    message:
      'CV_PIPELINE_API_BASE_URL must be an http(s) URL with no credentials, ' +
      'query string, or fragment',
  })
  CV_PIPELINE_API_BASE_URL!: string;

  /** Bearer token for a service account holding `inference:manage`.
   *  Never logged, never echoed, never persisted by this service. */
  @IsString()
  @MinLength(16)
  CV_PIPELINE_API_TOKEN!: string;

  @IsOptional()
  @IsInt()
  @Min(1_000)
  @Max(60_000)
  CV_PIPELINE_API_TIMEOUT_MS?: number;

  @IsOptional()
  @IsString()
  @MinLength(1)
  CV_PIPELINE_LOCATION_ID?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  CV_PIPELINE_UNIT_ID?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  CV_PIPELINE_DEVICE_ID?: string;

  @IsOptional()
  @IsEnum(FrameSourceKind)
  CV_PIPELINE_FRAME_SOURCE?: FrameSourceKind;

  @IsOptional()
  @IsEnum(TrackerKind)
  CV_PIPELINE_TRACKER?: TrackerKind;

  /**
   * Name of the environment key holding the camera input, NOT the input
   * itself. The indirection is the point: the address never appears in
   * this service's own validated configuration object, which is the
   * object most likely to be dumped into a log or an error report.
   */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Z][A-Z0-9_]*$/, {
    message:
      'CV_PIPELINE_SOURCE_ENV_KEY must be the NAME of an environment ' +
      'variable holding the camera input, not the input itself',
  })
  CV_PIPELINE_SOURCE_ENV_KEY?: string;

  @IsOptional()
  @IsInt()
  @Min(64)
  @Max(MAX_TRACKING_WIDTH)
  CV_PIPELINE_FRAME_WIDTH?: number;

  @IsOptional()
  @IsInt()
  @Min(64)
  @Max(MAX_TRACKING_HEIGHT)
  CV_PIPELINE_FRAME_HEIGHT?: number;

  @IsOptional()
  @IsInt()
  @Min(40)
  @Max(10_000)
  CV_PIPELINE_SAMPLE_INTERVAL_MS?: number;

  @IsOptional()
  @IsInt()
  @Min(1_000)
  @Max(60_000)
  CV_PIPELINE_FRAME_TIMEOUT_MS?: number;

  /** Zones as JSON: [{"zoneCode":"A1","box":{"x":0,"y":0,"width":0.5,
   *  "height":0.5}}]. Parsed and validated separately. */
  @IsOptional()
  @IsString()
  CV_PIPELINE_ZONES?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(255)
  CV_PIPELINE_PIXEL_DELTA_THRESHOLD?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  CV_PIPELINE_CELL_ACTIVATION_RATIO?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  CV_PIPELINE_ZONE_COVERAGE_THRESHOLD?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  CV_PIPELINE_MOTION_RATIO_THRESHOLD?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(60_000)
  CV_PIPELINE_TRIGGER_MIN_DURATION_MS?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(600_000)
  CV_PIPELINE_TRIGGER_REARM_QUIET_MS?: number;

  @IsOptional()
  @IsInt()
  @Min(1_000)
  @Max(600_000)
  CV_PIPELINE_TRIGGER_MAX_DURATION_MS?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1_000)
  CV_PIPELINE_TRIGGER_RATE_LIMIT?: number;

  @IsOptional()
  @IsInt()
  @Min(1_000)
  @Max(3_600_000)
  CV_PIPELINE_TRIGGER_RATE_WINDOW_MS?: number;

  @IsOptional()
  @IsInt()
  @Min(1_000)
  @Max(600_000)
  CV_PIPELINE_EXIT_QUIET_MS?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10_000)
  CV_PIPELINE_QUEUE_CAPACITY?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  CV_PIPELINE_QUEUE_MAX_ATTEMPTS?: number;

  @IsOptional()
  @IsInt()
  @Min(100)
  @Max(60_000)
  CV_PIPELINE_QUEUE_BACKOFF_BASE_MS?: number;

  @IsOptional()
  @IsInt()
  @Min(1_000)
  @Max(600_000)
  CV_PIPELINE_QUEUE_BACKOFF_MAX_MS?: number;
}

/**
 * Nest's config validator. Numeric environment values arrive as strings,
 * so `enableImplicitConversion` does the coercion — with the deliberate
 * consequence that a blank string becomes 0 and is then caught by the
 * `@Min` bounds above rather than sailing through as a valid zero.
 */
export function validateEnv(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const validated = plainToInstance(EnvironmentVariables, raw, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(validated, {
    skipMissingProperties: false,
    whitelist: false,
  });
  if (errors.length > 0) {
    // Constraint text only — never the offending VALUE, which may be the
    // API token or a camera address.
    const summary = errors
      .map((error) => {
        const constraints = Object.values(error.constraints ?? {});
        return constraints.length > 0
          ? constraints.join('; ')
          : `${error.property} is invalid`;
      })
      .join(' | ');
    throw new Error(`Invalid CV pipeline configuration: ${summary}`);
  }
  return raw;
}
