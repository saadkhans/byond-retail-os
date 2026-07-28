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

  describe('VIDEO_MAX_UPLOAD_BYTES bounds (Phase 10)', () => {
    it('accepts the default-sized and maximum values', () => {
      expect(() =>
        validateEnv({ ...validConfig, VIDEO_MAX_UPLOAD_BYTES: '52428800' }),
      ).not.toThrow();
      expect(() =>
        validateEnv({ ...validConfig, VIDEO_MAX_UPLOAD_BYTES: '268435456' }),
      ).not.toThrow();
    });

    it('rejects values above the 256 MiB heap-safety cap at boot', () => {
      // Uploads buffer in memory and sizeBytes is a signed 32-bit column: a
      // deployment typo (extra zero) must fail at boot, not at runtime.
      expect(() =>
        validateEnv({ ...validConfig, VIDEO_MAX_UPLOAD_BYTES: '268435457' }),
      ).toThrow(/VIDEO_MAX_UPLOAD_BYTES/);
      expect(() =>
        validateEnv({ ...validConfig, VIDEO_MAX_UPLOAD_BYTES: '2147483648' }),
      ).toThrow(/VIDEO_MAX_UPLOAD_BYTES/);
    });

    it('rejects non-positive values', () => {
      expect(() =>
        validateEnv({ ...validConfig, VIDEO_MAX_UPLOAD_BYTES: '0' }),
      ).toThrow(/VIDEO_MAX_UPLOAD_BYTES/);
    });
  });

  describe('Phase 10 screening flags survive whitelist validation', () => {
    // validateSync runs with whitelist:true — an UNDECLARED key is
    // stripped before ConfigService construction. These flags select the
    // real OCR recognizer and the (non-production) screening bypass, so
    // silently losing them made every deployment's uploads 503.
    it.each(['true', 'false', 'TRUE'])(
      'preserves VIDEO_OCR_ENABLED=%s through validation',
      (value) => {
        const validated = validateEnv({
          ...validConfig,
          VIDEO_OCR_ENABLED: value,
        });
        expect(validated.VIDEO_OCR_ENABLED).toBe(value);
      },
    );

    it('still preserves VIDEO_FFMPEG_ENABLED (regression guard)', () => {
      expect(
        validateEnv({ ...validConfig, VIDEO_FFMPEG_ENABLED: 'true' })
          .VIDEO_FFMPEG_ENABLED,
      ).toBe('true');
    });

    it.each(['yes', '1', 'enabled', 'on'])(
      'rejects invalid VIDEO_OCR_ENABLED=%s at boot',
      (value) => {
        expect(() =>
          validateEnv({ ...validConfig, VIDEO_OCR_ENABLED: value }),
        ).toThrow(/VIDEO_OCR_ENABLED/);
      },
    );

    it('still declares VIDEO_UNSAFE_ALLOW_UNSCREENED_UPLOADS (compatibility): false survives validation', () => {
      // The flag is UNSUPPORTED (true fails startup everywhere) but stays
      // declared so env files that carry it as false keep booting.
      const validated = validateEnv({
        ...validConfig,
        VIDEO_UNSAFE_ALLOW_UNSCREENED_UPLOADS: 'false',
      });
      expect(validated.VIDEO_UNSAFE_ALLOW_UNSCREENED_UPLOADS).toBe('false');
    });

    it.each(['yes', '1', 'never'])(
      'rejects invalid VIDEO_UNSAFE_ALLOW_UNSCREENED_UPLOADS=%s at boot',
      (value) => {
        expect(() =>
          validateEnv({
            ...validConfig,
            VIDEO_UNSAFE_ALLOW_UNSCREENED_UPLOADS: value,
          }),
        ).toThrow(/VIDEO_UNSAFE_ALLOW_UNSCREENED_UPLOADS/);
      },
    );
  });

  describe('VIDEO_UNSAFE_ALLOW_UNSCREENED_UPLOADS is UNSUPPORTED in every environment (startup failure when true)', () => {
    const UNSUPPORTED_MESSAGE =
      'VIDEO_UNSAFE_ALLOW_UNSCREENED_UPLOADS is not supported because ' +
      'raw media cannot be persisted before screening.';

    it.each(['development', 'test', 'production'])(
      'fails validation when NODE_ENV=%s and the flag is true — the payment invariant has no dev/test exception',
      (nodeEnv) => {
        expect(() =>
          validateEnv({
            ...validConfig,
            NODE_ENV: nodeEnv,
            VIDEO_UNSAFE_ALLOW_UNSCREENED_UPLOADS: 'true',
          }),
        ).toThrow(UNSUPPORTED_MESSAGE);
      },
    );

    it('fails validation when NODE_ENV is UNSET and the flag is true', () => {
      const { NODE_ENV: _omit, ...withoutNodeEnv } = validConfig;
      expect(() =>
        validateEnv({
          ...withoutNodeEnv,
          VIDEO_UNSAFE_ALLOW_UNSCREENED_UPLOADS: 'true',
        }),
      ).toThrow(UNSUPPORTED_MESSAGE);
    });

    it('rejects the flag case-insensitively (TRUE)', () => {
      expect(() =>
        validateEnv({
          ...validConfig,
          VIDEO_UNSAFE_ALLOW_UNSCREENED_UPLOADS: 'TRUE',
        }),
      ).toThrow(UNSUPPORTED_MESSAGE);
    });

    it.each(['development', 'test', 'production'])(
      'accepts NODE_ENV=%s with the flag false or unset (declared-for-compatibility)',
      (nodeEnv) => {
        expect(() =>
          validateEnv({
            ...validConfig,
            NODE_ENV: nodeEnv,
            VIDEO_UNSAFE_ALLOW_UNSCREENED_UPLOADS: 'false',
          }),
        ).not.toThrow();
        expect(() =>
          validateEnv({ ...validConfig, NODE_ENV: nodeEnv }),
        ).not.toThrow();
      },
    );

    it('accepts an unset NODE_ENV with the flag false or unset', () => {
      const { NODE_ENV: _omit, ...withoutNodeEnv } = validConfig;
      expect(() =>
        validateEnv({
          ...withoutNodeEnv,
          VIDEO_UNSAFE_ALLOW_UNSCREENED_UPLOADS: 'false',
        }),
      ).not.toThrow();
      expect(() => validateEnv({ ...withoutNodeEnv })).not.toThrow();
    });
  });

  describe('VIDEO_MAX_SCREENING_DURATION_MS bounds (Phase 10 pre-storage screen)', () => {
    it('accepts the default and both boundary values', () => {
      for (const value of ['30000', '1000', '300000']) {
        expect(() =>
          validateEnv({
            ...validConfig,
            VIDEO_MAX_SCREENING_DURATION_MS: value,
          }),
        ).not.toThrow();
      }
    });

    it.each(['999', '0', '-1000'])(
      'rejects sub-second value %s at boot',
      (value) => {
        expect(() =>
          validateEnv({
            ...validConfig,
            VIDEO_MAX_SCREENING_DURATION_MS: value,
          }),
        ).toThrow(/VIDEO_MAX_SCREENING_DURATION_MS/);
      },
    );

    it.each(['300001', '3000000'])(
      'rejects over-cap value %s at boot (bounds the synchronous upload screen)',
      (value) => {
        expect(() =>
          validateEnv({
            ...validConfig,
            VIDEO_MAX_SCREENING_DURATION_MS: value,
          }),
        ).toThrow(/VIDEO_MAX_SCREENING_DURATION_MS/);
      },
    );

    it.each(['abc', '1500.5', ''])(
      'rejects non-integer value %j at boot',
      (value) => {
        expect(() =>
          validateEnv({
            ...validConfig,
            VIDEO_MAX_SCREENING_DURATION_MS: value,
          }),
        ).toThrow(/VIDEO_MAX_SCREENING_DURATION_MS/);
      },
    );
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

  it('accepts a blank CORS_ORIGINS (parseCorsOrigins applies the fallback)', () => {
    // Deployments that materialize unset optional vars as CORS_ORIGINS=
    // must still boot with the safe default allowlist.
    expect(() =>
      validateEnv({ ...validConfig, CORS_ORIGINS: '' }),
    ).not.toThrow();
    expect(() =>
      validateEnv({ ...validConfig, CORS_ORIGINS: 'https://admin.example.com' }),
    ).not.toThrow();
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
