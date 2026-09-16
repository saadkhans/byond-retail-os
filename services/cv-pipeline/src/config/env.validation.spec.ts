import {
  MAX_TRACKING_HEIGHT,
  MAX_TRACKING_WIDTH,
  validateEnv,
} from './env.validation';

const VALID = {
  CV_PIPELINE_API_BASE_URL: 'http://127.0.0.1:3000',
  CV_PIPELINE_API_TOKEN: 'a-token-that-is-long-enough',
};

describe('validateEnv', () => {
  it('accepts a minimal valid configuration', () => {
    expect(() => validateEnv({ ...VALID })).not.toThrow();
  });

  it('requires the API base URL and token', () => {
    expect(() => validateEnv({})).toThrow(/Invalid CV pipeline configuration/);
  });

  it('rejects a short token', () => {
    expect(() =>
      validateEnv({ ...VALID, CV_PIPELINE_API_TOKEN: 'short' }),
    ).toThrow();
  });

  it.each([
    ['credentials in the URL', 'http://user:pass@api.local'],
    ['a query string', 'http://api.local?token=abc'],
    ['a fragment', 'http://api.local#x'],
    ['a non-http scheme', 'rtsp://api.local'],
  ])('rejects an API base URL with %s', (_label, url) => {
    expect(() =>
      validateEnv({ ...VALID, CV_PIPELINE_API_BASE_URL: url }),
    ).toThrow();
  });

  it('never echoes the offending value in the error', () => {
    // The two values most likely to be invalid are the token and the
    // camera source. An error that quotes them puts them in a log.
    const secret = 'super-secret-token-value-12345';
    let message = '';
    try {
      validateEnv({
        CV_PIPELINE_API_BASE_URL: 'not-a-url',
        CV_PIPELINE_API_TOKEN: secret,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('CV_PIPELINE_API_BASE_URL');
    expect(message).not.toContain(secret);
    expect(message).not.toContain('not-a-url');
  });

  it('caps the tracking geometry so tier 1 stays downscaled', () => {
    // ARCHITECTURE.md puts high-resolution pixels in tier 3 only. The cap
    // means nobody can turn the continuous loop into a full-resolution
    // pipeline by editing an environment variable.
    expect(() =>
      validateEnv({
        ...VALID,
        CV_PIPELINE_FRAME_WIDTH: String(MAX_TRACKING_WIDTH + 1),
      }),
    ).toThrow();
    expect(() =>
      validateEnv({
        ...VALID,
        CV_PIPELINE_FRAME_HEIGHT: String(MAX_TRACKING_HEIGHT + 1),
      }),
    ).toThrow();
    expect(() =>
      validateEnv({
        ...VALID,
        CV_PIPELINE_FRAME_WIDTH: String(MAX_TRACKING_WIDTH),
        CV_PIPELINE_FRAME_HEIGHT: String(MAX_TRACKING_HEIGHT),
      }),
    ).not.toThrow();
  });

  it('insists the source key is a NAME, not an address', () => {
    expect(() =>
      validateEnv({
        ...VALID,
        CV_PIPELINE_SOURCE_ENV_KEY: 'rtsp://camera.local/stream1',
      }),
    ).toThrow();
    expect(() =>
      validateEnv({
        ...VALID,
        CV_PIPELINE_SOURCE_ENV_KEY: 'CAMERA_SOURCE_LANE_1',
      }),
    ).not.toThrow();
  });

  it.each([
    ['CV_PIPELINE_FRAME_SOURCE', 'magic'],
    ['CV_PIPELINE_TRACKER', 'magic'],
    ['NODE_ENV', 'staging'],
  ])('rejects an unknown %s value', (key, value) => {
    expect(() => validateEnv({ ...VALID, [key]: value })).toThrow();
  });

  it('rejects out-of-range ratios and intervals', () => {
    expect(() =>
      validateEnv({ ...VALID, CV_PIPELINE_ZONE_COVERAGE_THRESHOLD: '1.5' }),
    ).toThrow();
    expect(() =>
      validateEnv({ ...VALID, CV_PIPELINE_SAMPLE_INTERVAL_MS: '5' }),
    ).toThrow();
    expect(() =>
      validateEnv({ ...VALID, CV_PIPELINE_QUEUE_CAPACITY: '0' }),
    ).toThrow();
  });

  it('rejects a blank numeric value instead of reading it as zero', () => {
    // Implicit conversion turns '' into 0, which would be a silently
    // valid "no retries" or "zero capacity" if the bounds allowed it.
    expect(() =>
      validateEnv({ ...VALID, CV_PIPELINE_QUEUE_MAX_ATTEMPTS: '' }),
    ).toThrow();
  });

  it('returns the raw environment untouched when valid', () => {
    const raw = { ...VALID, CV_PIPELINE_PORT: '4000' };
    expect(validateEnv(raw)).toBe(raw);
  });
});
