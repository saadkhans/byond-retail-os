import { ConfigService } from '@nestjs/config';
import {
  buildPipelineConfig,
  parseZones,
  resolveCameraSource,
} from './pipeline.config';
import { FrameSourceKind, TrackerKind } from './env.validation';

/** A ConfigService standing in for validated environment values. */
function configService(values: Record<string, unknown>): ConfigService {
  return {
    get: <T>(key: string): T | undefined => values[key] as T | undefined,
  } as ConfigService;
}

const REQUIRED = {
  CV_PIPELINE_API_BASE_URL: 'http://127.0.0.1:3000',
  CV_PIPELINE_API_TOKEN: 'a-token-that-is-long-enough',
};

describe('parseZones', () => {
  it('returns no zones when unset', () => {
    expect(parseZones(undefined)).toEqual([]);
    expect(parseZones('  ')).toEqual([]);
  });

  it('parses a well-formed zone list', () => {
    const zones = parseZones(
      '[{"zoneCode":"A1","box":{"x":0,"y":0,"width":0.5,"height":0.5}}]',
    );
    expect(zones).toEqual([
      { zoneCode: 'A1', box: { x: 0, y: 0, width: 0.5, height: 0.5 } },
    ]);
  });

  it.each([
    ['invalid JSON', 'not json'],
    ['a non-array', '{"zoneCode":"A1"}'],
    ['a missing zone code', '[{"box":{"x":0,"y":0,"width":1,"height":1}}]'],
    ['a missing box', '[{"zoneCode":"A1"}]'],
    [
      'a non-numeric coordinate',
      '[{"zoneCode":"A1","box":{"x":"0","y":0,"width":1,"height":1}}]',
    ],
    [
      'an un-normalized coordinate',
      '[{"zoneCode":"A1","box":{"x":0,"y":0,"width":2,"height":1}}]',
    ],
    [
      'a zero-area box',
      '[{"zoneCode":"A1","box":{"x":0,"y":0,"width":0,"height":1}}]',
    ],
    [
      'a box that runs off the frame',
      '[{"zoneCode":"A1","box":{"x":0.8,"y":0,"width":0.5,"height":1}}]',
    ],
  ])('rejects %s rather than silently dropping the zone', (_label, raw) => {
    // A pipeline with no zones produces no HAND_IN_ZONE triggers at all,
    // which is the failure mode hardest to notice in production.
    expect(() => parseZones(raw)).toThrow();
  });
});

describe('buildPipelineConfig', () => {
  it('applies documented defaults', () => {
    const config = buildPipelineConfig(configService(REQUIRED));

    expect(config.port).toBe(3100);
    expect(config.frame.width).toBe(320);
    expect(config.frame.height).toBe(240);
    expect(config.frameSource).toBe(FrameSourceKind.Simulated);
    expect(config.tracker).toBe(TrackerKind.Motion);
    expect(config.queue.capacity).toBe(200);
    expect(config.trigger.reArmQuietMs).toBe(2_000);
  });

  it('accepts numeric values as numbers or strings', () => {
    // Validation coerces declared integer keys, so ConfigService can hand
    // back either. The API shipped a boot crash from assuming a string.
    const asNumber = buildPipelineConfig(
      configService({ ...REQUIRED, CV_PIPELINE_PORT: 4000 }),
    );
    const asString = buildPipelineConfig(
      configService({ ...REQUIRED, CV_PIPELINE_PORT: '4000' }),
    );
    expect(asNumber.port).toBe(4000);
    expect(asString.port).toBe(4000);
  });

  it('falls back when a numeric value is unusable', () => {
    const config = buildPipelineConfig(
      configService({ ...REQUIRED, CV_PIPELINE_PORT: 'not-a-number' }),
    );
    expect(config.port).toBe(3100);
  });

  it('strips a trailing slash from the API base URL', () => {
    const config = buildPipelineConfig(
      configService({
        ...REQUIRED,
        CV_PIPELINE_API_BASE_URL: 'http://127.0.0.1:3000///',
      }),
    );
    expect(config.api.baseUrl).toBe('http://127.0.0.1:3000');
  });

  it('requires the API base URL and token', () => {
    expect(() => buildPipelineConfig(configService({}))).toThrow();
    expect(() =>
      buildPipelineConfig(
        configService({ CV_PIPELINE_API_BASE_URL: 'http://127.0.0.1:3000' }),
      ),
    ).toThrow();
  });

  it('holds the camera source KEY, never the camera source', () => {
    const config = buildPipelineConfig(
      configService({
        ...REQUIRED,
        CV_PIPELINE_SOURCE_ENV_KEY: 'CAMERA_SOURCE_LANE_1',
      }),
    );

    expect(config.sourceEnvKey).toBe('CAMERA_SOURCE_LANE_1');
    // The whole config object, serialised: no address anywhere in it.
    expect(JSON.stringify(config)).not.toContain('rtsp');
  });
});

describe('resolveCameraSource', () => {
  it('reads the value from the named key', () => {
    expect(
      resolveCameraSource('CAMERA_SOURCE_LANE_1', {
        CAMERA_SOURCE_LANE_1: 'rtsp://camera.local/stream1',
      }),
    ).toBe('rtsp://camera.local/stream1');
  });

  it('returns null when no key is configured', () => {
    expect(resolveCameraSource(null, {})).toBeNull();
  });

  it('treats a missing or blank value as unconfigured', () => {
    expect(resolveCameraSource('MISSING_KEY', {})).toBeNull();
    expect(resolveCameraSource('BLANK', { BLANK: '' })).toBeNull();
  });
});
