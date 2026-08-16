import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import {
  isEnvFlagEnabled,
  parseTrustProxy,
  validateEnv,
} from './env.validation';

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

  describe('VIDEO_MAX_SCREENING_FRAMES bounds (Phase 10 exhaustive pre-storage screen)', () => {
    it('accepts the default and both boundary values', () => {
      for (const value of ['900', '30', '3600']) {
        expect(() =>
          validateEnv({
            ...validConfig,
            VIDEO_MAX_SCREENING_FRAMES: value,
          }),
        ).not.toThrow();
      }
    });

    it.each(['29', '0', '-900'])(
      'rejects under-floor value %s at boot',
      (value) => {
        expect(() =>
          validateEnv({
            ...validConfig,
            VIDEO_MAX_SCREENING_FRAMES: value,
          }),
        ).toThrow(/VIDEO_MAX_SCREENING_FRAMES/);
      },
    );

    it.each(['3601', '100000'])(
      'rejects over-cap value %s at boot (bounds the synchronous per-upload OCR work)',
      (value) => {
        expect(() =>
          validateEnv({
            ...validConfig,
            VIDEO_MAX_SCREENING_FRAMES: value,
          }),
        ).toThrow(/VIDEO_MAX_SCREENING_FRAMES/);
      },
    );

    it.each(['abc', '450.5', ''])(
      'rejects non-integer value %j at boot',
      (value) => {
        expect(() =>
          validateEnv({
            ...validConfig,
            VIDEO_MAX_SCREENING_FRAMES: value,
          }),
        ).toThrow(/VIDEO_MAX_SCREENING_FRAMES/);
      },
    );
  });

  describe('VIDEO_TEST_MEDIA_INGEST_ENABLED is NON-PRODUCTION ONLY (startup failure outside development/test)', () => {
    const messageFor = (environment: string) =>
      'VIDEO_TEST_MEDIA_INGEST_ENABLED is not supported when NODE_ENV is ' +
      `${environment} because controlled test-media ingestion is ` +
      'non-production only; it is allowed solely when NODE_ENV is ' +
      'explicitly development or test.';

    it.each(['development', 'test'])(
      'accepts the flag as true when NODE_ENV=%s',
      (nodeEnv) => {
        const validated = validateEnv({
          ...validConfig,
          NODE_ENV: nodeEnv,
          VIDEO_TEST_MEDIA_INGEST_ENABLED: 'true',
        });
        // whitelist:true strips undeclared keys — the gate must survive.
        expect(validated.VIDEO_TEST_MEDIA_INGEST_ENABLED).toBe('true');
      },
    );

    it('fails validation when NODE_ENV=production and the flag is true', () => {
      expect(() =>
        validateEnv({
          ...validConfig,
          NODE_ENV: 'production',
          VIDEO_TEST_MEDIA_INGEST_ENABLED: 'true',
        }),
      ).toThrow(messageFor('production'));
    });

    it('fails validation when NODE_ENV is UNSET and the flag is true (the previously-fixed unset hole)', () => {
      const { NODE_ENV: _omit, ...withoutNodeEnv } = validConfig;
      expect(() =>
        validateEnv({
          ...withoutNodeEnv,
          VIDEO_TEST_MEDIA_INGEST_ENABLED: 'true',
        }),
      ).toThrow(messageFor('unset'));
    });

    it.each(['staging', 'prod', 'Development'])(
      'rejects NODE_ENV=%s with the flag true (non-enum values fail upstream)',
      (nodeEnv) => {
        expect(() =>
          validateEnv({
            ...validConfig,
            NODE_ENV: nodeEnv,
            VIDEO_TEST_MEDIA_INGEST_ENABLED: 'true',
          }),
        ).toThrow(/NODE_ENV/);
      },
    );

    it('rejects the flag case-insensitively outside development/test (TRUE)', () => {
      expect(() =>
        validateEnv({
          ...validConfig,
          NODE_ENV: 'production',
          VIDEO_TEST_MEDIA_INGEST_ENABLED: 'TRUE',
        }),
      ).toThrow(messageFor('production'));
    });

    describe('spelling parity: TRUE behaves EXACTLY like true (isEnvFlagEnabled)', () => {
      // The outage this pins: a `TRUE` deployment that boots and selects the
      // real tooling must not read as "disabled" anywhere downstream — the
      // startup rule and the upload gate share one definition of enabled.
      it.each(['development', 'test'])(
        'accepts TRUE when NODE_ENV=%s, exactly as it accepts true',
        (nodeEnv) => {
          const validated = validateEnv({
            ...validConfig,
            NODE_ENV: nodeEnv,
            VIDEO_TEST_MEDIA_INGEST_ENABLED: 'TRUE',
          });
          // whitelist:true strips undeclared keys — the gate must survive,
          // and the raw spelling is preserved for the consumer to normalize.
          expect(validated.VIDEO_TEST_MEDIA_INGEST_ENABLED).toBe('TRUE');
          expect(
            isEnvFlagEnabled(validated.VIDEO_TEST_MEDIA_INGEST_ENABLED),
          ).toBe(true);
        },
      );

      it.each(['true', 'TRUE', 'True'])(
        'rejects %s at startup when NODE_ENV=production',
        (value) => {
          expect(() =>
            validateEnv({
              ...validConfig,
              NODE_ENV: 'production',
              VIDEO_TEST_MEDIA_INGEST_ENABLED: value,
            }),
          ).toThrow(messageFor('production'));
        },
      );

      it.each(['true', 'TRUE', 'True'])(
        'rejects %s at startup when NODE_ENV is UNSET',
        (value) => {
          const { NODE_ENV: _omit, ...withoutNodeEnv } = validConfig;
          expect(() =>
            validateEnv({
              ...withoutNodeEnv,
              VIDEO_TEST_MEDIA_INGEST_ENABLED: value,
            }),
          ).toThrow(messageFor('unset'));
        },
      );

      it.each(['false', 'FALSE', 'False'])(
        'accepts %s in every environment (disabled spellings agree too)',
        (value) => {
          for (const nodeEnv of ['development', 'test', 'production']) {
            expect(() =>
              validateEnv({
                ...validConfig,
                NODE_ENV: nodeEnv,
                VIDEO_TEST_MEDIA_INGEST_ENABLED: value,
              }),
            ).not.toThrow();
          }
        },
      );
    });

    it.each(['development', 'test', 'production'])(
      'accepts NODE_ENV=%s with the flag false or unset',
      (nodeEnv) => {
        expect(() =>
          validateEnv({
            ...validConfig,
            NODE_ENV: nodeEnv,
            VIDEO_TEST_MEDIA_INGEST_ENABLED: 'false',
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
          VIDEO_TEST_MEDIA_INGEST_ENABLED: 'false',
        }),
      ).not.toThrow();
      expect(() => validateEnv({ ...withoutNodeEnv })).not.toThrow();
    });

    it.each(['yes', '1', 'on'])(
      'rejects invalid VIDEO_TEST_MEDIA_INGEST_ENABLED=%s at boot (boolean shape rule)',
      (value) => {
        expect(() =>
          validateEnv({
            ...validConfig,
            VIDEO_TEST_MEDIA_INGEST_ENABLED: value,
          }),
        ).toThrow(/VIDEO_TEST_MEDIA_INGEST_ENABLED/);
      },
    );
  });

  describe('PICKUP_VLM_FAULT is NON-PRODUCTION ONLY (startup failure outside development/test)', () => {
    const messageFor = (fault: string, environment: string) =>
      `PICKUP_VLM_FAULT=${fault} is not supported when NODE_ENV is ` +
      `${environment} because VLM fault injection is a controlled-test ` +
      'drill; it is allowed solely when NODE_ENV is explicitly ' +
      'development or test.';

    it.each(['development', 'test', 'production'])(
      'accepts NONE (and unset) in NODE_ENV=%s',
      (nodeEnv) => {
        expect(() =>
          validateEnv({ ...validConfig, NODE_ENV: nodeEnv, PICKUP_VLM_FAULT: 'NONE' }),
        ).not.toThrow();
        expect(() =>
          validateEnv({ ...validConfig, NODE_ENV: nodeEnv }),
        ).not.toThrow();
      },
    );

    it.each([
      ['UNAVAILABLE', 'development'],
      ['UNAVAILABLE', 'test'],
      ['INVALID_SKU', 'development'],
      ['INVALID_SKU', 'test'],
    ])('accepts %s when NODE_ENV=%s', (fault, nodeEnv) => {
      const validated = validateEnv({
        ...validConfig,
        NODE_ENV: nodeEnv,
        PICKUP_VLM_FAULT: fault,
      });
      expect(validated.PICKUP_VLM_FAULT).toBe(fault);
    });

    it.each(['UNAVAILABLE', 'INVALID_SKU'])(
      'fails validation when NODE_ENV=production and PICKUP_VLM_FAULT=%s',
      (fault) => {
        expect(() =>
          validateEnv({
            ...validConfig,
            NODE_ENV: 'production',
            PICKUP_VLM_FAULT: fault,
          }),
        ).toThrow(messageFor(fault, 'production'));
      },
    );

    it('fails validation when NODE_ENV is UNSET and a fault is armed (same hole as production)', () => {
      const { NODE_ENV: _omit, ...withoutNodeEnv } = validConfig;
      expect(() =>
        validateEnv({ ...withoutNodeEnv, PICKUP_VLM_FAULT: 'UNAVAILABLE' }),
      ).toThrow(messageFor('UNAVAILABLE', 'unset'));
    });

    it('rejects NODE_ENV=staging with a fault armed (non-enum NODE_ENV fails upstream)', () => {
      expect(() =>
        validateEnv({
          ...validConfig,
          NODE_ENV: 'staging',
          PICKUP_VLM_FAULT: 'INVALID_SKU',
        }),
      ).toThrow(/NODE_ENV/);
    });
  });

  describe('VIDEO_SCREENING_TIMEOUT_MS bounds (Phase 10 upload-wide screening deadline)', () => {
    it('accepts the default and both boundary values', () => {
      for (const value of ['30000', '1000', '300000']) {
        expect(() =>
          validateEnv({
            ...validConfig,
            VIDEO_SCREENING_TIMEOUT_MS: value,
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
            VIDEO_SCREENING_TIMEOUT_MS: value,
          }),
        ).toThrow(/VIDEO_SCREENING_TIMEOUT_MS/);
      },
    );

    it.each(['300001', '3000000'])(
      'rejects over-cap value %s at boot (bounds the wall-clock an upload can hold)',
      (value) => {
        expect(() =>
          validateEnv({
            ...validConfig,
            VIDEO_SCREENING_TIMEOUT_MS: value,
          }),
        ).toThrow(/VIDEO_SCREENING_TIMEOUT_MS/);
      },
    );

    it.each(['abc', '1500.5', ''])(
      'rejects non-integer value %j at boot',
      (value) => {
        expect(() =>
          validateEnv({
            ...validConfig,
            VIDEO_SCREENING_TIMEOUT_MS: value,
          }),
        ).toThrow(/VIDEO_SCREENING_TIMEOUT_MS/);
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

  describe('PICKUP_* settings (pickup detection / fusion)', () => {
    // Declared so the env contract is explicit — whitelist:true validation
    // must never strip them, and a deployment typo fails at boot instead
    // of a consumer silently falling back to its default.
    it.each([
      'PICKUP_DETECTION_ENABLED',
      'PICKUP_LAB_MODE',
      'PICKUP_VLM_ENABLED',
      'PICKUP_VLM_LEGACY_COMPAT',
    ])('preserves boolean flag %s through validation', (key) => {
      const validated = validateEnv({ ...validConfig, [key]: 'true' });
      expect(
        (validated as unknown as Record<string, unknown>)[key],
      ).toBe('true');
    });

    it.each(['yes', '1', 'enabled', 'on'])(
      'rejects invalid PICKUP_DETECTION_ENABLED=%s at boot',
      (value) => {
        expect(() =>
          validateEnv({ ...validConfig, PICKUP_DETECTION_ENABLED: value }),
        ).toThrow(/PICKUP_DETECTION_ENABLED/);
      },
    );

    it.each(['yes', 'on', 'production'])(
      'rejects invalid PICKUP_LAB_MODE=%s at boot',
      (value) => {
        expect(() =>
          validateEnv({ ...validConfig, PICKUP_LAB_MODE: value }),
        ).toThrow(/PICKUP_LAB_MODE/);
      },
    );

    it('preserves the numeric knobs (implicit string→number conversion)', () => {
      const validated = validateEnv({
        ...validConfig,
        PICKUP_ANALYSIS_FPS: '2.5',
        PICKUP_CONFIDENCE_THRESHOLD: '0.62',
        PICKUP_FUSION_AUTO_THRESHOLD: '0.42',
        PICKUP_FUSION_VLM_LOW: '0.22',
        PICKUP_FUSION_MARGIN: '0.08',
        PICKUP_VLM_TIMEOUT_MS: '60000',
        PICKUP_VLM_NUM_CTX: '8192',
      });
      expect(validated.PICKUP_ANALYSIS_FPS).toBe(2.5);
      expect(validated.PICKUP_CONFIDENCE_THRESHOLD).toBe(0.62);
      expect(validated.PICKUP_FUSION_AUTO_THRESHOLD).toBe(0.42);
      expect(validated.PICKUP_FUSION_VLM_LOW).toBe(0.22);
      expect(validated.PICKUP_FUSION_MARGIN).toBe(0.08);
      expect(validated.PICKUP_VLM_TIMEOUT_MS).toBe(60_000);
      expect(validated.PICKUP_VLM_NUM_CTX).toBe(8192);
    });

    it('rejects out-of-range numeric knobs at boot', () => {
      expect(() =>
        validateEnv({ ...validConfig, PICKUP_ANALYSIS_FPS: '30' }),
      ).toThrow(/PICKUP_ANALYSIS_FPS/);
      expect(() =>
        validateEnv({ ...validConfig, PICKUP_CONFIDENCE_THRESHOLD: '1.5' }),
      ).toThrow(/PICKUP_CONFIDENCE_THRESHOLD/);
      expect(() =>
        validateEnv({ ...validConfig, PICKUP_VLM_TIMEOUT_MS: '600001' }),
      ).toThrow(/PICKUP_VLM_TIMEOUT_MS/);
      expect(() =>
        validateEnv({ ...validConfig, PICKUP_VLM_NUM_CTX: '256' }),
      ).toThrow(/PICKUP_VLM_NUM_CTX/);
    });

    it('constrains provider and mode to their supported values', () => {
      expect(() =>
        validateEnv({ ...validConfig, PICKUP_VLM_PROVIDER: 'local' }),
      ).not.toThrow();
      expect(() =>
        validateEnv({ ...validConfig, PICKUP_VLM_PROVIDER: 'anthropic' }),
      ).not.toThrow();
      expect(() =>
        validateEnv({ ...validConfig, PICKUP_VLM_PROVIDER: 'ollama' }),
      ).toThrow(/PICKUP_VLM_PROVIDER/);
      expect(() =>
        validateEnv({ ...validConfig, PICKUP_VLM_MODE: 'VALIDATION_ALWAYS' }),
      ).not.toThrow();
      expect(() =>
        validateEnv({ ...validConfig, PICKUP_VLM_MODE: 'ALWAYS' }),
      ).toThrow(/PICKUP_VLM_MODE/);
    });

    it('preserves the string settings through validation', () => {
      const validated = validateEnv({
        ...validConfig,
        PICKUP_VLM_BASE_URL: 'http://127.0.0.1:11434',
        PICKUP_VLM_ENDPOINT: 'https://api.example.test/v1/messages',
        PICKUP_VLM_MODEL: 'qwen2.5vl:7b',
        PICKUP_YOLO_MODEL_PATH: 'models/yolo.onnx',
      });
      expect(validated.PICKUP_VLM_BASE_URL).toBe('http://127.0.0.1:11434');
      expect(validated.PICKUP_VLM_ENDPOINT).toBe(
        'https://api.example.test/v1/messages',
      );
      expect(validated.PICKUP_VLM_MODEL).toBe('qwen2.5vl:7b');
      expect(validated.PICKUP_YOLO_MODEL_PATH).toBe('models/yolo.onnx');
    });
  });
});

describe('isEnvFlagEnabled (single source of truth for Phase 10 boolean flags)', () => {
  // Startup validation, the video-ingest module adapter factories, and the
  // upload gate must all agree on what "enabled" means. Anything looser here
  // silently widens every gate; anything stricter reopens the
  // TRUE-boots-but-503s-every-upload bug.
  it.each(['true', 'TRUE', 'True', 'tRuE'])(
    'treats %j as enabled (case-insensitive, matching @Matches(/^(true|false)$/i))',
    (value) => {
      expect(isEnvFlagEnabled(value)).toBe(true);
    },
  );

  it.each([' true ', '\ttrue\n', ' TRUE '])(
    'trims surrounding whitespace before comparing: %j',
    (value) => {
      expect(isEnvFlagEnabled(value)).toBe(true);
    },
  );

  it.each(['false', 'FALSE', 'False', ' false ', ''])(
    'treats %j as disabled',
    (value) => {
      expect(isEnvFlagEnabled(value)).toBe(false);
    },
  );

  it('treats an unset flag as disabled (off by default)', () => {
    expect(isEnvFlagEnabled(undefined)).toBe(false);
  });

  it.each(['yes', '1', 'on', 'enabled', 'truthy', 'y'])(
    'FAILS CLOSED on unexpected value %j (validateSync rejects these at boot)',
    (value) => {
      expect(isEnvFlagEnabled(value)).toBe(false);
    },
  );

  it('matches how the video-ingest module factories normalize today', () => {
    // Module factories: config.get<string>(FLAG)?.toLowerCase() === 'true'.
    // The helper additionally trims, which can only differ on values the env
    // validator already rejects at boot — so the two agree on every value a
    // running process can observe.
    const factoryNormalize = (value: string | undefined) =>
      value?.toLowerCase() === 'true';
    for (const value of ['true', 'TRUE', 'True', 'false', 'FALSE', '']) {
      expect(isEnvFlagEnabled(value)).toBe(factoryNormalize(value));
    }
    expect(isEnvFlagEnabled(undefined)).toBe(factoryNormalize(undefined));
  });
});
