import { ConfigService } from '@nestjs/config';
import { ShelfZone, NormalizedBox } from '../tracking/tracking.types';
import { TriggerPolicyConfig } from '../trigger/trigger.types';
import { TriggerQueueConfig } from '../jobs/trigger-queue';
import { FrameSourceKind, TrackerKind } from './env.validation';

/**
 * The typed configuration the rest of the service reads. Assembled once
 * at boot from validated environment variables, with every default stated
 * here rather than scattered across constructors.
 *
 * The camera address is deliberately absent from this object. It is
 * resolved separately, held only by the frame source, and never returned
 * — see `resolveCameraSource`.
 */
export interface PipelineConfig {
  port: number;
  api: {
    baseUrl: string;
    token: string;
    timeoutMs: number;
  };
  context: {
    locationId?: string;
    unitId?: string;
    deviceId?: string;
  };
  frameSource: FrameSourceKind;
  tracker: TrackerKind;
  sourceEnvKey: string | null;
  frame: {
    width: number;
    height: number;
    intervalMs: number;
    timeoutMs: number;
  };
  motion: {
    pixelDeltaThreshold: number;
    cellActivationRatio: number;
  };
  zones: ShelfZone[];
  trigger: TriggerPolicyConfig;
  queue: TriggerQueueConfig;
}

/** Reads a number with a default. `@IsInt` keys come back as numbers from
 *  ConfigService once implicit conversion has run, so this must accept
 *  both — the API shipped a boot crash caused by calling a string method
 *  on one of these. */
