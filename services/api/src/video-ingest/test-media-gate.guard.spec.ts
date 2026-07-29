import 'reflect-metadata';
import {
  BadRequestException,
  ExecutionContext,
  INestApplication,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { VideoFrameExtractorPort } from './extraction/video-frame-extractor.port';
import { FrameTextRecognizerPort } from './recognition/frame-text-recognizer.port';
import {
  SCREENING_TOOLING_NOT_READY_MESSAGE,
  SCREENING_TOOLING_UNAVAILABLE_MESSAGE,
  TEST_MEDIA_GATE_CLOSED_MESSAGE,
  TestMediaGateGuard,
  UPLOAD_ATTESTATION_HEADERS,
} from './test-media-gate.guard';
import { VideoAssetsController } from './video-assets.controller';
import { VideoAssetsService } from './video-assets.service';

/**
 * THE ORDERING FACT THIS SPEC EXISTS TO PIN: in Nest, GUARDS RUN BEFORE
 * INTERCEPTORS. `RouterExecutionContext.create` (@nestjs/core) awaits
 * `fnCanActivate([req, res, next])` and only afterwards calls
 * `interceptorsConsumer.intercept(...)`, which is what executes
 * `FileInterceptor` (multer). So a guard that refuses the upload route
 * refuses it while the multipart body is still unread — the file is never
 * buffered into process memory. Because Nest AWAITS the guard, this holds
 * for the async tooling-readiness probe too: multer has not looked at the
 * socket while that promise is in flight.
 *
 * Every rejection case below therefore asserts BOTH halves:
 *   - the service's `upload` was never called, AND
 *   - no file object ever reached the request (multer never ran), observed
 *     on the very request object the handler would have received.
 *
 * The final case is the CONTROL: with the gate open, the tooling actually
 * ready, and every attestation header present, the same request DOES buffer
 * a file and DOES reach the service — proving the earlier assertions are
 * about ordering, not about a harness that never parses anything.
 */

const ATTESTATION_HEADERS = Object.fromEntries(
  UPLOAD_ATTESTATION_HEADERS.map(({ header }) => [header, 'true']),
) as Record<string, string>;

const ATTESTATION_FIELDS = Object.fromEntries(
  UPLOAD_ATTESTATION_HEADERS.map(({ field }) => [field, 'true']),
) as Record<string, string>;

/** 64 KiB of "media" — enough that buffering it would be observable. */
const FILE_BYTES = Buffer.alloc(64 * 1024, 7);

/**
 * What a controlled 503 must NEVER contain. The readiness probe returns a
 * BARE BOOLEAN precisely so the guard has no host detail in hand, and these
 * patterns are the regression net for anyone tempted to enrich the message
 * with "why" later.
 */
const HOST_DETAIL_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['a Windows filesystem path', /[A-Za-z]:\\/],
  ['a POSIX filesystem path', /(?:^|[\s"'(<[])\/[\w.-]+/],
  ['a UNC path', /\\\\[\w.-]+/],
  // A BARE binary token — `/usr/bin/ffmpeg`, `tesseract: not found`. The
  // `_`-boundary exclusions keep the legitimate SCREAMING_SNAKE env-var
  // names (VIDEO_FFMPEG_ENABLED, VIDEO_OCR_ENABLED) out of scope: naming the
  // knob an operator must set is the remediation, not a disclosure about
  // what is installed where.
  [
    'a binary name or location',
    /(?<!\w)(?:ffmpeg|ffprobe|tesseract)(?!\w)|\.exe\b|PATH=/i,
  ],
  // CASE-SENSITIVE on purpose: an errno is SHOUTED (ENOENT, EACCES). Folding
  // case here would flag ordinary prose ("Enable", "Every") instead.
  ['an errno code', /\bE[A-Z]{3,}\b/],
  [
    'an OS-level error detail',
    /errno|stderr|stdout|spawn|exit code|killed by|signal \w+/i,
  ],
];

function expectNoHostDetail(message: string): void {
  for (const [label, pattern] of HOST_DETAIL_PATTERNS) {
    // Assert on the LABEL too, so a failure names which class of host
    // detail leaked rather than just printing `false !== true`.
    expect([label, pattern.test(message), message]).toEqual([
      label,
      false,
      message,
    ]);
  }
}

function configStub(values: Record<string, string | undefined>): ConfigService {
  return {
    get: (key: string) => values[key],
  } as unknown as ConfigService;
}

/**
 * The doubles implement `checkToolingReady` because the PORTS declare it:
 * it is an abstract member of both `VideoFrameExtractorPort` and
 * `FrameTextRecognizerPort`, so the guard may call it unconditionally and
 * every adapter — real or test — has to supply it. The guard deliberately
 * does NOT tolerate a port that lacks the method (no optional call, no
 * "assume ready" fallback): a missing readiness probe would silently
 * re-open exactly the hole this gate closes.
 */
type ExtractorStub = VideoFrameExtractorPort & {
  checkToolingReady: jest.Mock<Promise<boolean>, []>;
};
type RecognizerStub = FrameTextRecognizerPort & {
  checkToolingReady: jest.Mock<Promise<boolean>, []>;
};

function extractorStub(
  readsRealBytes: boolean,
  toolingReady = true,
): ExtractorStub {
  return {
    readsRealBytes,
    checkToolingReady: jest.fn().mockResolvedValue(toolingReady),
  } as unknown as ExtractorStub;
}

function recognizerStub(
  readsRealPixels: boolean,
  toolingReady = true,
): RecognizerStub {
  return {
    readsRealPixels,
    checkToolingReady: jest.fn().mockResolvedValue(toolingReady),
  } as unknown as RecognizerStub;
}

/**
 * An ExecutionContext whose request exposes ONLY headers: `body` and `file`
 * are booby-trapped getters, so any attempt by the guard to look at parsed
 * multipart state fails the test outright. The guard must decide from the
 * headers alone — that is what lets it decide before parsing happens.
 */
function contextWithHeaders(
  headers: Record<string, string | string[] | undefined>,
): ExecutionContext {
  const req: Record<string, unknown> = { headers };
  for (const trap of ['body', 'file', 'files']) {
    Object.defineProperty(req, trap, {
      get() {
        throw new Error(
          `the pre-buffer gate must not read request.${trap} — it does not ` +
            'exist yet when the guard runs',
        );
      },
    });
  }
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

interface GuardOptions {
  ingestEnabled?: string;
  nodeEnv?: string;
  readsRealBytes?: boolean;
  readsRealPixels?: boolean;
  extractorToolingReady?: boolean;
  recognizerToolingReady?: boolean;
}

interface GuardHarness {
  guard: TestMediaGateGuard;
  extractor: ExtractorStub;
  recognizer: RecognizerStub;
}

function guardHarness(options: GuardOptions = {}): GuardHarness {
  const extractor = extractorStub(
    options.readsRealBytes ?? true,
    options.extractorToolingReady ?? true,
  );
  const recognizer = recognizerStub(
    options.readsRealPixels ?? true,
    options.recognizerToolingReady ?? true,
  );
  const guard = new TestMediaGateGuard(
    configStub({
      // `in` rather than `??`: an EXPLICIT undefined is a case under test
      // (an unset flag / unset NODE_ENV must keep the gate shut).
      VIDEO_TEST_MEDIA_INGEST_ENABLED:
        'ingestEnabled' in options ? options.ingestEnabled : 'true',
      NODE_ENV: 'nodeEnv' in options ? options.nodeEnv : 'test',
    }),
    extractor,
    recognizer,
  );
  return { guard, extractor, recognizer };
}

function guardWith(options: GuardOptions = {}): TestMediaGateGuard {
  return guardHarness(options).guard;
}

describe('TestMediaGateGuard (unit)', () => {
  it('passes with every attestation header "true" under an open gate', async () => {
    await expect(
      guardWith().canActivate(contextWithHeaders(ATTESTATION_HEADERS)),
    ).resolves.toBe(true);
  });

  it('decides from headers alone — it never touches body/file state', async () => {
    // The context's body/file getters throw; resolving at all is the
    // assertion.
    await expect(
      guardWith().canActivate(contextWithHeaders(ATTESTATION_HEADERS)),
    ).resolves.toBe(true);
  });

  it.each([
    ['unset flag', { ingestEnabled: undefined }],
    ['flag "false"', { ingestEnabled: 'false' }],
    ['flag "yes" (never a validated spelling of true)', { ingestEnabled: 'yes' }],
    ['flag "1"', { ingestEnabled: '1' }],
    ['empty flag', { ingestEnabled: '' }],
    ['NODE_ENV=production', { nodeEnv: 'production' }],
    ['unset NODE_ENV', { nodeEnv: undefined }],
    // NODE_ENV is a validated ENUM, not a boolean flag: the boolean helper
    // does not apply to it, so case variants must NOT open the gate.
    ['NODE_ENV="TEST" (enum, not case-folded)', { nodeEnv: 'TEST' }],
    ['NODE_ENV="Development"', { nodeEnv: 'Development' }],
  ])('503s when the deployment gate is closed: %s', async (_label, options) => {
    const guard = guardWith(options);
    await expect(
      guard.canActivate(contextWithHeaders(ATTESTATION_HEADERS)),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(
      guard.canActivate(contextWithHeaders(ATTESTATION_HEADERS)),
    ).rejects.toMatchObject({ message: TEST_MEDIA_GATE_CLOSED_MESSAGE });
  });

  /**
   * THE SHARED-NORMALIZATION REGRESSION. `isEnvFlagEnabled` (trim +
   * case-fold) is what startup validation, the module's adapter factories,
   * and `VideoAssetsService` use. When this guard hand-compared `=== 'true'`
   * instead, a `VIDEO_TEST_MEDIA_INGEST_ENABLED=TRUE` deployment booted
   * fine, selected the real tooling, and passed the service gate — and then
   * this guard 503'd every single upload before multer ever ran.
   */
  it.each(['true', 'TRUE', 'True', ' true ', '\ttrue\n'])(
    'opens the deployment gate for the flag spelled %p, like every other consumer',
    async (ingestEnabled) => {
      await expect(
        guardWith({ ingestEnabled }).canActivate(
          contextWithHeaders(ATTESTATION_HEADERS),
        ),
      ).resolves.toBe(true);
    },
  );

  it.each(['development', 'test'])(
    'opens the deployment gate under NODE_ENV=%p',
    async (nodeEnv) => {
      await expect(
        guardWith({ nodeEnv }).canActivate(
          contextWithHeaders(ATTESTATION_HEADERS),
        ),
      ).resolves.toBe(true);
    },
  );

  it.each([
    ['the extractor does not read real bytes', { readsRealBytes: false }],
    ['the recognizer does not read real pixels', { readsRealPixels: false }],
  ])('503s when required tooling is unavailable: %s', async (_label, options) => {
    await expect(
      guardWith(options).canActivate(contextWithHeaders(ATTESTATION_HEADERS)),
    ).rejects.toMatchObject({
      message: SCREENING_TOOLING_UNAVAILABLE_MESSAGE,
    });
  });

  /**
   * THE READINESS REGRESSION. The capability flags say the REAL adapters
   * were selected; they stay true when the underlying binaries are absent or
   * not executable. Without this layer the guard passed, multer buffered the
   * entire upload, and the failure only surfaced after parsing.
   */
  it.each([
    ['the extractor tooling cannot run', { extractorToolingReady: false }],
    ['the recognizer tooling cannot run', { recognizerToolingReady: false }],
  ])(
    '503s when the capability flag is true but %s',
    async (_label, options) => {
      const guard = guardWith(options);
      await expect(
        guard.canActivate(contextWithHeaders(ATTESTATION_HEADERS)),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      await expect(
        guard.canActivate(contextWithHeaders(ATTESTATION_HEADERS)),
      ).rejects.toMatchObject({
        message: SCREENING_TOOLING_NOT_READY_MESSAGE,
      });
    },
  );

  it('probes BOTH ports at most once each on the passing path', async () => {
    const { guard, extractor, recognizer } = guardHarness();
    await expect(
      guard.canActivate(contextWithHeaders(ATTESTATION_HEADERS)),
    ).resolves.toBe(true);
    // The caching lives in the adapters (short TTL), not here — the guard
    // just asks once per port per request.
    expect(extractor.checkToolingReady).toHaveBeenCalledTimes(1);
    expect(recognizer.checkToolingReady).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['the deployment gate is already closed', { ingestEnabled: 'false' }],
    ['NODE_ENV is production', { nodeEnv: 'production' }],
    ['the extractor capability flag is false', { readsRealBytes: false }],
    ['the recognizer capability flag is false', { readsRealPixels: false }],
  ])(
    'never probes tooling readiness when %s (cheap checks fail fast)',
    async (_label, options) => {
      const { guard, extractor, recognizer } = guardHarness(options);
      await expect(
        guard.canActivate(contextWithHeaders(ATTESTATION_HEADERS)),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(extractor.checkToolingReady).not.toHaveBeenCalled();
      expect(recognizer.checkToolingReady).not.toHaveBeenCalled();
    },
  );

  it('does not probe the recognizer once the extractor is already not ready', async () => {
    const { guard, extractor, recognizer } = guardHarness({
      extractorToolingReady: false,
    });
    await expect(
      guard.canActivate(contextWithHeaders(ATTESTATION_HEADERS)),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(extractor.checkToolingReady).toHaveBeenCalledTimes(1);
    expect(recognizer.checkToolingReady).not.toHaveBeenCalled();
  });

  it.each([
    ['the readiness 503', SCREENING_TOOLING_NOT_READY_MESSAGE],
    ['the capability-flag 503', SCREENING_TOOLING_UNAVAILABLE_MESSAGE],
    ['the deployment-gate 503', TEST_MEDIA_GATE_CLOSED_MESSAGE],
  ])('%s exposes nothing about the host', (_label, message) => {
    expectNoHostDetail(message);
  });

  it.each(UPLOAD_ATTESTATION_HEADERS.map(({ header }) => header))(
    '400s naming %s when it is missing',
    async (header) => {
      const headers = { ...ATTESTATION_HEADERS };
      delete headers[header];
      const promise = guardWith().canActivate(contextWithHeaders(headers));
      await expect(promise).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        guardWith().canActivate(contextWithHeaders(headers)),
      ).rejects.toThrow(header);
    },
  );

  it.each(['false', 'yes', '1', '', 'truthy', 'true ish'])(
    'rejects an attestation header valued %p',
    async (value) => {
      await expect(
        guardWith().canActivate(
          contextWithHeaders({
            ...ATTESTATION_HEADERS,
            'x-no-customer-pii': value,
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    },
  );

  it.each(['true', 'TRUE', ' True ', '\ttrue\n'])(
    'accepts %p — comparison is trim + lowercase tolerant',
    async (value) => {
      await expect(
        guardWith().canActivate(
          contextWithHeaders({
            ...ATTESTATION_HEADERS,
            'x-controlled-test-media': value,
          }),
        ),
      ).resolves.toBe(true);
    },
  );

  it('rejects a REPEATED attestation header (array value) as ambiguous', async () => {
    await expect(
      guardWith().canActivate(
        contextWithHeaders({
          ...ATTESTATION_HEADERS,
          'x-attest-no-sensitive-content': ['true', 'false'],
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('POST /video-assets pre-buffer gate (HTTP)', () => {
  let app: INestApplication;
  let uploadSpy: jest.Mock;
  let extractor: ExtractorStub;
  let recognizer: RecognizerStub;
  /** The very request objects the handler would have received. */
  let seenRequests: Request[];

  async function createApp(options: GuardOptions): Promise<void> {
    uploadSpy = jest.fn().mockResolvedValue({ id: 'asset-1' });
    seenRequests = [];
    extractor = extractorStub(
      options.readsRealBytes ?? true,
      options.extractorToolingReady ?? true,
    );
    recognizer = recognizerStub(
      options.readsRealPixels ?? true,
      options.recognizerToolingReady ?? true,
    );
    const moduleRef = await Test.createTestingModule({
      controllers: [VideoAssetsController],
      providers: [
        TestMediaGateGuard,
        { provide: VideoAssetsService, useValue: { upload: uploadSpy } },
        {
          provide: ConfigService,
          useValue: configStub({
            VIDEO_TEST_MEDIA_INGEST_ENABLED: options.ingestEnabled ?? 'true',
            NODE_ENV: options.nodeEnv ?? 'test',
          }),
        },
        { provide: VideoFrameExtractorPort, useValue: extractor },
        { provide: FrameTextRecognizerPort, useValue: recognizer },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    // Stand in for the global auth guard: the handler's @CurrentUser /
    // @CurrentTenantId decorators fail closed without a request context.
    // The same middleware captures each request so the assertions below can
    // inspect what multer did (or did not) attach to it.
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as unknown as { context: unknown }).context = {
        userId: 'user-1',
        email: 'operator@example.com',
        tenantId: 'tenant-1',
      };
      seenRequests.push(req);
      next();
    });
    await app.init();
  }

  function upload(headers: Record<string, string>) {
    let pending = request(app.getHttpServer()).post('/video-assets');
    for (const [name, value] of Object.entries(headers)) {
      pending = pending.set(name, value);
    }
    for (const [field, value] of Object.entries(ATTESTATION_FIELDS)) {
      pending = pending.field(field, value);
    }
    return pending.attach('file', FILE_BYTES, 'clip.mp4');
  }

  /**
   * The "not one byte was buffered" assertion: multer, when it runs,
   * attaches the parsed file to the request (and replaces `body` with the
   * parsed fields). If neither ever appeared on the request the handler
   * would have received, the interceptor never ran — which is only
   * possible because the guard refused first.
   */
  function expectNothingBuffered(): void {
    expect(uploadSpy).not.toHaveBeenCalled();
    expect(seenRequests).toHaveLength(1);
    const seen = seenRequests[0] as Request & { file?: unknown };
    expect(seen.file).toBeUndefined();
    for (const field of Object.keys(ATTESTATION_FIELDS)) {
      expect((seen.body as Record<string, unknown> | undefined)?.[field]).toBeUndefined();
    }
  }

  afterEach(async () => {
    await app?.close();
  });

  it('503s with the deployment gate closed — nothing is buffered', async () => {
    await createApp({ ingestEnabled: 'false' });
    const response = await upload(ATTESTATION_HEADERS);
    expect(response.status).toBe(503);
    expect(response.body.message).toBe(TEST_MEDIA_GATE_CLOSED_MESSAGE);
    expectNothingBuffered();
    expect(extractor.checkToolingReady).not.toHaveBeenCalled();
    expect(recognizer.checkToolingReady).not.toHaveBeenCalled();
  });

  it('accepts the flag spelled "TRUE" — the shared helper, not a local compare', async () => {
    await createApp({ ingestEnabled: 'TRUE' });
    const response = await upload(ATTESTATION_HEADERS);
    expect(response.status).toBe(201);
    expect(uploadSpy).toHaveBeenCalledTimes(1);
  });

  it('503s in a production runtime even with the flag set — nothing is buffered', async () => {
    await createApp({ ingestEnabled: 'true', nodeEnv: 'production' });
    const response = await upload(ATTESTATION_HEADERS);
    expect(response.status).toBe(503);
    expect(response.body.message).toBe(TEST_MEDIA_GATE_CLOSED_MESSAGE);
    expectNothingBuffered();
  });

  it('503s when the screening toolchain is unavailable — nothing is buffered', async () => {
    await createApp({ readsRealPixels: false });
    const response = await upload(ATTESTATION_HEADERS);
    expect(response.status).toBe(503);
    expect(response.body.message).toBe(SCREENING_TOOLING_UNAVAILABLE_MESSAGE);
    expectNothingBuffered();
  });

  it('503s when the EXTRACTOR advertises real bytes but cannot run — nothing is buffered', async () => {
    await createApp({ readsRealBytes: true, extractorToolingReady: false });
    const response = await upload(ATTESTATION_HEADERS);
    expect(response.status).toBe(503);
    expect(response.body.message).toBe(SCREENING_TOOLING_NOT_READY_MESSAGE);
    expect(extractor.checkToolingReady).toHaveBeenCalledTimes(1);
    expectNothingBuffered();
    expectNoHostDetail(String(response.body.message));
  });

  it('503s when the RECOGNIZER advertises real pixels but cannot run — nothing is buffered', async () => {
    await createApp({ readsRealPixels: true, recognizerToolingReady: false });
    const response = await upload(ATTESTATION_HEADERS);
    expect(response.status).toBe(503);
    expect(response.body.message).toBe(SCREENING_TOOLING_NOT_READY_MESSAGE);
    expect(recognizer.checkToolingReady).toHaveBeenCalledTimes(1);
    expectNothingBuffered();
    expectNoHostDetail(String(response.body.message));
  });

  it.each(UPLOAD_ATTESTATION_HEADERS.map(({ header }) => header))(
    '400s when %s is missing — nothing is buffered',
    async (header) => {
      await createApp({});
      const headers = { ...ATTESTATION_HEADERS };
      delete headers[header];
      const response = await upload(headers);
      expect(response.status).toBe(400);
      expect(response.body.message).toContain(header);
      expectNothingBuffered();
    },
  );

  it.each(UPLOAD_ATTESTATION_HEADERS.map(({ header }) => header))(
    '400s when %s is not "true" — nothing is buffered',
    async (header) => {
      await createApp({});
      const response = await upload({ ...ATTESTATION_HEADERS, [header]: 'no' });
      expect(response.status).toBe(400);
      expect(response.body.message).toContain(header);
      expectNothingBuffered();
    },
  );

  it('CONTROL: an open gate with ready tooling and all headers "true" DOES buffer the file and reaches the service', async () => {
    await createApp({});
    const response = await upload({
      ...ATTESTATION_HEADERS,
      // Case/whitespace tolerance holds end to end.
      'x-controlled-test-media': ' TRUE ',
    });
    expect(response.status).toBe(201);
    // BOTH readiness probes ran and passed — the control proves the gate was
    // actually exercised, not skipped.
    expect(extractor.checkToolingReady).toHaveBeenCalledTimes(1);
    expect(recognizer.checkToolingReady).toHaveBeenCalledTimes(1);
    expect(uploadSpy).toHaveBeenCalledTimes(1);
    const [tenantId, file, dto] = uploadSpy.mock.calls[0] as [
      string,
      { size: number; originalname: string; buffer: Buffer },
      Record<string, string>,
    ];
    expect(tenantId).toBe('tenant-1');
    expect(file.originalname).toBe('clip.mp4');
    expect(file.size).toBe(FILE_BYTES.length);
    // The multipart attestation FIELDS are untouched by this change: they
    // remain the audited record the service persists and re-checks.
    expect(dto).toMatchObject(ATTESTATION_FIELDS);
  });
});
