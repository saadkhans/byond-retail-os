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
 * buffered into process memory.
 *
 * Every rejection case below therefore asserts BOTH halves:
 *   - the service's `upload` was never called, AND
 *   - no file object ever reached the request (multer never ran), observed
 *     on the very request object the handler would have received.
 *
 * The final case is the CONTROL: with the gate open and every attestation
 * header present, the same request DOES buffer a file and DOES reach the
 * service — proving the earlier assertions are about ordering, not about a
 * harness that never parses anything.
 */

const ATTESTATION_HEADERS = Object.fromEntries(
  UPLOAD_ATTESTATION_HEADERS.map(({ header }) => [header, 'true']),
) as Record<string, string>;

const ATTESTATION_FIELDS = Object.fromEntries(
  UPLOAD_ATTESTATION_HEADERS.map(({ field }) => [field, 'true']),
) as Record<string, string>;

/** 64 KiB of "media" — enough that buffering it would be observable. */
const FILE_BYTES = Buffer.alloc(64 * 1024, 7);

function configStub(values: Record<string, string | undefined>): ConfigService {
  return {
    get: (key: string) => values[key],
  } as unknown as ConfigService;
}

function extractorStub(readsRealBytes: boolean): VideoFrameExtractorPort {
  return { readsRealBytes } as unknown as VideoFrameExtractorPort;
}

function recognizerStub(readsRealPixels: boolean): FrameTextRecognizerPort {
  return { readsRealPixels } as unknown as FrameTextRecognizerPort;
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

function guardWith(
  options: {
    ingestEnabled?: string;
    nodeEnv?: string;
    readsRealBytes?: boolean;
    readsRealPixels?: boolean;
  } = {},
): TestMediaGateGuard {
  return new TestMediaGateGuard(
    configStub({
      // `in` rather than `??`: an EXPLICIT undefined is a case under test
      // (an unset flag / unset NODE_ENV must keep the gate shut).
      VIDEO_TEST_MEDIA_INGEST_ENABLED:
        'ingestEnabled' in options ? options.ingestEnabled : 'true',
      NODE_ENV: 'nodeEnv' in options ? options.nodeEnv : 'test',
    }),
    extractorStub(options.readsRealBytes ?? true),
    recognizerStub(options.readsRealPixels ?? true),
  );
}

describe('TestMediaGateGuard (unit)', () => {
  it('passes with every attestation header "true" under an open gate', () => {
    expect(guardWith().canActivate(contextWithHeaders(ATTESTATION_HEADERS))).toBe(
      true,
    );
  });

  it('decides from headers alone — it never touches body/file state', () => {
    // The context's body/file getters throw; reaching this expectation at
    // all is the assertion.
    expect(() =>
      guardWith().canActivate(contextWithHeaders(ATTESTATION_HEADERS)),
    ).not.toThrow();
  });

  it.each([
    ['unset flag', { ingestEnabled: undefined }],
    ['flag "false"', { ingestEnabled: 'false' }],
    ['flag "TRUE" (not the literal lowercase opt-in)', { ingestEnabled: 'TRUE' }],
    ['NODE_ENV=production', { nodeEnv: 'production' }],
    ['unset NODE_ENV', { nodeEnv: undefined }],
  ])('503s when the deployment gate is closed: %s', (_label, options) => {
    const guard = guardWith(options);
    expect(() => guard.canActivate(contextWithHeaders(ATTESTATION_HEADERS)))
      .toThrow(ServiceUnavailableException);
    try {
      guard.canActivate(contextWithHeaders(ATTESTATION_HEADERS));
    } catch (error) {
      expect((error as ServiceUnavailableException).message).toBe(
        TEST_MEDIA_GATE_CLOSED_MESSAGE,
      );
    }
  });

  it.each([
    ['the extractor does not read real bytes', { readsRealBytes: false }],
    ['the recognizer does not read real pixels', { readsRealPixels: false }],
  ])('503s when required tooling is unavailable: %s', (_label, options) => {
    const guard = guardWith(options);
    try {
      guard.canActivate(contextWithHeaders(ATTESTATION_HEADERS));
      throw new Error('expected the guard to refuse');
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect((error as ServiceUnavailableException).message).toBe(
        SCREENING_TOOLING_UNAVAILABLE_MESSAGE,
      );
    }
  });

  it.each(UPLOAD_ATTESTATION_HEADERS.map(({ header }) => header))(
    '400s naming %s when it is missing',
    (header) => {
      const headers = { ...ATTESTATION_HEADERS };
      delete headers[header];
      try {
        guardWith().canActivate(contextWithHeaders(headers));
        throw new Error('expected the guard to refuse');
      } catch (error) {
        expect(error).toBeInstanceOf(BadRequestException);
        expect((error as BadRequestException).message).toContain(header);
      }
    },
  );

  it.each(['false', 'yes', '1', '', 'truthy', 'true ish'])(
    'rejects an attestation header valued %p',
    (value) => {
      expect(() =>
        guardWith().canActivate(
          contextWithHeaders({
            ...ATTESTATION_HEADERS,
            'x-no-customer-pii': value,
          }),
        ),
      ).toThrow(BadRequestException);
    },
  );

  it.each(['true', 'TRUE', ' True ', '\ttrue\n'])(
    'accepts %p — comparison is trim + lowercase tolerant',
    (value) => {
      expect(
        guardWith().canActivate(
          contextWithHeaders({
            ...ATTESTATION_HEADERS,
            'x-controlled-test-media': value,
          }),
        ),
      ).toBe(true);
    },
  );

  it('rejects a REPEATED attestation header (array value) as ambiguous', () => {
    expect(() =>
      guardWith().canActivate(
        contextWithHeaders({
          ...ATTESTATION_HEADERS,
          'x-attest-no-sensitive-content': ['true', 'false'],
        }),
      ),
    ).toThrow(BadRequestException);
  });
});

describe('POST /video-assets pre-buffer gate (HTTP)', () => {
  let app: INestApplication;
  let uploadSpy: jest.Mock;
  /** The very request objects the handler would have received. */
  let seenRequests: Request[];

  async function createApp(options: {
    ingestEnabled?: string;
    nodeEnv?: string;
    readsRealBytes?: boolean;
    readsRealPixels?: boolean;
  }): Promise<void> {
    uploadSpy = jest.fn().mockResolvedValue({ id: 'asset-1' });
    seenRequests = [];
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
        {
          provide: VideoFrameExtractorPort,
          useValue: extractorStub(options.readsRealBytes ?? true),
        },
        {
          provide: FrameTextRecognizerPort,
          useValue: recognizerStub(options.readsRealPixels ?? true),
        },
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

  it('CONTROL: an open gate with all headers "true" DOES buffer the file and reaches the service', async () => {
    await createApp({});
    const response = await upload({
      ...ATTESTATION_HEADERS,
      // Case/whitespace tolerance holds end to end.
      'x-controlled-test-media': ' TRUE ',
    });
    expect(response.status).toBe(201);
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