function num(
  config: ConfigService,
  key: string,
  fallback: number,
): number {
  const raw = config.get<string | number>(key);
  if (raw === undefined || raw === null || raw === '') {
    return fallback;
  }
  const value = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function str(config: ConfigService, key: string): string | undefined {
  const raw = config.get<string>(key);
  return raw === undefined || raw === null || raw === '' ? undefined : raw;
}

/**
 * Parses the zone list. A malformed zone list is a configuration error,
 * not something to shrug off: a tracker with no zones silently stops
 * producing the HAND_IN_ZONE triggers the whole pipeline exists for.
 */
export function parseZones(raw: string | undefined): ShelfZone[] {
  if (raw === undefined || raw.trim() === '') {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('CV_PIPELINE_ZONES is not valid JSON');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('CV_PIPELINE_ZONES must be a JSON array');
  }
  return parsed.map((entry, index) => {
    if (entry === null || typeof entry !== 'object') {
      throw new Error(`CV_PIPELINE_ZONES[${index}] must be an object`);
    }
    const zoneCode = (entry as { zoneCode?: unknown }).zoneCode;
    const box = (entry as { box?: unknown }).box;
    if (typeof zoneCode !== 'string' || zoneCode.trim() === '') {
      throw new Error(`CV_PIPELINE_ZONES[${index}].zoneCode must be a string`);
    }
    return { zoneCode, box: parseBox(box, index) };
  });
}

function parseBox(box: unknown, index: number): NormalizedBox {
  if (box === null || typeof box !== 'object') {
    throw new Error(`CV_PIPELINE_ZONES[${index}].box must be an object`);
  }
  const read = (key: 'x' | 'y' | 'width' | 'height'): number => {
    const value = (box as Record<string, unknown>)[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(
        `CV_PIPELINE_ZONES[${index}].box.${key} must be a number`,
      );
    }
    if (value < 0 || value > 1) {
      throw new Error(
        `CV_PIPELINE_ZONES[${index}].box.${key} must be normalized (0..1)`,
      );
    }
    return value;
  };
  const parsedBox = {
    x: read('x'),
    y: read('y'),
    width: read('width'),
    height: read('height'),
  };
  if (parsedBox.width <= 0 || parsedBox.height <= 0) {
    throw new Error(
      `CV_PIPELINE_ZONES[${index}].box must have a positive width and height`,
    );
  }
  if (parsedBox.x + parsedBox.width > 1 || parsedBox.y + parsedBox.height > 1) {
    throw new Error(
      `CV_PIPELINE_ZONES[${index}].box must fit inside the frame`,
    );
  }
  return parsedBox;
}

export function buildPipelineConfig(config: ConfigService): PipelineConfig {
  const baseUrl = str(config, 'CV_PIPELINE_API_BASE_URL');
  const token = str(config, 'CV_PIPELINE_API_TOKEN');
  if (baseUrl === undefined || token === undefined) {
    // validateEnv already enforces this; the check keeps the types honest
    // without a non-null assertion.
    throw new Error(
      'CV_PIPELINE_API_BASE_URL and CV_PIPELINE_API_TOKEN are required',
    );
  }

  return {
    port: num(config, 'CV_PIPELINE_PORT', 3100),
    api: {
      // Trailing slashes would produce a double slash in the request path,
      // which some gateways treat as a different route entirely.
      baseUrl: baseUrl.replace(/\/+$/, ''),
      token,
      timeoutMs: num(config, 'CV_PIPELINE_API_TIMEOUT_MS', 10_000),
    },
    context: {
      locationId: str(config, 'CV_PIPELINE_LOCATION_ID'),
      unitId: str(config, 'CV_PIPELINE_UNIT_ID'),
      deviceId: str(config, 'CV_PIPELINE_DEVICE_ID'),
    },
    frameSource:
      (str(config, 'CV_PIPELINE_FRAME_SOURCE') as FrameSourceKind | undefined) ??
      FrameSourceKind.Simulated,
    tracker:
      (str(config, 'CV_PIPELINE_TRACKER') as TrackerKind | undefined) ??
      TrackerKind.Motion,
    sourceEnvKey: str(config, 'CV_PIPELINE_SOURCE_ENV_KEY') ?? null,
    frame: {
      width: num(config, 'CV_PIPELINE_FRAME_WIDTH', 320),
      height: num(config, 'CV_PIPELINE_FRAME_HEIGHT', 240),
      intervalMs: num(config, 'CV_PIPELINE_SAMPLE_INTERVAL_MS', 200),
      timeoutMs: num(config, 'CV_PIPELINE_FRAME_TIMEOUT_MS', 5_000),
    },
    motion: {
      pixelDeltaThreshold: num(config, 'CV_PIPELINE_PIXEL_DELTA_THRESHOLD', 18),
      cellActivationRatio: num(
        config,
        'CV_PIPELINE_CELL_ACTIVATION_RATIO',
        0.12,
      ),
    },
    zones: parseZones(str(config, 'CV_PIPELINE_ZONES')),
    trigger: {
      zoneCoverageThreshold: num(
        config,
        'CV_PIPELINE_ZONE_COVERAGE_THRESHOLD',
        0.2,
      ),
      motionRatioThreshold: num(
        config,
        'CV_PIPELINE_MOTION_RATIO_THRESHOLD',
        0.04,
      ),
      minDurationMs: num(config, 'CV_PIPELINE_TRIGGER_MIN_DURATION_MS', 400),
      reArmQuietMs: num(config, 'CV_PIPELINE_TRIGGER_REARM_QUIET_MS', 2_000),
      maxDurationMs: num(
        config,
        'CV_PIPELINE_TRIGGER_MAX_DURATION_MS',
        15_000,
      ),
      rateLimitPerWindow: num(config, 'CV_PIPELINE_TRIGGER_RATE_LIMIT', 20),
      rateLimitWindowMs: num(
        config,
        'CV_PIPELINE_TRIGGER_RATE_WINDOW_MS',
        60_000,
      ),
      exitQuietMs: num(config, 'CV_PIPELINE_EXIT_QUIET_MS', 8_000),
    },
    queue: {
      capacity: num(config, 'CV_PIPELINE_QUEUE_CAPACITY', 200),
      maxAttempts: num(config, 'CV_PIPELINE_QUEUE_MAX_ATTEMPTS', 5),
      backoffBaseMs: num(config, 'CV_PIPELINE_QUEUE_BACKOFF_BASE_MS', 1_000),
      backoffMaxMs: num(config, 'CV_PIPELINE_QUEUE_BACKOFF_MAX_MS', 30_000),
    },
  };
}

/**
 * Resolves the camera input from the environment key named by
 * configuration, and hands it straight to the caller that constructs the
 * frame source.
 *
 * The indirection matters. Putting the address in `CV_PIPELINE_SOURCE`
 * would place it in the validated configuration object, in the Nest
 * config cache, and in anything that ever serialises either. Naming the
 * KEY instead means the address is read once, at one call site, into one
 * private field.
 */
export function resolveCameraSource(
  envKey: string | null,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (envKey === null) {
    return null;
  }
  const value = env[envKey];
  return value === undefined || value === '' ? null : value;
}
