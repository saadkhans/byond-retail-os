import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { parseTrustProxy, validateEnv } from './env.validation';

describe('validateEnv', () => {
  // Generated at runtime so no secret-looking literal is ever committed;
  // the prefix contains no placeholder-marker words.
  const makeJwtSecret = () =>
    `test-jwt-${randomBytes(24).toString('base64url')}`;

  const validConfig = {
    DATABASE_URL: 'postgresql://byond:byond@localhost:5432/byond_test',
    JWT_SECRET: makeJwtSecret(),
    NODE_ENV: 'development',
  };

  it('accepts a valid configuration', () => {
    expect(() => validateEnv({ ...validConfig })).not.toThrow();
  });

  it('rejects a missing JWT_SECRET without echoing values', () => {
    const { JWT_SECRET: _omit, ...withoutSecret } = validConfig;
    expect(() => validateEnv(withoutSecret)).toThrow(
      /Invalid environment configuration: .*JWT_SECRET/,
    );
  });

  it('rejects secrets shorter than 32 characters', () => {
    expect(() =>
      validateEnv({ ...validConfig, JWT_SECRET: 'short-jwt-fixture' }),
    ).toThrow(/JWT_SECRET/);
  });

  describe('placeholder secrets are rejected in EVERY environment', () => {
    const placeholderSecrets = [
      'local-dev-only-placeholder-jwt-secret-change-me', // old .env.example value
      'this-value-says-changeme-0123456789abcdef',
      'change-me-please-0123456789abcdef-abcdef',
      'replace-me-0123456789abcdef-abcdefabcdef',
      'placeholder-0123456789abcdef-abcdefabcde',
      'example-0123456789abcdef-abcdefabcdefab',
      'dev-only-0123456789abcdef-abcdefabcdefa',
      'test-only-jwt-0123456789abcdef-abcdefab',
      'my-jwt-secret-0123456789abcdef-abcdefab',
      'local-secret-0123456789abcdef-abcdefabc',
      'test-secret-0123456789abcdef-abcdefabcd',
      'your-secret-0123456789abcdef-abcdefabcd',
      'insecure-0123456789abcdef-abcdefabcdefa',
    ];

    it.each(['development', 'test', 'production'])(
      'rejects placeholder-looking secrets when NODE_ENV=%s',
      (nodeEnv) => {
        for (const secret of placeholderSecrets) {
          expect(() =>
            validateEnv({
              ...validConfig,
              NODE_ENV: nodeEnv,
              JWT_SECRET: secret,
            }),
          ).toThrow(/looks like a placeholder/);
        }
      },
    );

    it('never echoes the rejected secret value in the error', () => {
      try {
        validateEnv({
          ...validConfig,
          JWT_SECRET: 'this-value-says-changeme-0123456789abcdef',
        });
        throw new Error('expected validateEnv to throw');
      } catch (error) {
        expect((error as Error).message).not.toContain('changeme-0123456789');
      }
    });
  });

  it('accepts a generated secret in production', () => {
    expect(() =>
      validateEnv({
        ...validConfig,
        NODE_ENV: 'production',
        JWT_SECRET: makeJwtSecret(),
      }),
    ).not.toThrow();
  });

  describe('JWT_EXPIRES_IN duration syntax (explicit unit required)', () => {
    it.each(['500ms', '3600s', '15m', '1h', '7d'])(
      'accepts %j',
      (value) => {
        expect(() =>
          validateEnv({ ...validConfig, JWT_EXPIRES_IN: value }),
        ).not.toThrow();
      },
    );

    it.each(['900', '0', 'forever', 'abc', '1year', '', '15 minutes', 'm15'])(
      'rejects %j (unitless or malformed) at boot',
      (value) => {
        // jsonwebtoken reads a unitless string as MILLISECONDS — "900"
        // would silently issue 0.9-second tokens.
        expect(() =>
          validateEnv({ ...validConfig, JWT_EXPIRES_IN: value }),
        ).toThrow(/JWT_EXPIRES_IN/);
      },
    );

    it.each(['0s', '0m', '0h', '00d', '000ms'])(
      'rejects zero duration %j at boot',
      (value) => {
        // A zero lifetime passes jsonwebtoken but every issued token is
        // already expired — login "succeeds" yet no request authenticates.
        expect(() =>
          validateEnv({ ...validConfig, JWT_EXPIRES_IN: value }),
        ).toThrow(/JWT_EXPIRES_IN/);
      },
    );

    it.each(['01h', '010m'])(
      'still accepts zero-padded non-zero duration %j',
      (value) => {
        expect(() =>
          validateEnv({ ...validConfig, JWT_EXPIRES_IN: value }),
        ).not.toThrow();
      },
    );
  });

  describe('TRUST_PROXY', () => {
    it.each(['true', 'false', 'loopback', 'linklocal', 'uniquelocal', '1', '2'])(
      'accepts %j',
      (value) => {
        expect(() =>
          validateEnv({ ...validConfig, TRUST_PROXY: value }),
        ).not.toThrow();
      },
    );

    it.each(['yes', 'on', '10.0.0.0/8, loopback', 'proxy'])(
      'rejects unsupported value %j',
      (value) => {
        expect(() =>
          validateEnv({ ...validConfig, TRUST_PROXY: value }),
        ).toThrow(/TRUST_PROXY/);
      },
    );
  });

  describe('parseTrustProxy', () => {
    it('defaults to false (proxy headers never trusted implicitly)', () => {
      expect(parseTrustProxy(undefined)).toBe(false);
      expect(parseTrustProxy('')).toBe(false);
      expect(parseTrustProxy('false')).toBe(false);
    });

    it('parses booleans, hop counts, and keyword subnets', () => {
      expect(parseTrustProxy('true')).toBe(true);
      expect(parseTrustProxy('1')).toBe(1);
      expect(parseTrustProxy('2')).toBe(2);
      expect(parseTrustProxy('loopback')).toBe('loopback');
      expect(parseTrustProxy('LINKLOCAL')).toBe('linklocal');
    });
  });

  it('validates throttle overrides as positive integers', () => {
    expect(() =>
      validateEnv({ ...validConfig, LOGIN_THROTTLE_LIMIT: '5' }),
    ).not.toThrow();
    expect(() =>
      validateEnv({ ...validConfig, LOGIN_THROTTLE_LIMIT: '0' }),
    ).toThrow(/LOGIN_THROTTLE_LIMIT/);
    expect(() =>
      validateEnv({ ...validConfig, LOGIN_THROTTLE_IP_LIMIT: '20' }),
    ).not.toThrow();
    expect(() =>
      validateEnv({ ...validConfig, LOGIN_THROTTLE_IP_LIMIT: '0' }),
    ).toThrow(/LOGIN_THROTTLE_IP_LIMIT/);
  });
});
