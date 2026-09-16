import {
  NodeEnv,
  assertCloudCredentialsComplete,
  assertCloudUrlSecure,
  validateEdgeEnv,
} from './env.validation';

const BASE = {
  EDGE_TENANT_ID: 'tenant-1',
  EDGE_LOCATION_ID: 'location-1',
  EDGE_DEVICE_ID: 'device-1',
  EDGE_STORE_ROOT: './.edge-store',
};

describe('edge environment validation', () => {
  it('accepts the minimal offline configuration', () => {
    const validated = validateEdgeEnv({ ...BASE });
    expect(validated.EDGE_TENANT_ID).toBe('tenant-1');
    expect(validated.EDGE_CLOUD_BASE_URL).toBeUndefined();
  });

  it('rejects a missing identity and names only the property', () => {
    expect(() =>
      validateEdgeEnv({ ...BASE, EDGE_DEVICE_ID: undefined }),
    ).toThrow(/EDGE_DEVICE_ID/);
  });

  it('coerces numeric keys and enforces their bounds', () => {
    const validated = validateEdgeEnv({
      ...BASE,
      EDGE_SYNC_BATCH_SIZE: '25',
    });
    expect(validated.EDGE_SYNC_BATCH_SIZE).toBe(25);
    expect(() =>
      validateEdgeEnv({ ...BASE, EDGE_SYNC_BATCH_SIZE: '5000' }),
    ).toThrow(/EDGE_SYNC_BATCH_SIZE/);
  });

  it('rejects a malformed driver list', () => {
    expect(() =>
      validateEdgeEnv({ ...BASE, EDGE_DRIVERS: 'camera' }),
    ).toThrow(/EDGE_DRIVERS/);
    expect(
      validateEdgeEnv({ ...BASE, EDGE_DRIVERS: 'camera:simulated,esl:simulated' })
        .EDGE_DRIVERS,
    ).toBe('camera:simulated,esl:simulated');
  });

  describe('transport security', () => {
    it('accepts https anywhere', () => {
      expect(() =>
        assertCloudUrlSecure('https://api.example.com', NodeEnv.Production),
      ).not.toThrow();
    });

    it('rejects plaintext http in production', () => {
      expect(() =>
        assertCloudUrlSecure('http://api.example.com', NodeEnv.Production),
      ).toThrow(/https/);
    });

    it('rejects plaintext http to a remote host even in development', () => {
      expect(() =>
        assertCloudUrlSecure('http://api.example.com', NodeEnv.Development),
      ).toThrow(/https/);
    });

    it('allows loopback http only while developing or testing', () => {
      expect(() =>
        assertCloudUrlSecure('http://localhost:3000', NodeEnv.Development),
      ).not.toThrow();
      expect(() =>
        assertCloudUrlSecure('http://127.0.0.1:3000', NodeEnv.Test),
      ).not.toThrow();
      expect(() =>
        assertCloudUrlSecure('http://localhost:3000', NodeEnv.Production),
      ).toThrow(/https/);
    });

    it('rejects a non-http scheme', () => {
      expect(() =>
        assertCloudUrlSecure('ftp://api.example.com', NodeEnv.Production),
      ).toThrow(/https/);
    });

    it('rejects credentials embedded in the URL', () => {
      expect(() =>
        assertCloudUrlSecure(
          'https://user:secret@api.example.com',
          NodeEnv.Production,
        ),
      ).toThrow(/EDGE_CLOUD_TOKEN/);
    });

    it('never echoes the URL value when it cannot be parsed', () => {
      let message = '';
      try {
        assertCloudUrlSecure('not a url with s3cret', NodeEnv.Production);
      } catch (cause) {
        message = (cause as Error).message;
      }
      expect(message).toContain('EDGE_CLOUD_BASE_URL');
      expect(message).not.toContain('s3cret');
    });
  });

  it('refuses a cloud URL without a token', () => {
    expect(() =>
      assertCloudCredentialsComplete('https://api.example.com', undefined),
    ).toThrow(/EDGE_CLOUD_TOKEN/);
    expect(() =>
      assertCloudCredentialsComplete(undefined, undefined),
    ).not.toThrow();
  });

  it('rejects a short device token through the schema', () => {
    expect(() =>
      validateEdgeEnv({
        ...BASE,
        EDGE_CLOUD_BASE_URL: 'https://api.example.com',
        EDGE_CLOUD_TOKEN: 'short',
      }),
    ).toThrow(/EDGE_CLOUD_TOKEN/);
  });
});
