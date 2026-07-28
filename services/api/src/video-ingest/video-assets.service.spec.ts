import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  EvidenceSourceType,
  InferenceJobStatus,
  InferenceJobType,
  VideoArtifactType,
  VideoAssetStatus,
  VideoCropReason,
} from '@prisma/client';
import {
  ExtractionFailedError,
  ExtractionInfrastructureError,
  ExtractorUnavailableError,
  FrameExceedsBudgetError,
  FrameUnavailableError,
} from './extraction/video-frame-extractor.port';
import { UNSTREAMABLE_CONTAINER_MESSAGE } from './extraction/ffmpeg-extractor.adapter';
import {
  FrameTextRecognitionFailedError,
  FrameTextRecognitionInfrastructureError,
} from './recognition/frame-text-recognizer.port';
import { VideoScreeningDecision } from './dto/screen-video-asset.dto';
import { VideoStorageOperationError } from './storage/video-storage.port';
import {
  PRESTORE_SCREENING_MAX_FRAME_BYTES,
  SCREENING_PREVIEW_MAX_FRAMES,
  SCREENING_PREVIEW_MIN_FRAME_BYTES,
  SCREENING_PREVIEW_TOTAL_BYTES,
  UploadedVideoFile,
  VideoAssetsService,
} from './video-assets.service';

const TENANT = 'tenant-1';

// Required upload attestation (frame-content gate) — see UploadVideoAssetDto.
const ATTEST = { attestNoSensitiveContent: 'true' };

function mp4Buffer(): Buffer {
  return Buffer.concat([
    Buffer.from([0, 0, 0, 0x18]),
    Buffer.from('ftypmp42', 'ascii'),
    Buffer.alloc(64),
  ]);
}

function uploadFile(overrides: Partial<UploadedVideoFile> = {}): UploadedVideoFile {
  const buffer = overrides.buffer ?? mp4Buffer();
  return {
    originalname: 'clip.mp4',
    mimetype: 'video/mp4',
    size: buffer.length,
    buffer,
    ...overrides,
  };
}

function assetRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'asset-1',
    tenantId: TENANT,
    locationId: null,
    unitId: null,
    deviceId: null,
    sessionId: null,
    originalFilename: 'clip.mp4',
    mimeType: 'video/mp4',
    sizeBytes: 100,
    durationMs: 10_000,
    width: 1280,
    height: 720,
    fps: 30,
    status: VideoAssetStatus.VALIDATED,
    storageKey: `${TENANT}/uuid-1/original.mp4`,
    checksumSha256: 'abc',
    errorCode: null,
    errorMessage: null,
    // Screening inspection evidence — absent by default: only the guarded
    // preview-serve authorization stamps it (APPROVE tests opt in).
    screeningInspectedAt: null,
    screeningInspectedBy: null,
    screeningInspectedFrames: null,
    uploadedById: null,
    deletedAt: null,
    // Media-removal completion marker — null by default (media present);
    // already-removed tests opt in.
    mediaRemovedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function artifactRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'artifact-1',
    tenantId: TENANT,
    videoAssetId: 'asset-1',
    artifactType: VideoArtifactType.CROP,
    reason: VideoCropReason.PRODUCT_PICKUP,
    timestampMs: 1000,
    cropX: 10,
    cropY: 20,
    cropWidth: 300,
    cropHeight: 200,
    width: 300,
    height: 200,
    mimeType: 'image/png',
    sizeBytes: 42,
    checksumSha256: 'def',
    inferenceJobId: null,
    createdById: null,
    createdAt: new Date(),
    ...overrides,
  };
}

/** Mirrors the service's CANONICAL crop fingerprint (fixed field order). */
function cropFingerprint(params: {
  timestampMs: number;
  x: number;
  y: number;
  width: number;
  height: number;
  reason?: VideoCropReason | null;
}): string {
  return JSON.stringify({
    op: 'CROP',
    timestampMs: params.timestampMs,
    x: params.x,
    y: params.y,
    width: params.width,
    height: params.height,
    reason: params.reason ?? null,
  });
}

/**
 * Mirrors the service's CANONICAL frames fingerprint: sampling mode applies
 * the defaults; single-frame mode records EVERY supplied field raw
 * (explicit null = not supplied), so a supplied-but-ignored interval/limit
 * is still part of the request identity.
 */
function framesFingerprint(params: {
  timestampMs?: number;
  intervalMs?: number;
  maxFrames?: number;
} = {}): string {
  return params.timestampMs !== undefined
    ? JSON.stringify({
        op: 'FRAMES',
        timestampMs: params.timestampMs,
        intervalMs: params.intervalMs ?? null,
        maxFrames: params.maxFrames ?? null,
      })
    : JSON.stringify({
        op: 'FRAMES',
        intervalMs: params.intervalMs ?? 1000,
        maxFrames: params.maxFrames ?? 5,
      });
}

function buildService(overrides: {
  repository?: Record<string, unknown>;
  storage?: Record<string, unknown>;
  extractor?: Record<string, unknown>;
  recognizer?: Record<string, unknown>;
  inference?: Record<string, unknown>;
  modules?: Record<string, unknown>;
  maxUploadBytes?: string;
  maxScreeningDurationMs?: string;
  // The unscreened-upload bypass is REMOVED: these two remain wired into
  // the mock ConfigService ONLY so tests can prove the service ignores
  // them completely in every environment.
  allowUnscreenedUploads?: string;
  nodeEnv?: string;
} = {}) {
  const repository = {
    createAsset: jest.fn(async (_t: string, data: unknown, build: (a: unknown) => unknown) => {
      // Mirrors the real repository: every new upload is persisted in the
      // NON-SCREENABLE staging state PENDING_MEDIA (status is forced at
      // the persistence layer, never caller-supplied); the service
      // publishes it QUARANTINED only after the media write succeeds.
      const created = assetRow({
        ...(data as Record<string, unknown>),
        status: VideoAssetStatus.PENDING_MEDIA,
      });
      build(created);
      return created;
    }),
    findById: jest.fn(async () => assetRow()),
    findByIdInternal: jest.fn(async () => assetRow()),
    findByIdInternalIncludingDeleted: jest.fn(async () => assetRow()),
    // Advisory-lock-guarded liveness read the upload takes immediately
    // before its media write (delete-race window shrink) — 'live' by
    // default; the concurrent-delete tests override.
    assetLivenessUnderLock: jest.fn(async () => 'live' as const),
    list: jest.fn(async () => ({ items: [assetRow()], total: 1 })),
    transitionStatus: jest.fn(
      async (
        _t: string,
        _id: string,
        _expected: unknown,
        data: { status: VideoAssetStatus },
        build: (b: unknown, a: unknown) => unknown,
      ) => {
        const after = assetRow({ ...data });
        build(assetRow(), after);
        return after;
      },
    ),
    // Mirrors the real repository: the mediaRemovedAt marker is read
    // inside the locked transaction, handed to the audit builder, and
    // returned alongside the pre-delete view. Default: media present.
    softDelete: jest.fn(
      async (
        _t: string,
        _id: string,
        build: (b: unknown, mediaAlreadyRemoved: boolean) => unknown,
      ) => {
        const before = assetRow();
        build(before, false);
        return { asset: before, mediaAlreadyRemoved: false };
      },
    ),
    // Exactly-once media-removal completion marker CAS (Findings I/K):
    // default claims successfully — the entry builder runs (the real
    // repository writes it inside the same transaction) and the call
    // reports 'recorded'. Already-recorded-path tests override the return.
    recordMediaRemovalCompleted: jest.fn(
      async (_t: string, _id: string, build: () => unknown) => {
        build();
        return 'recorded' as const;
      },
    ),
    createArtifactsBatch: jest.fn(
      async (
        _t: string,
        videoAssetId: string,
        _expected: unknown,
        _idempotencyKey: string | undefined,
        items: Record<string, unknown>[],
        buildArtifactAudit: (a: unknown) => unknown,
        buildAssetAudit: (b: unknown, a: unknown) => unknown,
      ) => {
        const artifacts = items.map((item, index) => {
          const created = artifactRow({
            id: `artifact-${index + 1}`,
            videoAssetId,
            ...item,
          });
          buildArtifactAudit(created);
          return created;
        });
        const asset = assetRow({ status: VideoAssetStatus.READY });
        buildAssetAudit(assetRow(), asset);
        return { asset, artifacts, replayed: false };
      },
    ),
    findExtractionReplay: jest.fn(async () => null),
    findArtifactById: jest.fn(async () => artifactRow()),
    listArtifacts: jest.fn(async () => [artifactRow()]),
    listArtifactStorageKeys: jest.fn(async () => []),
    // No crop is linked to a job by default — delete-flow tests override.
    listLinkedInferenceJobs: jest.fn(async () => []),
    // Final preview-serve guard: by default the asset is still QUARANTINED
    // and the audited READ commits (the builder runs inside the guarded
    // transaction in the real repository, which also stamps the inspection
    // evidence when servedFrameCount > 0).
    authorizeScreeningPreviewServe: jest.fn(
      async (
        _t: string,
        _id: string,
        _inspection: { actorId: string | null; servedFrameCount: number },
        build: () => unknown,
      ) => {
        build();
        return VideoAssetStatus.QUARANTINED;
      },
    ),
    // Mirrors the real repository: takes the PARENT asset id (advisory
    // lock key) before the artifact id.
    linkArtifactToInferenceJob: jest.fn(
      async (
        _t: string,
        _assetId: string,
        _artifactId: string,
        jobId: string,
        build: (b: unknown, a: unknown) => unknown,
      ) => {
        const after = artifactRow({ inferenceJobId: jobId });
        build(artifactRow(), after);
        return after;
      },
    ),
    ...overrides.repository,
  };
  const storage = {
    put: jest.fn(async () => undefined),
    read: jest.fn(async () => Buffer.alloc(0)),
    delete: jest.fn(async () => undefined),
    // Mirrors the port contract: reports whether anything existed under
    // the prefix (true = this call removed something).
    deletePrefix: jest.fn(async () => true),
    internalPathFor: jest.fn(() => '/root/x'),
    ...overrides.storage,
  };
  // Cleanup hook of the DEFAULT buffer-inspection session (pre-storage
  // screening) — returned so tests can assert the session is closed in
  // every path.
  const inspectClose = jest.fn(async () => undefined);
  const extractor: Record<string, unknown> = {
    kind: 'simulated',
    // Byte-reading by default so the preview path is exercisable; the
    // simulated-mode refusal test overrides this to false explicitly.
    readsRealBytes: true,
    probe: jest.fn(async () => ({ durationMs: 10_000, width: 1280, height: 720, fps: 30 })),
    // ONE-pass 1 fps decode backing the DEFAULT buffer-inspection session
    // (pre-storage screening): yields exactly one raw PNG buffer per
    // STARTED second of the probed duration (frame i = second i), so a
    // test that overrides `probe` drives the frame count too. Receives
    // (options, durationMs) — the session derives durationMs from the
    // shared probe mock.
    extractFramesPerSecond: jest.fn(
      async (_options: { maxBytesPerFrame: number }, durationMs: number) =>
        Array.from(
          { length: Math.max(1, Math.ceil(durationMs / 1000)) },
          () => Buffer.from('f'),
        ),
    ),
    extractFrames: jest.fn(async () => [
      { data: Buffer.from('f'), width: 1280, height: 720, mimeType: 'image/png', timestampMs: 0 },
    ]),
    extractFrameAt: jest.fn(async (_k: string, _p: unknown, ts: number) => ({
      data: Buffer.from('f'),
      width: 1280,
      height: 720,
      mimeType: 'image/png',
      timestampMs: ts,
    })),
    extractCrop: jest.fn(async (_k: string, _p: unknown, ts: number, box: { width: number; height: number }) => ({
      data: Buffer.from('c'),
      width: box.width,
      height: box.height,
      mimeType: 'image/png',
      timestampMs: ts,
    })),
    ...overrides.extractor,
  };
  if (!('inspectBuffer' in extractor)) {
    // Default IN-MEMORY inspection session (pinned session contract:
    // opening runs no tooling; probe() is memoized; ONE
    // extractFramesPerSecond pass; idempotent close). Delegates to the
    // SAME probe/extractFramesPerSecond mocks (including per-test
    // overrides), so a test that overrides one surface drives the
    // pre-storage screen too.
    extractor.inspectBuffer = jest.fn(async (data: Buffer) => {
      void data;
      let probed: Promise<unknown> | null = null;
      const probe = () =>
        (probed ??= (extractor.probe as (key: string) => Promise<unknown>)(
          'in-memory-upload',
        ));
      return {
        probe,
        extractFramesPerSecond: async (options: { maxBytesPerFrame: number }) => {
          const { durationMs } = (await probe()) as { durationMs: number };
          return (
            extractor.extractFramesPerSecond as (
              options: { maxBytesPerFrame: number },
              durationMs: number,
            ) => Promise<Buffer[]>
          )(options, durationMs);
        },
        close: inspectClose,
      };
    });
  }
  const recognizer = {
    kind: 'test-recognizer',
    // Pixel-reading by default (paired with the extractor's default
    // readsRealBytes=true) so every upload test exercises the pre-storage
    // frame screen with BENIGN recognized text; refusal and hit tests
    // override explicitly.
    readsRealPixels: true,
    recognize: jest.fn(async () => 'aisle four shelf camera'),
    ...overrides.recognizer,
  };
  const inference = {
    // Echo the dto so the service's replayed-job verification sees a job
    // whose FULL descriptor, context, AND server-derived sourceType
    // genuinely reference the crop (the real create persists the dto's
    // sourceType verbatim; the InferenceJob schema default is VISION).
    create: jest.fn(
      async (
        _t: string,
        dto: {
          jobType: InferenceJobType;
          inputDescriptor: unknown;
          sourceType?: EvidenceSourceType;
          sourceId?: string;
          locationId?: string;
          unitId?: string;
          deviceId?: string;
          sessionId?: string;
        },
      ) => ({
        id: 'job-1',
        jobType: dto.jobType,
        inputDescriptor: dto.inputDescriptor,
        sourceType: dto.sourceType ?? EvidenceSourceType.VISION,
        sourceId: dto.sourceId ?? null,
        locationId: dto.locationId ?? null,
        unitId: dto.unitId ?? null,
        deviceId: dto.deviceId ?? null,
        sessionId: dto.sessionId ?? null,
      }),
    ),
    findById: jest.fn(async () => ({
      id: 'job-1',
      jobType: InferenceJobType.PRODUCT_RECOGNITION,
      sourceType: EvidenceSourceType.VISION,
    })),
    cancelOrphanedJob: jest.fn(async () => ({
      id: 'job-1',
      status: 'CANCELLED',
    })),
    ...overrides.inference,
  };
  const modules = {
    isEnabledForTenant: jest.fn(async () => true),
    ...overrides.modules,
  };
  const auditLog = {
    record: jest.fn(async () => undefined),
  };
  const config = {
    get: (key: string) =>
      key === 'VIDEO_MAX_UPLOAD_BYTES'
        ? overrides.maxUploadBytes
        : key === 'VIDEO_MAX_SCREENING_DURATION_MS'
          ? overrides.maxScreeningDurationMs
          : key === 'VIDEO_UNSAFE_ALLOW_UNSCREENED_UPLOADS'
            ? overrides.allowUnscreenedUploads
            : key === 'NODE_ENV'
              ? overrides.nodeEnv
              : undefined,
  } as unknown as ConfigService;

  const service = new VideoAssetsService(
    repository as never,
    storage as never,
    extractor as never,
    recognizer as never,
    inference as never,
    modules as never,
    auditLog as never,
    config,
  );
  return {
    service,
    repository,
    storage,
    extractor,
    recognizer,
    inference,
    modules,
    auditLog,
    inspectClose,
  };
}

describe('VideoAssetsService.upload', () => {
  it('stores the file under a server-generated key and records the checksum', async () => {
    const { service, repository, storage } = buildService();
    await service.upload(TENANT, uploadFile(), { ...ATTEST }, { id: 'u1', email: 'u@x.io' });

    expect(storage.put).toHaveBeenCalledTimes(1);
    const [key] = storage.put.mock.calls[0] as unknown as [string, Buffer];
    // tenant / random UUID / fixed name — the client filename is NOT in it.
    expect(key).toMatch(
      new RegExp(`^${TENANT}/[0-9a-f-]{36}/original\\.mp4$`),
    );
    const [, data] = repository.createAsset.mock.calls[0] as unknown as [string, { checksumSha256: string; storageKey: string; originalFilename: string }];
    expect(data.checksumSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(data.storageKey).toBe(key);
    expect(data.originalFilename).toBe('clip.mp4');
    expect((repository.createAsset.mock.calls[0] as unknown as [string])[0]).toBe(TENANT);
  });

  it('stages the row PENDING_MEDIA and publishes it QUARANTINED only AFTER the media write', async () => {
    // Two-step publish: the row commits BEFORE the bytes in the
    // NON-SCREENABLE PENDING_MEDIA state (so a concurrent screener cannot
    // APPROVE an asset whose media may still fail to land), and only after
    // put succeeds does the audited CAS PENDING_MEDIA → QUARANTINED make
    // the asset screenable.
    const { service, repository, storage } = buildService();
    const asset = await service.upload(TENANT, uploadFile(), { ...ATTEST });
    expect((asset as { status: VideoAssetStatus }).status).toBe(
      VideoAssetStatus.QUARANTINED,
    );
    // The publish is the audited CAS from EXACTLY the staging state.
    expect(repository.transitionStatus).toHaveBeenCalledTimes(1);
    const [, , expected, data] = repository.transitionStatus.mock
      .calls[0] as unknown as [
      string,
      string,
      VideoAssetStatus[],
      { status: VideoAssetStatus; errorCode?: string },
    ];
    expect(expected).toEqual([VideoAssetStatus.PENDING_MEDIA]);
    expect(data.status).toBe(VideoAssetStatus.QUARANTINED);
    expect(data.errorCode).toBeUndefined();
    // Ordering: create (staging) → put (media) → publish (screenable).
    const createOrder = (repository.createAsset as jest.Mock).mock
      .invocationCallOrder[0];
    const putOrder = (storage.put as jest.Mock).mock.invocationCallOrder[0];
    const publishOrder = (repository.transitionStatus as jest.Mock).mock
      .invocationCallOrder[0];
    expect(createOrder).toBeLessThan(putOrder);
    expect(putOrder).toBeLessThan(publishOrder);
  });

  it('handles a publish CAS lost to a concurrent DELETE as a controlled 409 with media cleanup', async () => {
    // Nothing but DELETE can touch a PENDING_MEDIA row, so a lost publish
    // CAS means the asset was deleted mid-upload. The just-written media
    // may have landed AFTER the delete's file cleanup ran, so the upload
    // re-runs the idempotent removal and surfaces a controlled conflict —
    // never an UPLOADED/QUARANTINED ghost, never a 500. When the removal
    // SUCCEEDS (this test), the 409 is the whole story: no escalation, no
    // cleanup-obligation audit.
    const { service, storage, auditLog } = buildService({
      repository: { transitionStatus: jest.fn(async () => null) },
    });
    await expect(
      service.upload(TENANT, uploadFile(), { ...ATTEST }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(storage.deletePrefix).toHaveBeenCalledTimes(1);
    expect(auditLog.record).not.toHaveBeenCalled();
  });

  it('skips the media write with a controlled 409 when the locked pre-put liveness check observes a committed delete', async () => {
    // Shrinks the delete/put race window: a DELETE that completed while
    // the upload was still screening in memory has already run its prefix
    // cleanup — writing the media NOW would recreate bytes under a prefix
    // whose delete caller was told cleanup completed. The advisory-locked
    // liveness read (same per-asset lock as softDelete) catches that
    // BEFORE the put: no byte is written, no publish is attempted, and
    // the caller gets the same controlled 409 as a lost publish CAS.
    const { service, storage, repository } = buildService({
      repository: {
        assetLivenessUnderLock: jest.fn(async () => 'deleted' as const),
      },
    });
    await expect(
      service.upload(TENANT, uploadFile(), { ...ATTEST }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(storage.put).not.toHaveBeenCalled();
    expect(repository.transitionStatus).not.toHaveBeenCalled();
    expect(storage.deletePrefix).not.toHaveBeenCalled();
  });

  it('runs the locked liveness pre-check BETWEEN the in-memory screen and the media write', async () => {
    const { service, storage, repository } = buildService();
    await service.upload(TENANT, uploadFile(), { ...ATTEST });
    const livenessOrder = (repository.assetLivenessUnderLock as jest.Mock)
      .mock.invocationCallOrder[0];
    const putOrder = (storage.put as jest.Mock).mock.invocationCallOrder[0];
    expect(livenessOrder).toBeLessThan(putOrder);
  });

  it('escalates a failed compensating removal after a lost publish as a retryable 503 with a durable cleanup-obligation audit', async () => {
    // Codex P1: the delete's caller was already told cleanup completed
    // (mediaRemovedAt recorded) BEFORE our put landed. If the
    // compensating removal then fails twice, swallowing it into the 409
    // would leave the just-written media orphaned forever with no honest
    // retry signal. Instead: the durable cleanup obligation is recorded
    // in the audit trail and the caller gets a retryable 503 naming the
    // recovery path — the idempotent DELETE replay re-runs the same
    // prefix removal (pinned by the delete suite's "retries file cleanup
    // idempotently for an already-deleted asset" test).
    const deletePrefix = jest.fn(async () => {
      throw new Error('EACCES');
    });
    const { service, auditLog } = buildService({
      repository: { transitionStatus: jest.fn(async () => null) },
      storage: { deletePrefix },
    });
    const error: Error = await service
      .upload(TENANT, uploadFile(), { ...ATTEST }, { id: 'u1', email: 'u@x.io' })
      .then(() => {
        throw new Error('expected rejection');
      })
      .catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(error.message).toContain('DELETE /video-assets/:id');
    // Bounded removal attempts: one retry, then escalation.
    expect(deletePrefix).toHaveBeenCalledTimes(2);
    // The obligation is durable audit evidence on the asset itself.
    expect(auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'VideoAsset',
        entityId: 'asset-1',
        reason: expect.stringContaining('durable cleanup obligation'),
      }),
    );
  });

  it('rejects a missing file part', async () => {
    const { service } = buildService();
    await expect(service.upload(TENANT, undefined, { ...ATTEST })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('refuses to store WITHOUT the frame-content attestation', async () => {
    // Text screening cannot inspect pixels: nothing reaches storage unless
    // the operator explicitly attested the staged clip's frames carry no
    // payment-card/credential content.
    const { service, storage, repository } = buildService();
    for (const dto of [
      { attestNoSensitiveContent: '' },
      { attestNoSensitiveContent: 'false' },
      { attestNoSensitiveContent: 'TRUE ' },
      {} as { attestNoSensitiveContent: string },
    ]) {
      await expect(
        service.upload(TENANT, uploadFile(), dto),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(storage.put).not.toHaveBeenCalled();
    expect(repository.createAsset).not.toHaveBeenCalled();
  });

  it.each([
    ['../../../etc/passwd.mp4'],
    ['dir/clip.mp4'],
    ['dir\\clip.mp4'],
    ['.hidden.mp4'],
  ])('rejects traversal-shaped filename %p', async (originalname) => {
    const { service, storage } = buildService();
    await expect(
      service.upload(TENANT, uploadFile({ originalname }), { ...ATTEST }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('sanitizes awkward-but-safe filenames for display', async () => {
    const { service, repository } = buildService();
    await service.upload(TENANT, uploadFile({ originalname: 'my clip (1).mp4' }), { ...ATTEST });
    const [, data] = repository.createAsset.mock.calls[0] as unknown as [string, { originalFilename: string }];
    expect(data.originalFilename).toBe('my_clip__1_.mp4');
  });

  it.each([
    ['clip.exe', 'application/octet-stream'],
    ['clip.sh', 'text/x-shellscript'],
    ['clip.jpg', 'image/jpeg'],
    ['clip.mp4', 'video/webm'], // MIME/extension mismatch
  ])('rejects unsupported upload %p (%p)', async (originalname, mimetype) => {
    const { service, storage } = buildService();
    await expect(
      service.upload(TENANT, uploadFile({ originalname, mimetype }), { ...ATTEST }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('rejects uploads whose PAYLOAD carries credential- or payment-bearing text', async () => {
    const { service, storage } = buildService();
    for (const embedded of [
      'password=hunter2-in-metadata',
      ['4111', '1111', '1111', '1111'].join(' '),
      ['4111', '1111', '1111', '1111'].join('_'),
    ]) {
      const buffer = Buffer.concat([mp4Buffer(), Buffer.from(embedded, 'ascii')]);
      await expect(
        service.upload(TENANT, uploadFile({ buffer, size: buffer.length }), { ...ATTEST }),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('rejects content whose magic bytes do not match the container', async () => {
    const { service, storage } = buildService();
    const script = Buffer.from('#!/bin/sh\necho pwned\n'.padEnd(64, ' '), 'ascii');
    await expect(
      service.upload(TENANT, uploadFile({ buffer: script, size: script.length }), { ...ATTEST }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('rejects oversized uploads with 413', async () => {
    const { service, storage } = buildService({ maxUploadBytes: '64' });
    const big = Buffer.concat([mp4Buffer(), Buffer.alloc(128)]);
    await expect(
      service.upload(TENANT, uploadFile({ buffer: big, size: big.length }), { ...ATTEST }),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('rejects payment-bearing filenames, including separator-obfuscated PANs', async () => {
    const { service } = buildService();
    const panParts = ['4111', '1111', '1111', '1111'];
    for (const originalname of [
      `${panParts.join('')}.mp4`,
      `${panParts.join('_')}.mp4`,
      // '.'-separated PAN — traversal check rejects '..' but not single
      // dots, so the sensitive screen must catch it.
      `pan${panParts.join('-')}.mp4`,
      'password_hunter2.mp4',
    ]) {
      await expect(
        service.upload(TENANT, uploadFile({ originalname }), { ...ATTEST }),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it('commits the asset row BEFORE any byte reaches storage (DB-first staging)', async () => {
    // A crash between the two steps must leave a row referencing the key —
    // the row IS the recovery record. The old put-then-create ordering
    // stranded quarantined media no row referenced (unrecoverable orphan).
    const { service, repository, storage } = buildService();
    await service.upload(TENANT, uploadFile(), { ...ATTEST });
    const createOrder = (repository.createAsset as jest.Mock).mock
      .invocationCallOrder[0];
    const putOrder = (storage.put as jest.Mock).mock.invocationCallOrder[0];
    expect(createOrder).toBeLessThan(putOrder);
  });

  it('marks the committed row FAILED (UPLOAD_INCOMPLETE) and 503s when the media write fails', async () => {
    // DB-first consequence: the row is already durable when put fails. The
    // media dir is removed best-effort, the row transitions PENDING_MEDIA →
    // FAILED with the stable UPLOAD_INCOMPLETE code (error codes exist
    // exactly on REJECTED/FAILED — the error_only_terminal_check
    // constraint), the transition is audited, and the caller sees the
    // storage failure as the existing controlled 503. The row remains as
    // durable evidence referencing the key. Because the staging state is
    // NOT screenable, this CAS can never lose to a concurrent APPROVE.
    const put = jest.fn(async () => {
      throw new VideoStorageOperationError();
    });
    let auditReason: string | undefined;
    const transitionStatus = jest.fn(
      async (
        _t: string,
        _id: string,
        _expected: unknown,
        data: { status: VideoAssetStatus },
        build: (b: unknown, a: unknown) => { reason?: string },
      ) => {
        const after = assetRow({ ...data });
        auditReason = build(
          assetRow({ status: VideoAssetStatus.PENDING_MEDIA }),
          after,
        ).reason;
        return after;
      },
    );
    const { service, repository, storage } = buildService({
      storage: { put },
      repository: { transitionStatus },
    });
    await expect(
      service.upload(TENANT, uploadFile(), { ...ATTEST }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    // Best-effort media-dir removal ran BEFORE the FAILED transition.
    expect(storage.deletePrefix).toHaveBeenCalledTimes(1);
    expect(
      (storage.deletePrefix as jest.Mock).mock.invocationCallOrder[0],
    ).toBeLessThan(transitionStatus.mock.invocationCallOrder[0]);
    const [, , expected, data] = repository.transitionStatus.mock
      .calls[0] as unknown as [
      string,
      string,
      VideoAssetStatus[],
      { status: VideoAssetStatus; errorCode: string },
    ];
    expect(expected).toEqual([VideoAssetStatus.PENDING_MEDIA]);
    expect(data.status).toBe(VideoAssetStatus.FAILED);
    expect(data.errorCode).toBe('UPLOAD_INCOMPLETE');
    expect(auditReason).toContain('recovery record');
  });

  it('still records the FAILED transition when the best-effort removal keeps failing', async () => {
    // The removal is BEST-EFFORT (prefix removal is idempotent and the
    // FAILED row is what an operator acts on): a persistent removal
    // failure must not swallow the durable evidence transition or the 503.
    const put = jest.fn(async () => {
      throw new VideoStorageOperationError();
    });
    const deletePrefix = jest.fn(async () => {
      throw new Error('EACCES');
    });
    const { service, repository } = buildService({
      storage: { put, deletePrefix },
    });
    await expect(
      service.upload(TENANT, uploadFile(), { ...ATTEST }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    // One retry, then the escalation is swallowed (best-effort) — never an
    // unbounded loop, and the FAILED claim still lands.
    expect(deletePrefix).toHaveBeenCalledTimes(2);
    expect(repository.transitionStatus).toHaveBeenCalledTimes(1);
    const [, , , data] = repository.transitionStatus.mock
      .calls[0] as unknown as [
      string,
      string,
      VideoAssetStatus[],
      { status: VideoAssetStatus; errorCode: string },
    ];
    expect(data.status).toBe(VideoAssetStatus.FAILED);
    expect(data.errorCode).toBe('UPLOAD_INCOMPLETE');
  });

  it('rejects context references that do not form one consistent hierarchy', async () => {
    // Same rules and vocabulary as PrismaInferenceQueue.enqueue(): an asset
    // the queue would later reject must fail AT UPLOAD — and DB-first
    // staging means the rejection happens BEFORE any bytes are written, so
    // there is nothing to clean up.
    const { service, storage } = buildService({
      repository: {
        createAsset: jest.fn(async () => 'unit-location-mismatch' as const),
      },
    });
    await expect(
      service.upload(TENANT, uploadFile(), {
        ...ATTEST,
        locationId: 'loc-1',
        unitId: 'unit-from-other-store',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(storage.put).not.toHaveBeenCalled();
    expect(storage.deletePrefix).not.toHaveBeenCalled();
  });

  it('maps broken references to a controlled 400 with no bytes written', async () => {
    const { service, storage } = buildService({
      repository: {
        createAsset: jest.fn(async () => {
          throw Object.assign(new Error('fk'), { code: 'P2003' });
        }),
      },
    });
    await expect(
      service.upload(TENANT, uploadFile(), { ...ATTEST, unitId: 'other-tenant-unit' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(storage.put).not.toHaveBeenCalled();
    expect(storage.deletePrefix).not.toHaveBeenCalled();
  });

  it('REDACTS payment-bearing reference ids from reference-rejection messages', async () => {
    // The rejection message reflects CALLER-SUPPLIED, unresolved ids —
    // error responses land in logs and telemetry, so a PAN smuggled as a
    // reference id must echo back as [REDACTED], never verbatim.
    const pan = '4111111111111111';
    const cases: [string, Record<string, string>][] = [
      ['location-not-found', { locationId: pan }],
      ['unit-not-found', { unitId: pan }],
      ['unit-location-mismatch', { unitId: pan, locationId: pan }],
      ['device-not-found', { deviceId: pan }],
      ['device-unit-mismatch', { deviceId: pan, unitId: pan }],
      ['session-not-found', { sessionId: pan }],
      ['session-unit-mismatch', { sessionId: pan, unitId: pan }],
    ];
    for (const [rejection, refs] of cases) {
      const { service } = buildService({
        repository: { createAsset: jest.fn(async () => rejection) },
      });
      const error: Error = await service
        .upload(TENANT, uploadFile(), { ...ATTEST, ...refs })
        .then(() => {
          throw new Error('expected rejection');
        })
        .catch((caught: Error) => caught);
      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.message).toContain('[REDACTED]');
      expect(error.message).not.toContain(pan);
    }
  });
});

describe('VideoAssetsService.upload pre-storage frame screening', () => {
  it('screens the COMPLETE 1 fps frame stream through OCR from the IN-MEMORY buffer: a 10 s clip OCRs ALL 10 frames', async () => {
    // Codex P1 "screen more than six frames": the mandatory pre-storage
    // screen inspects EVERY started second — one decoded frame per second
    // in ONE extractFramesPerSecond pass (frame i = second i, timestamp
    // i*1000 ms) — not 6 sparse samples. Each frame's recognized text
    // runs through the fused sensitive-text predicate, and only a clean,
    // COMPLETE pass reaches durable storage. The session is closed.
    const { service, repository, storage, extractor, recognizer, inspectClose } =
      buildService();
    const file = uploadFile();
    const asset = await service.upload(TENANT, file, { ...ATTEST });
    expect((asset as { status: VideoAssetStatus }).status).toBe(
      VideoAssetStatus.QUARANTINED,
    );
    // The screen consumes the in-memory buffer through the extractor port.
    expect(extractor.inspectBuffer).toHaveBeenCalledTimes(1);
    expect(
      (extractor.inspectBuffer as jest.Mock).mock.calls[0][0],
    ).toBe(file.buffer);
    // ONE 1 fps pass carrying the derived per-frame byte budget.
    expect(extractor.extractFramesPerSecond).toHaveBeenCalledTimes(1);
    expect(
      (extractor.extractFramesPerSecond as jest.Mock).mock.calls[0][0],
    ).toEqual({ maxBytesPerFrame: PRESTORE_SCREENING_MAX_FRAME_BYTES });
    // 10 s probed clip → ALL 10 started seconds OCR'd (not 6).
    expect(recognizer.recognize).toHaveBeenCalledTimes(10);
    // The unscreened bytes NEVER touch the storage port: the only write
    // ever issued is the durable put of the SCREENED bytes.
    expect(storage.put).toHaveBeenCalledTimes(1);
    // Ordering: row commit → in-memory screen (open → close) → durable
    // put → publish.
    const createOrder = (repository.createAsset as jest.Mock).mock
      .invocationCallOrder[0];
    const inspectOrder = (extractor.inspectBuffer as jest.Mock).mock
      .invocationCallOrder[0];
    const closeOrder = inspectClose.mock.invocationCallOrder[0];
    const putOrder = (storage.put as jest.Mock).mock.invocationCallOrder[0];
    expect(createOrder).toBeLessThan(inspectOrder);
    expect(inspectOrder).toBeLessThan(closeOrder);
    expect(closeOrder).toBeLessThan(putOrder);
    expect(inspectClose).toHaveBeenCalledTimes(1);
  });

  it('requires and screens TWO frames for a 1.9 s clip (every STARTED second)', async () => {
    // ceil(1900/1000) = 2 started seconds → 2 required frames, both
    // delivered by the single 1 fps pass and both OCR'd.
    const { service, storage, recognizer } = buildService({
      extractor: {
        probe: jest.fn(async () => ({
          durationMs: 1900,
          width: 1280,
          height: 720,
          fps: 30,
        })),
      },
    });
    await service.upload(TENANT, uploadFile(), { ...ATTEST });
    expect(recognizer.recognize).toHaveBeenCalledTimes(2);
    expect(storage.put).toHaveBeenCalledTimes(1);
  });

  it('still screens a single frame for a sub-second clip', async () => {
    const { service, storage, recognizer } = buildService({
      extractor: {
        probe: jest.fn(async () => ({
          durationMs: 400,
          width: 640,
          height: 360,
          fps: 30,
        })),
      },
    });
    await service.upload(TENANT, uploadFile(), { ...ATTEST });
    expect(recognizer.recognize).toHaveBeenCalledTimes(1);
    expect(storage.put).toHaveBeenCalledTimes(1);
  });

  it('rejects a clip over the screening duration ceiling BEFORE any frame decode or storage write (audited 400)', async () => {
    // Owner MVP for full-coverage screening: a clip longer than
    // VIDEO_MAX_SCREENING_DURATION_MS (default 30 s) cannot have every
    // started second screened inside the synchronous request, so it is
    // refused fail-closed — audited PENDING_MEDIA → REJECTED with the
    // stable PRESTORE code, nothing decoded, nothing stored.
    let auditReason: string | undefined;
    const transitionStatus = jest.fn(
      async (
        _t: string,
        _id: string,
        _expected: unknown,
        data: { status: VideoAssetStatus },
        build: (b: unknown, a: unknown) => { reason?: string },
      ) => {
        const after = assetRow({ ...data });
        auditReason = build(
          assetRow({ status: VideoAssetStatus.PENDING_MEDIA }),
          after,
        ).reason;
        return after;
      },
    );
    const { service, repository, storage, extractor, recognizer, inspectClose } =
      buildService({
        extractor: {
          probe: jest.fn(async () => ({
            durationMs: 31_000,
            width: 1280,
            height: 720,
            fps: 30,
          })),
        },
        repository: { transitionStatus },
      });
    const error: Error = await service
      .upload(TENANT, uploadFile(), { ...ATTEST })
      .then(() => {
        throw new Error('expected rejection');
      })
      .catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.message).toContain(
      'exceeds the Phase 10 screening duration limit',
    );
    // Refused before ANY frame extraction or OCR.
    expect(extractor.extractFramesPerSecond).not.toHaveBeenCalled();
    expect(recognizer.recognize).not.toHaveBeenCalled();
    expect(storage.put).not.toHaveBeenCalled();
    expect(inspectClose).toHaveBeenCalledTimes(1);
    const [, , expected, data] = repository.transitionStatus.mock
      .calls[0] as unknown as [
      string,
      string,
      VideoAssetStatus[],
      { status: VideoAssetStatus; errorCode: string },
    ];
    expect(expected).toEqual([VideoAssetStatus.PENDING_MEDIA]);
    expect(data.status).toBe(VideoAssetStatus.REJECTED);
    expect(data.errorCode).toBe('PRESTORE_SCREENING_REJECTED');
    expect(auditReason).toContain('VIDEO_MAX_SCREENING_DURATION_MS');
  });

  it('honors a configured VIDEO_MAX_SCREENING_DURATION_MS above the default and screens the whole longer clip', async () => {
    const { service, storage, recognizer } = buildService({
      maxScreeningDurationMs: '60000',
      extractor: {
        probe: jest.fn(async () => ({
          durationMs: 45_000,
          width: 1280,
          height: 720,
          fps: 30,
        })),
      },
    });
    await service.upload(TENANT, uploadFile(), { ...ATTEST });
    // 45 started seconds, every one OCR'd before the media write.
    expect(recognizer.recognize).toHaveBeenCalledTimes(45);
    expect(storage.put).toHaveBeenCalledTimes(1);
  });

  it('fails CLOSED (400, incomplete frame coverage) when the 1 fps pass yields fewer frames than started seconds', async () => {
    // Codex P1 "fail closed when no frame can be screened" — generalized:
    // EVERY started second must have been screened, so partial coverage
    // (here 4 of 10) is refused exactly like an unscreened upload.
    let auditReason: string | undefined;
    const transitionStatus = jest.fn(
      async (
        _t: string,
        _id: string,
        _expected: unknown,
        data: { status: VideoAssetStatus },
        build: (b: unknown, a: unknown) => { reason?: string },
      ) => {
        const after = assetRow({ ...data });
        auditReason = build(
          assetRow({ status: VideoAssetStatus.PENDING_MEDIA }),
          after,
        ).reason;
        return after;
      },
    );
    const { service, repository, storage, recognizer, inspectClose } =
      buildService({
        extractor: {
          extractFramesPerSecond: jest.fn(async () =>
            Array.from({ length: 4 }, () => Buffer.from('f')),
          ),
        },
        repository: { transitionStatus },
      });
    const error: Error = await service
      .upload(TENANT, uploadFile(), { ...ATTEST })
      .then(() => {
        throw new Error('expected rejection');
      })
      .catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.message).toContain('incomplete frame coverage');
    // Nothing was OCR'd (the incomplete pass is refused wholesale) and
    // nothing was durably stored.
    expect(recognizer.recognize).not.toHaveBeenCalled();
    expect(storage.put).not.toHaveBeenCalled();
    expect(inspectClose).toHaveBeenCalledTimes(1);
    const [, , expected, data] = repository.transitionStatus.mock
      .calls[0] as unknown as [
      string,
      string,
      VideoAssetStatus[],
      { status: VideoAssetStatus; errorCode: string },
    ];
    expect(expected).toEqual([VideoAssetStatus.PENDING_MEDIA]);
    expect(data.status).toBe(VideoAssetStatus.REJECTED);
    expect(data.errorCode).toBe('PRESTORE_SCREENING_REJECTED');
    expect(auditReason).toContain('4 of 10');
    expect(auditReason).toContain('incomplete');
  });

  it('fails CLOSED when ZERO frames are decodable (FrameUnavailableError): 400, nothing stored', async () => {
    // The decode ran and yielded nothing — zero coverage is the extreme
    // case of incomplete coverage and must never pass unscreened.
    let auditReason: string | undefined;
    const transitionStatus = jest.fn(
      async (
        _t: string,
        _id: string,
        _expected: unknown,
        data: { status: VideoAssetStatus },
        build: (b: unknown, a: unknown) => { reason?: string },
      ) => {
        const after = assetRow({ ...data });
        auditReason = build(
          assetRow({ status: VideoAssetStatus.PENDING_MEDIA }),
          after,
        ).reason;
        return after;
      },
    );
    const { service, repository, storage, recognizer, inspectClose } =
      buildService({
        extractor: {
          extractFramesPerSecond: jest.fn(async () => {
            throw new FrameUnavailableError();
          }),
        },
        repository: { transitionStatus },
      });
    const error: Error = await service
      .upload(TENANT, uploadFile(), { ...ATTEST })
      .then(() => {
        throw new Error('expected rejection');
      })
      .catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.message).toContain('incomplete frame coverage');
    expect(recognizer.recognize).not.toHaveBeenCalled();
    expect(storage.put).not.toHaveBeenCalled();
    expect(inspectClose).toHaveBeenCalledTimes(1);
    const [, , , data] = repository.transitionStatus.mock
      .calls[0] as unknown as [
      string,
      string,
      VideoAssetStatus[],
      { status: VideoAssetStatus; errorCode: string },
    ];
    expect(data.status).toBe(VideoAssetStatus.REJECTED);
    expect(data.errorCode).toBe('PRESTORE_SCREENING_REJECTED');
    expect(auditReason).toContain('0 of 10');
  });

  it('fails CLOSED (400) when a frame exceeds the screening byte budget — an uninspectable frame is never stored', async () => {
    let auditReason: string | undefined;
    const transitionStatus = jest.fn(
      async (
        _t: string,
        _id: string,
        _expected: unknown,
        data: { status: VideoAssetStatus },
        build: (b: unknown, a: unknown) => { reason?: string },
      ) => {
        const after = assetRow({ ...data });
        auditReason = build(
          assetRow({ status: VideoAssetStatus.PENDING_MEDIA }),
          after,
        ).reason;
        return after;
      },
    );
    const { service, repository, storage, recognizer, inspectClose } =
      buildService({
        extractor: {
          extractFramesPerSecond: jest.fn(async () => {
            throw new FrameExceedsBudgetError();
          }),
        },
        repository: { transitionStatus },
      });
    const error: Error = await service
      .upload(TENANT, uploadFile(), { ...ATTEST })
      .then(() => {
        throw new Error('expected rejection');
      })
      .catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.message).toContain('screening byte budget');
    expect(recognizer.recognize).not.toHaveBeenCalled();
    expect(storage.put).not.toHaveBeenCalled();
    expect(inspectClose).toHaveBeenCalledTimes(1);
    const [, , , data] = repository.transitionStatus.mock
      .calls[0] as unknown as [
      string,
      string,
      VideoAssetStatus[],
      { status: VideoAssetStatus; errorCode: string },
    ];
    expect(data.status).toBe(VideoAssetStatus.REJECTED);
    expect(data.errorCode).toBe('PRESTORE_SCREENING_REJECTED');
    expect(auditReason).toContain('byte budget');
  });

  it('rejects the upload 400 (PRESTORE_SCREENING_REJECTED) when a frame carries a PAN — media never stored', async () => {
    // The Codex finding this closes: pixels showing a PAN pass every
    // filename/container-text check, and the attestation proves nothing.
    // The OCR hit must reject BEFORE storage.put — and neither the 400 nor
    // the audit trail may carry the recognized text (it IS card data).
    // The PAN sits in FRAME 3 of the 1 fps stream, so the recorded index
    // maps directly to second 3 (timestamp 3000 ms) of the clip.
    const pan = '4111 1111 1111 1111';
    let auditReason: string | undefined;
    const transitionStatus = jest.fn(
      async (
        _t: string,
        _id: string,
        _expected: unknown,
        data: { status: VideoAssetStatus },
        build: (b: unknown, a: unknown) => { reason?: string },
      ) => {
        const after = assetRow({ ...data });
        auditReason = build(
          assetRow({ status: VideoAssetStatus.PENDING_MEDIA }),
          after,
        ).reason;
        return after;
      },
    );
    let ocrCalls = 0;
    const { service, repository, storage, recognizer, inspectClose } =
      buildService({
        recognizer: {
          recognize: jest.fn(async () => {
            ocrCalls += 1;
            return ocrCalls === 4 ? `PAY CARD ${pan} OK` : 'aisle four';
          }),
        },
        repository: { transitionStatus },
      });
    const error: Error = await service
      .upload(TENANT, uploadFile(), { ...ATTEST })
      .then(() => {
        throw new Error('expected rejection');
      })
      .catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(BadRequestException);
    // No recognized text anywhere — message or audit.
    expect(error.message).not.toContain('4111');
    expect(auditReason).not.toContain('4111');
    // Only WHICH frame (= which second) tripped the screen is recorded.
    expect(auditReason).toContain('frame 3');
    expect(auditReason).toContain('second 3');
    // The screen stopped at the hit — frames 0..3 were OCR'd.
    expect(recognizer.recognize).toHaveBeenCalledTimes(4);
    // Terminal claim: PENDING_MEDIA → REJECTED with the stable code.
    const [, , expected, data] = repository.transitionStatus.mock
      .calls[0] as unknown as [
      string,
      string,
      VideoAssetStatus[],
      { status: VideoAssetStatus; errorCode: string },
    ];
    expect(expected).toEqual([VideoAssetStatus.PENDING_MEDIA]);
    expect(data.status).toBe(VideoAssetStatus.REJECTED);
    expect(data.errorCode).toBe('PRESTORE_SCREENING_REJECTED');
    // The media NEVER reached durable storage — no storage write of any
    // kind — and the in-memory inspection session was closed BEFORE the
    // terminal claim.
    expect(storage.put).not.toHaveBeenCalled();
    expect(inspectClose).toHaveBeenCalledTimes(1);
    expect(inspectClose.mock.invocationCallOrder[0]).toBeLessThan(
      transitionStatus.mock.invocationCallOrder[0],
    );
  });

  it.each([
    ['extractor does not read real bytes', { extractor: { readsRealBytes: false } }],
    ['recognizer does not read real pixels', { recognizer: { readsRealPixels: false } }],
  ])('fails CLOSED with 503 BEFORE any row or bytes when the %s', async (_case, overrides) => {
    const { service, repository, storage, extractor } = buildService(
      overrides as Parameters<typeof buildService>[0],
    );
    const error: Error = await service
      .upload(TENANT, uploadFile(), { ...ATTEST })
      .then(() => {
        throw new Error('expected rejection');
      })
      .catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    // The controlled message names the required configuration — and never
    // suggests the removed unscreened-upload bypass.
    expect(error.message).toContain('VIDEO_FFMPEG_ENABLED');
    expect(error.message).toContain('VIDEO_OCR_ENABLED');
    expect(error.message).not.toContain('VIDEO_UNSAFE_ALLOW_UNSCREENED_UPLOADS');
    // Refused BEFORE the row commit, any inspection, and any storage write.
    expect(repository.createAsset).not.toHaveBeenCalled();
    expect(extractor.inspectBuffer).not.toHaveBeenCalled();
    expect(storage.put).not.toHaveBeenCalled();
  });

  it.each(['development', 'test', 'production', undefined])(
    'has NO unscreened-upload bypass under NODE_ENV=%s: simulated adapters stay 503 even with the removed flag set',
    async (nodeEnv) => {
      // Codex P1 "remove the unscreened-upload bypass": the payment
      // invariant has no dev/test exception. Even with the (now
      // unsupported) flag present in config, NO environment persists an
      // unscreened upload — the availability gate 503s unconditionally
      // and nothing reaches the repository or storage.
      const { service, repository, storage, extractor, recognizer } =
        buildService({
          recognizer: { readsRealPixels: false },
          allowUnscreenedUploads: 'true',
          nodeEnv,
        });
      await expect(
        service.upload(TENANT, uploadFile(), { ...ATTEST }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(repository.createAsset).not.toHaveBeenCalled();
      expect(extractor.inspectBuffer).not.toHaveBeenCalled();
      expect(recognizer.recognize).not.toHaveBeenCalled();
      expect(storage.put).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['OCR infrastructure failure', new FrameTextRecognitionInfrastructureError()],
    // The tool ran and could not process the frame: an unreadable frame is
    // an INCOMPLETE screen, never a pass — same fail-closed outcome.
    ['OCR content failure', new FrameTextRecognitionFailedError()],
  ])('maps an %s to FAILED/UPLOAD_INCOMPLETE and 503 with the session closed', async (_case, failure) => {
    const { service, repository, storage, inspectClose } = buildService({
      recognizer: {
        recognize: jest.fn(async () => {
          throw failure;
        }),
      },
    });
    await expect(
      service.upload(TENANT, uploadFile(), { ...ATTEST }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    const [, , expected, data] = repository.transitionStatus.mock
      .calls[0] as unknown as [
      string,
      string,
      VideoAssetStatus[],
      { status: VideoAssetStatus; errorCode: string },
    ];
    expect(expected).toEqual([VideoAssetStatus.PENDING_MEDIA]);
    expect(data.status).toBe(VideoAssetStatus.FAILED);
    expect(data.errorCode).toBe('UPLOAD_INCOMPLETE');
    expect(storage.put).not.toHaveBeenCalled();
    expect(inspectClose).toHaveBeenCalledTimes(1);
  });

  it('maps an extractor infrastructure failure mid-screen the same way (row is the record, session closed)', async () => {
    // Under the pinned session contract, opening the session runs no
    // tooling — the probe fails on session.probe(), so the service OWNS
    // the session and must still close it on the failure path.
    const { service, repository, storage, inspectClose } = buildService({
      extractor: {
        probe: jest.fn(async () => {
          throw new ExtractionInfrastructureError();
        }),
      },
    });
    await expect(
      service.upload(TENANT, uploadFile(), { ...ATTEST }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    const [, , , data] = repository.transitionStatus.mock
      .calls[0] as unknown as [
      string,
      string,
      VideoAssetStatus[],
      { status: VideoAssetStatus; errorCode: string },
    ];
    expect(data.status).toBe(VideoAssetStatus.FAILED);
    expect(data.errorCode).toBe('UPLOAD_INCOMPLETE');
    expect(storage.put).not.toHaveBeenCalled();
    expect(inspectClose).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['generic content failure', new ExtractionFailedError()],
    // The pinned session contract reports a non-faststart/unstreamable
    // container as a fail-closed CONTENT failure with a fixed, controlled
    // message — same REJECTED/PROBE_FAILED outcome.
    ['unstreamable container', new ExtractionFailedError(UNSTREAMABLE_CONTAINER_MESSAGE)],
  ])('rejects an upload the extractor cannot read (%s) as REJECTED/PROBE_FAILED (400)', async (_case, failure) => {
    // Magic bytes matched but the real probe says the content is not a
    // decodable video: an upload whose frames CANNOT be screened must not
    // reach durable storage — controlled 400, terminal REJECTED row.
    const { service, repository, storage, inspectClose } = buildService({
      extractor: {
        probe: jest.fn(async () => {
          throw failure;
        }),
      },
    });
    const error: Error = await service
      .upload(TENANT, uploadFile(), { ...ATTEST })
      .then(() => {
        throw new Error('expected rejection');
      })
      .catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(BadRequestException);
    // The response is the CONTROLLED prestore wording, never interpolated
    // from the extraction error.
    expect(error.message).toContain('could not be read as a video');
    const [, , , data] = repository.transitionStatus.mock
      .calls[0] as unknown as [
      string,
      string,
      VideoAssetStatus[],
      { status: VideoAssetStatus; errorCode: string },
    ];
    expect(data.status).toBe(VideoAssetStatus.REJECTED);
    expect(data.errorCode).toBe('PROBE_FAILED');
    expect(storage.put).not.toHaveBeenCalled();
    expect(inspectClose).toHaveBeenCalledTimes(1);
  });

  it('fails closed (FAILED/UPLOAD_INCOMPLETE, 503) when the inspection-session cleanup fails', async () => {
    // The adapter could not release the session even after its internal
    // retry — a pending PASS verdict is replaced by the same fail-closed
    // contract as any other screening-infrastructure trouble.
    const close = jest.fn(async () => {
      throw new ExtractionInfrastructureError();
    });
    const { service, repository, storage } = buildService({
      extractor: {
        inspectBuffer: jest.fn(async () => ({
          probe: async () => ({
            durationMs: 10_000,
            width: 1280,
            height: 720,
            fps: 30,
          }),
          extractFramesPerSecond: async () =>
            Array.from({ length: 10 }, () => Buffer.from('f')),
          close,
        })),
      },
    });
    await expect(
      service.upload(TENANT, uploadFile(), { ...ATTEST }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(close).toHaveBeenCalledTimes(1);
    const [, , , data] = repository.transitionStatus.mock
      .calls[0] as unknown as [
      string,
      string,
      VideoAssetStatus[],
      { status: VideoAssetStatus; errorCode: string },
    ];
    expect(data.status).toBe(VideoAssetStatus.FAILED);
    expect(data.errorCode).toBe('UPLOAD_INCOMPLETE');
    expect(storage.put).not.toHaveBeenCalled();
  });
});

describe('VideoAssetsService.validate', () => {
  it('records probe metadata on the UPLOADED → VALIDATED transition', async () => {
    const { service, repository } = buildService({
      repository: {
        findByIdInternal: jest.fn(async () =>
          assetRow({ status: VideoAssetStatus.UPLOADED, durationMs: null, width: null, height: null, fps: null }),
        ),
      },
    });
    await service.validate(TENANT, 'asset-1');
    const [, , expected, data] = repository.transitionStatus.mock.calls[0] as unknown as [
      string,
      string,
      VideoAssetStatus[],
      { status: VideoAssetStatus; durationMs: number },
    ];
    expect(expected).toEqual([VideoAssetStatus.UPLOADED]);
    expect(data.status).toBe(VideoAssetStatus.VALIDATED);
    expect(data.durationMs).toBe(10_000);
  });

  it('is idempotent for already-validated assets (no re-probe)', async () => {
    const { service, extractor } = buildService();
    await service.validate(TENANT, 'asset-1');
    expect(extractor.probe).not.toHaveBeenCalled();
  });

  it('rejects the asset with a stable code when the probe fails', async () => {
    const { service, repository } = buildService({
      repository: {
        findByIdInternal: jest.fn(async () =>
          assetRow({ status: VideoAssetStatus.UPLOADED }),
        ),
      },
      extractor: {
        probe: jest.fn(async () => {
          throw new ExtractionFailedError();
        }),
      },
    });
    await service.validate(TENANT, 'asset-1');
    const [, , , data] = repository.transitionStatus.mock.calls[0] as unknown as [
      string,
      string,
      VideoAssetStatus[],
      { status: VideoAssetStatus; errorCode: string },
    ];
    expect(data.status).toBe(VideoAssetStatus.REJECTED);
    expect(data.errorCode).toBe('PROBE_FAILED');
  });

  it('maps an infrastructure failure during probe to 503 WITHOUT rejecting the asset', async () => {
    // The probe TOOLING could not run (killed/refused/over-buffered) —
    // that says nothing about the video: the asset stays UPLOADED for a
    // retry, with no transition and no audit entry.
    const { service, repository, auditLog } = buildService({
      repository: {
        findByIdInternal: jest.fn(async () =>
          assetRow({ status: VideoAssetStatus.UPLOADED }),
        ),
      },
      extractor: {
        probe: jest.fn(async () => {
          throw new ExtractionInfrastructureError();
        }),
      },
    });
    await expect(service.validate(TENANT, 'asset-1')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(repository.transitionStatus).not.toHaveBeenCalled();
    expect(auditLog.record).not.toHaveBeenCalled();
  });

  it('404s for another tenant’s asset (tenant-scoped lookup)', async () => {
    const { service, repository } = buildService({
      repository: { findByIdInternal: jest.fn(async () => null) },
    });
    await expect(service.validate(TENANT, 'foreign')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect((repository.findByIdInternal.mock.calls[0] as unknown as [string])[0]).toBe(TENANT);
  });

  it('409s validation of a QUARANTINED asset (screening is the enforced gate)', async () => {
    const { service, repository, extractor } = buildService({
      repository: {
        findByIdInternal: jest.fn(async () =>
          assetRow({ status: VideoAssetStatus.QUARANTINED }),
        ),
      },
    });
    await expect(service.validate(TENANT, 'asset-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    // The quarantined bytes were never touched and no transition happened.
    expect(extractor.probe).not.toHaveBeenCalled();
    expect(repository.transitionStatus).not.toHaveBeenCalled();
  });

  it('409s validation of a PENDING_MEDIA asset with a truthful message (media never landed)', async () => {
    // The staging-crash recovery record: its media write never completed,
    // so it can neither be probed nor "validated first" — the message must
    // say so instead of pointing at screening or validation.
    const { service, repository, extractor } = buildService({
      repository: {
        findByIdInternal: jest.fn(async () =>
          assetRow({ status: VideoAssetStatus.PENDING_MEDIA }),
        ),
      },
    });
    const error: Error = await service
      .validate(TENANT, 'asset-1')
      .then(() => {
        throw new Error('expected rejection');
      })
      .catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.message).toContain('PENDING_MEDIA');
    expect(error.message).toContain('media write never completed');
    expect(extractor.probe).not.toHaveBeenCalled();
    expect(repository.transitionStatus).not.toHaveBeenCalled();
  });
});

describe('VideoAssetsService.screen', () => {
  const quarantined = () => assetRow({ status: VideoAssetStatus.QUARANTINED });
  // A QUARANTINED row carrying FRESH server-stamped inspection evidence —
  // what the guarded preview-serve authorization records after actually
  // serving frames. APPROVE requires this; plain quarantined() must 409.
  const inspectedAt = new Date();
  const inspectedQuarantined = () =>
    assetRow({
      status: VideoAssetStatus.QUARANTINED,
      screeningInspectedAt: inspectedAt,
      screeningInspectedBy: 'screener-1',
      screeningInspectedFrames: 6,
    });

  it('APPROVE transitions QUARANTINED → UPLOADED through the audited CAS machinery, recording the evidence consumed', async () => {
    let entry: { reason?: string } | undefined;
    const transitionStatus = jest.fn(
      async (
        _t: string,
        _id: string,
        _expected: unknown,
        data: { status: VideoAssetStatus },
        build: (b: unknown, a: unknown) => unknown,
      ) => {
        const after = assetRow({ ...data });
        entry = build(inspectedQuarantined(), after) as { reason?: string };
        return after;
      },
    );
    const { service, repository } = buildService({
      repository: {
        findByIdInternal: jest.fn(async () => inspectedQuarantined()),
        transitionStatus,
      },
    });
    const result = await service.screen(
      TENANT,
      'asset-1',
      { decision: VideoScreeningDecision.APPROVE },
      { id: 'u1', email: 'screener@x.io' },
    );
    expect((result as { status: VideoAssetStatus }).status).toBe(
      VideoAssetStatus.UPLOADED,
    );
    const [, , expected, data, , guard] = repository.transitionStatus.mock
      .calls[0] as unknown as [
      string,
      string,
      VideoAssetStatus[],
      { status: VideoAssetStatus; errorCode?: string },
      unknown,
      (before: unknown) => void,
    ];
    expect(expected).toEqual([VideoAssetStatus.QUARANTINED]);
    expect(data.status).toBe(VideoAssetStatus.UPLOADED);
    expect(data.errorCode).toBeUndefined();
    // The audit reason carries the evidence used: frame count, timestamp,
    // and the inspecting actor.
    expect(entry?.reason).toContain('screening approved');
    expect(entry?.reason).toContain('6 preview frame(s)');
    expect(entry?.reason).toContain(inspectedAt.toISOString());
    expect(entry?.reason).toContain('screener-1');
    // ATOMICITY: the evidence gate also rides INSIDE the CAS transaction —
    // the guard passed to the repository re-checks the CURRENT row, so a
    // row whose evidence is gone by decision time vetoes the transition.
    expect(typeof guard).toBe('function');
    expect(() => guard(inspectedQuarantined())).not.toThrow();
    expect(() => guard(quarantined())).toThrow(ConflictException);
  });

  it('APPROVE unlocks validation (the released asset probes normally)', async () => {
    const findByIdInternal = jest
      .fn()
      .mockResolvedValueOnce(inspectedQuarantined()) // screen() read
      .mockResolvedValueOnce(assetRow({ status: VideoAssetStatus.UPLOADED })); // validate() read
    const { service, extractor } = buildService({
      repository: { findByIdInternal },
    });
    await service.screen(TENANT, 'asset-1', {
      decision: VideoScreeningDecision.APPROVE,
    });
    await service.validate(TENANT, 'asset-1');
    expect(extractor.probe).toHaveBeenCalledTimes(1);
  });

  it('APPROVE without inspection evidence is a controlled 409 with NO transition', async () => {
    // Finding D pin: a QUARANTINED row (including one accepted via the
    // unsafe unscreened-upload override) must never be releasable blind —
    // no recorded real-media preview inspection, no approval.
    const { service, repository, storage } = buildService({
      repository: { findByIdInternal: jest.fn(async () => quarantined()) },
    });
    const error: Error = await service
      .screen(TENANT, 'asset-1', { decision: VideoScreeningDecision.APPROVE })
      .then(() => {
        throw new Error('expected rejection');
      })
      .catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.message).toContain('real-media preview inspection');
    expect(repository.transitionStatus).not.toHaveBeenCalled();
    expect(storage.deletePrefix).not.toHaveBeenCalled();
  });

  it('APPROVE with STALE inspection evidence (older than 30 minutes) is a controlled 409', async () => {
    // Freshness: the evidence must reflect a RECENT human look at the
    // frames — an inspection recorded beyond the window forces a fresh
    // preview instead of enabling a stale approval.
    const { service, repository } = buildService({
      repository: {
        findByIdInternal: jest.fn(async () =>
          assetRow({
            status: VideoAssetStatus.QUARANTINED,
            screeningInspectedAt: new Date(Date.now() - 31 * 60 * 1000),
            screeningInspectedBy: 'screener-1',
            screeningInspectedFrames: 6,
          }),
        ),
      },
    });
    await expect(
      service.screen(TENANT, 'asset-1', {
        decision: VideoScreeningDecision.APPROVE,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(repository.transitionStatus).not.toHaveBeenCalled();
  });

  it('APPROVE with zero-frame evidence is a controlled 409 (defense-in-depth: the repository never stamps zero frames)', async () => {
    const { service, repository } = buildService({
      repository: {
        findByIdInternal: jest.fn(async () =>
          assetRow({
            status: VideoAssetStatus.QUARANTINED,
            screeningInspectedAt: new Date(),
            screeningInspectedBy: 'screener-1',
            screeningInspectedFrames: 0,
          }),
        ),
      },
    });
    await expect(
      service.screen(TENANT, 'asset-1', {
        decision: VideoScreeningDecision.APPROVE,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(repository.transitionStatus).not.toHaveBeenCalled();
  });

  it('REJECT-then-re-check: rejecting NEVER requires evidence, and a re-published QUARANTINED row starts with none', async () => {
    // REJECT works blind by design (rejecting is safe); the transition
    // clears any evidence at the repository, so an approval attempted on a
    // fresh evidence-less QUARANTINED row (e.g. after a re-upload) 409s.
    const { service, repository } = buildService({
      repository: {
        findByIdInternal: jest
          .fn()
          .mockResolvedValueOnce(quarantined()) // REJECT read — no evidence
          .mockResolvedValueOnce(quarantined()), // later APPROVE read — none either
      },
    });
    const rejected = await service.screen(TENANT, 'asset-1', {
      decision: VideoScreeningDecision.REJECT,
    });
    expect((rejected as { status: VideoAssetStatus }).status).toBe(
      VideoAssetStatus.REJECTED,
    );
    await expect(
      service.screen(TENANT, 'asset-1', {
        decision: VideoScreeningDecision.APPROVE,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    // Only the REJECT transitioned; the blind APPROVE never reached the CAS.
    expect(repository.transitionStatus).toHaveBeenCalledTimes(1);
  });

  it('REJECT removes the stored media and records the terminal transition', async () => {
    let entry: { reason?: string } | undefined;
    const transitionStatus = jest.fn(
      async (
        _t: string,
        _id: string,
        _expected: unknown,
        data: { status: VideoAssetStatus },
        build: (b: unknown, a: unknown) => unknown,
      ) => {
        const after = assetRow({ ...data });
        entry = build(quarantined(), after) as { reason?: string };
        return after;
      },
    );
    const { service, storage, repository, auditLog } = buildService({
      repository: {
        findByIdInternal: jest.fn(async () => quarantined()),
        transitionStatus,
      },
    });
    const result = await service.screen(TENANT, 'asset-1', {
      decision: VideoScreeningDecision.REJECT,
      note: 'payment terminal visible in frame 3',
    });
    expect((result as { status: VideoAssetStatus }).status).toBe(
      VideoAssetStatus.REJECTED,
    );
    // The asset directory (original + any files) is gone.
    expect(storage.deletePrefix).toHaveBeenCalledWith(`${TENANT}/uuid-1`);
    const [, , expected, data] = repository.transitionStatus.mock
      .calls[0] as unknown as [
      string,
      string,
      VideoAssetStatus[],
      { status: VideoAssetStatus; errorCode: string; errorMessage: string },
    ];
    expect(expected).toEqual([VideoAssetStatus.QUARANTINED]);
    expect(data.status).toBe(VideoAssetStatus.REJECTED);
    expect(data.errorCode).toBe('SCREENING_REJECTED');
    // The CLAIM's durable evidence records the removal as PENDING — at
    // claim time it has not happened yet and can still fail; it must
    // never assert the media "was removed" before it was.
    expect(data.errorMessage).toContain('media removal is pending');
    expect(data.errorMessage).not.toContain('was removed');
    expect(entry?.reason).toContain('media removal pending');
    // CLAIM-FIRST ordering: the audited terminal transition commits BEFORE
    // any media removal, so a concurrent APPROVE can never release an
    // asset whose bytes are already gone.
    const claimOrder = (transitionStatus as jest.Mock).mock
      .invocationCallOrder[0];
    const removalOrder = (storage.deletePrefix as jest.Mock).mock
      .invocationCallOrder[0];
    expect(claimOrder).toBeLessThan(removalOrder);
    // The screened operator note rides in the audited record.
    expect(entry?.reason).toContain('screening rejected');
    expect(entry?.reason).toContain('payment terminal visible in frame 3');
    // COMPLETION is recorded only after the removal actually succeeded —
    // through the exactly-once marker CAS (the repository writes the
    // completion entry inside that transaction), AFTER deletePrefix ran.
    expect(repository.recordMediaRemovalCompleted).toHaveBeenCalledTimes(1);
    expect(
      (repository.recordMediaRemovalCompleted as jest.Mock).mock
        .invocationCallOrder[0],
    ).toBeGreaterThan(removalOrder);
    const buildCompletion = (
      repository.recordMediaRemovalCompleted as jest.Mock
    ).mock.calls[0][2] as () => {
      action: string;
      entityType: string;
      entityId: string;
      reason: string;
    };
    const completion = buildCompletion();
    expect(completion.action).toBe('DELETE');
    expect(completion.entityType).toBe('VideoAsset');
    expect(completion.entityId).toBe('asset-1');
    expect(completion.reason).toContain('media removal completed');
    // The completion entry commits inside the repository's marker
    // transaction — the service writes no direct audit here.
    expect(auditLog.record).not.toHaveBeenCalled();
  });

  it('REJECT that loses the claim CAS to a concurrent decision 409s WITHOUT touching media', async () => {
    // A concurrent APPROVE (or another REJECT) resolved first: the claim
    // loses the compare-and-set, the rejection is a controlled 409, and —
    // claim-first — the stored media was never touched, so the winning
    // APPROVE released an asset whose bytes are fully intact.
    const { service, storage } = buildService({
      repository: {
        findByIdInternal: jest.fn(async () => quarantined()),
        transitionStatus: jest.fn(async () => null),
      },
    });
    await expect(
      service.screen(TENANT, 'asset-1', {
        decision: VideoScreeningDecision.REJECT,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(storage.deletePrefix).not.toHaveBeenCalled();
  });

  it('REJECT retries a transient media-removal failure and still completes', async () => {
    const deletePrefix = jest
      .fn()
      .mockRejectedValueOnce(new Error('EBUSY'))
      .mockResolvedValueOnce(true);
    const { service, repository } = buildService({
      storage: { deletePrefix },
      repository: { findByIdInternal: jest.fn(async () => quarantined()) },
    });
    await service.screen(TENANT, 'asset-1', {
      decision: VideoScreeningDecision.REJECT,
    });
    expect(deletePrefix).toHaveBeenCalledTimes(2);
    expect(repository.transitionStatus).toHaveBeenCalledTimes(1);
  });

  it('REJECT escalates a persistent media-removal failure as 503 AFTER the terminal claim committed', async () => {
    // Claim-first: the audited QUARANTINED → REJECTED transition is
    // already durable when the removal fails, so the asset is REJECTED —
    // terminal, unprocessable, never served — and the 503 names the
    // orphaned media; replaying the rejection (below) completes the
    // removal.
    const deletePrefix = jest.fn(async () => {
      throw new Error('EACCES');
    });
    const { service, repository, auditLog } = buildService({
      storage: { deletePrefix },
      repository: { findByIdInternal: jest.fn(async () => quarantined()) },
    });
    const error: Error = await service
      .screen(TENANT, 'asset-1', { decision: VideoScreeningDecision.REJECT })
      .then(() => {
        throw new Error('expected rejection');
      })
      .catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    // The controlled 503 names the orphan condition and the recovery path.
    expect(error.message).toContain('orphaned');
    // One retry, then escalation — never an unbounded loop.
    expect(deletePrefix).toHaveBeenCalledTimes(2);
    // The claim committed FIRST (REJECTED with the stable error code).
    expect(repository.transitionStatus).toHaveBeenCalledTimes(1);
    const claimOrder = (repository.transitionStatus as jest.Mock).mock
      .invocationCallOrder[0];
    expect(claimOrder).toBeLessThan(deletePrefix.mock.invocationCallOrder[0]);
    // The removal NEVER succeeded, so NO completion is recorded (the
    // marker CAS is never even attempted): the durable evidence honestly
    // says the removal is still pending.
    expect(repository.recordMediaRemovalCompleted).not.toHaveBeenCalled();
    expect(auditLog.record).not.toHaveBeenCalled();
  });

  it('REJECT replays on an asset already REJECTED by screening: re-attempts the removal and records completion', async () => {
    // Recovery path for a removal that failed post-claim: the SAME
    // endpoint, retried, re-runs the (idempotent) media removal and
    // returns success — allowed for EXACTLY errorCode SCREENING_REJECTED,
    // because only a screening rejection claims media it then removes.
    // This replay actually FINDS media (the earlier removal failed), so it
    // writes the completion audit entry the initial attempt could not.
    const rejectedRow = () =>
      assetRow({
        status: VideoAssetStatus.REJECTED,
        errorCode: 'SCREENING_REJECTED',
        errorMessage:
          'Frame-content screening rejected this upload; media removal is ' +
          'pending (completion is recorded in the audit trail)',
      });
    const { service, storage, repository, auditLog } = buildService({
      repository: {
        findByIdInternal: jest.fn(async () => rejectedRow()),
        findById: jest.fn(async () => rejectedRow()),
      },
    });
    const result = await service.screen(TENANT, 'asset-1', {
      decision: VideoScreeningDecision.REJECT,
    });
    expect((result as { status: VideoAssetStatus }).status).toBe(
      VideoAssetStatus.REJECTED,
    );
    // The removal re-ran; no second claim transition.
    expect(storage.deletePrefix).toHaveBeenCalledWith(`${TENANT}/uuid-1`);
    expect(repository.transitionStatus).not.toHaveBeenCalled();
    // The replay attempted the marker CAS and (first claimant) recorded
    // the completion entry inside that transaction.
    expect(repository.recordMediaRemovalCompleted).toHaveBeenCalledTimes(1);
    const completion = (
      (repository.recordMediaRemovalCompleted as jest.Mock).mock
        .calls[0][2] as () => { action: string; reason: string }
    )();
    expect(completion.action).toBe('DELETE');
    expect(completion.reason).toContain('media removal completed');
    expect(auditLog.record).not.toHaveBeenCalled();
  });

  it('REJECT replay over an already-recorded removal does not duplicate the completion audit', async () => {
    // Idempotent replay after a fully-successful rejection: the bytes are
    // gone AND the completion is already recorded. The replay still
    // attempts the marker CAS (the marker, not deletePrefix's report,
    // decides), loses it ('already-recorded'), and NOTHING is re-audited —
    // exactly-once completion evidence under any interleaving.
    const rejectedRow = () =>
      assetRow({
        status: VideoAssetStatus.REJECTED,
        errorCode: 'SCREENING_REJECTED',
        errorMessage:
          'Frame-content screening rejected this upload; media removal is ' +
          'pending (completion is recorded in the audit trail)',
      });
    const recordMediaRemovalCompleted = jest.fn(
      async () => 'already-recorded' as const,
    );
    const { service, storage, auditLog } = buildService({
      storage: { deletePrefix: jest.fn(async () => false) },
      repository: {
        findByIdInternal: jest.fn(async () => rejectedRow()),
        findById: jest.fn(async () => rejectedRow()),
        recordMediaRemovalCompleted,
      },
    });
    const result = await service.screen(TENANT, 'asset-1', {
      decision: VideoScreeningDecision.REJECT,
    });
    expect((result as { status: VideoAssetStatus }).status).toBe(
      VideoAssetStatus.REJECTED,
    );
    expect(storage.deletePrefix).toHaveBeenCalledTimes(1);
    // The repair attempt ran, the marker said already-recorded, and no
    // completion entry was written (the real repository writes the audit
    // only when its CAS claims the marker).
    expect(recordMediaRemovalCompleted).toHaveBeenCalledTimes(1);
    expect(auditLog.record).not.toHaveBeenCalled();
  });

  it('REJECT surfaces a completion-record failure; the replay REPAIRS it even though the bytes are already gone', async () => {
    // Finding K: deletePrefix removed the bytes, then the completion
    // record failed (transient DB outage). The claim is already durable,
    // so the error surfaces — and the replay must attempt the marker CAS
    // even though ITS deletePrefix reports nothing existed: under the old
    // deletePrefix-report trigger the completion audit would be skipped
    // forever, leaving the durable "removal pending" message unresolved.
    const rejectedRow = () =>
      assetRow({
        status: VideoAssetStatus.REJECTED,
        errorCode: 'SCREENING_REJECTED',
        errorMessage:
          'Frame-content screening rejected this upload; media removal is ' +
          'pending (completion is recorded in the audit trail)',
      });
    const recordMediaRemovalCompleted = jest
      .fn()
      .mockRejectedValueOnce(new Error('audit store unavailable'))
      .mockResolvedValueOnce('recorded' as const);
    const deletePrefix = jest
      .fn()
      .mockResolvedValueOnce(true) // initial attempt removes the bytes
      .mockResolvedValueOnce(false); // replay finds them already gone
    const { service } = buildService({
      storage: { deletePrefix },
      repository: {
        findByIdInternal: jest
          .fn()
          .mockResolvedValueOnce(quarantined()) // initial REJECT
          .mockResolvedValueOnce(rejectedRow()), // replay
        findById: jest.fn(async () => rejectedRow()),
        recordMediaRemovalCompleted,
      },
    });
    await expect(
      service.screen(TENANT, 'asset-1', {
        decision: VideoScreeningDecision.REJECT,
      }),
    ).rejects.toThrow('audit store unavailable');
    // Replay: bytes absent, completion still recorded via the marker.
    const result = await service.screen(TENANT, 'asset-1', {
      decision: VideoScreeningDecision.REJECT,
    });
    expect((result as { status: VideoAssetStatus }).status).toBe(
      VideoAssetStatus.REJECTED,
    );
    expect(deletePrefix).toHaveBeenCalledTimes(2);
    expect(recordMediaRemovalCompleted).toHaveBeenCalledTimes(2);
  });

  it('REJECT does NOT replay a REJECTED asset with a different error code', async () => {
    // A PROBE_FAILED rejection never claimed its media through screening —
    // replaying it would delete media outside the screening contract.
    const { service, storage } = buildService({
      repository: {
        findByIdInternal: jest.fn(async () =>
          assetRow({
            status: VideoAssetStatus.REJECTED,
            errorCode: 'PROBE_FAILED',
            errorMessage: 'The file could not be read as a video',
          }),
        ),
      },
    });
    await expect(
      service.screen(TENANT, 'asset-1', {
        decision: VideoScreeningDecision.REJECT,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(storage.deletePrefix).not.toHaveBeenCalled();
  });

  it.each([
    [VideoAssetStatus.PENDING_MEDIA],
    [VideoAssetStatus.UPLOADED],
    [VideoAssetStatus.VALIDATED],
    [VideoAssetStatus.READY],
    [VideoAssetStatus.REJECTED],
    [VideoAssetStatus.FAILED],
  ])('409s any decision on a non-QUARANTINED asset (%s)', async (status) => {
    const { service, storage, repository } = buildService({
      repository: {
        findByIdInternal: jest.fn(async () => assetRow({ status })),
      },
    });
    for (const decision of [
      VideoScreeningDecision.APPROVE,
      VideoScreeningDecision.REJECT,
    ]) {
      await expect(
        service.screen(TENANT, 'asset-1', { decision }),
      ).rejects.toBeInstanceOf(ConflictException);
    }
    expect(storage.deletePrefix).not.toHaveBeenCalled();
    expect(repository.transitionStatus).not.toHaveBeenCalled();
  });

  it('makes a concurrent APPROVE inside the staging window impossible: PENDING_MEDIA 409s with a truthful status', async () => {
    // Finding A regression pin: the row is visible between its commit and
    // the media write, but in the NON-SCREENABLE PENDING_MEDIA state — an
    // APPROVE arriving in that window is a controlled 409 (naming the real
    // status), never a release of an asset whose media may not exist.
    const { service, repository, storage } = buildService({
      repository: {
        findByIdInternal: jest.fn(async () =>
          assetRow({ status: VideoAssetStatus.PENDING_MEDIA }),
        ),
      },
    });
    const error: Error = await service
      .screen(TENANT, 'asset-1', { decision: VideoScreeningDecision.APPROVE })
      .then(() => {
        throw new Error('expected rejection');
      })
      .catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.message).toContain('PENDING_MEDIA');
    expect(error.message).toContain('only QUARANTINED assets');
    expect(repository.transitionStatus).not.toHaveBeenCalled();
    expect(storage.deletePrefix).not.toHaveBeenCalled();
  });

  it('404s an unknown asset', async () => {
    const { service } = buildService({
      repository: { findByIdInternal: jest.fn(async () => null) },
    });
    await expect(
      service.screen(TENANT, 'nope', {
        decision: VideoScreeningDecision.APPROVE,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects a note carrying credential- or payment-bearing content BEFORE any read', async () => {
    // The fused free-text predicate screens the note: key=value fragments
    // and PANs as before, PLUS credential labels fused with their value in
    // one token (cvv123, pin1234) — which the older value/PAN pair missed.
    // The rejection lands before any read or transition.
    const { service, repository } = buildService();
    for (const note of [
      ['4111', '1111', '1111', '1111'].join(' '),
      'password=hunter2',
      'cvv123',
      'pin1234',
    ]) {
      for (const decision of [
        VideoScreeningDecision.APPROVE,
        VideoScreeningDecision.REJECT,
      ]) {
        await expect(
          service.screen(TENANT, 'asset-1', { decision, note }),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
    }
    expect(repository.findByIdInternal).not.toHaveBeenCalled();
    expect(repository.transitionStatus).not.toHaveBeenCalled();
  });

  it('still accepts a benign screening note', async () => {
    const { service } = buildService({
      repository: {
        findByIdInternal: jest.fn(async () => inspectedQuarantined()),
      },
    });
    const result = await service.screen(TENANT, 'asset-1', {
      decision: VideoScreeningDecision.APPROVE,
      note: 'shelf and product zone only; no cards or terminals visible',
    });
    expect((result as { status: VideoAssetStatus }).status).toBe(
      VideoAssetStatus.UPLOADED,
    );
  });

  it('409s when the CAS loses to a concurrent decision', async () => {
    const { service } = buildService({
      repository: {
        // Evidence present — the 409 under test is the LOST CAS, not the
        // evidence gate.
        findByIdInternal: jest.fn(async () => inspectedQuarantined()),
        transitionStatus: jest.fn(async () => null),
      },
    });
    await expect(
      service.screen(TENANT, 'asset-1', {
        decision: VideoScreeningDecision.APPROVE,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('VideoAssetsService.screeningPreview', () => {
  const quarantined = () => assetRow({ status: VideoAssetStatus.QUARANTINED });

  it('serves evenly spaced in-memory frames for a QUARANTINED asset and persists NOTHING', async () => {
    const { service, storage, repository, extractor } = buildService({
      repository: { findByIdInternal: jest.fn(async () => quarantined()) },
    });
    const preview = await service.screeningPreview(TENANT, 'asset-1', {
      id: 'u1',
      email: 'screener@x.io',
    });
    // 10 s probe → the full cap, evenly spaced strictly inside the duration.
    expect(preview.frames).toHaveLength(SCREENING_PREVIEW_MAX_FRAMES);
    expect(preview.frames.map((frame) => frame.timestampMs)).toEqual([
      0, 1666, 3333, 5000, 6666, 8333,
    ]);
    expect(preview.skippedOverBudget).toBe(0);
    for (const frame of preview.frames) {
      // Base64 payload decodes back to the extractor's bytes.
      expect(Buffer.from(frame.imageBase64, 'base64').toString()).toBe('f');
      expect(frame.mimeType).toBe('image/png');
    }
    // The extractor was asked for exactly the sampled positions.
    expect(extractor.extractFrameAt).toHaveBeenCalledTimes(
      SCREENING_PREVIEW_MAX_FRAMES,
    );
    // FRAMES ARE NEVER PERSISTED: no storage writes, no artifact rows, and
    // no status transition — the screening decision stays open.
    expect(storage.put).not.toHaveBeenCalled();
    expect(repository.createArtifactsBatch).not.toHaveBeenCalled();
    expect(repository.transitionStatus).not.toHaveBeenCalled();
  });

  it('AUDITS every served preview (READ action, frame count in the reason) through the final guard', async () => {
    // The READ audit no longer rides a bare auditLog call: it is written
    // INSIDE the repository's guarded serve-authorization transaction, so
    // audit and authorization commit together under the asset's lock.
    let entry:
      | {
          action: string;
          entityType: string;
          entityId: string;
          actorEmail: string;
          reason: string;
        }
      | undefined;
    const authorizeScreeningPreviewServe = jest.fn(
      async (
        _t: string,
        _id: string,
        _inspection: { actorId: string | null; servedFrameCount: number },
        build: () => unknown,
      ) => {
        entry = build() as typeof entry;
        return VideoAssetStatus.QUARANTINED;
      },
    );
    const { service } = buildService({
      repository: {
        findByIdInternal: jest.fn(async () => quarantined()),
        authorizeScreeningPreviewServe,
      },
    });
    await service.screeningPreview(TENANT, 'asset-1', {
      id: 'u1',
      email: 'screener@x.io',
    });
    expect(authorizeScreeningPreviewServe).toHaveBeenCalledTimes(1);
    const [guardTenant, , inspection] = authorizeScreeningPreviewServe.mock
      .calls[0] as unknown as [
      string,
      string,
      { actorId: string | null; servedFrameCount: number },
    ];
    expect(guardTenant).toBe(TENANT);
    // The APPROVE-gate evidence rides the same guarded transaction: the
    // ACTUALLY-SERVED frame count and the inspecting actor.
    expect(inspection).toEqual({ actorId: 'u1', servedFrameCount: 6 });
    expect(entry?.action).toBe('READ');
    expect(entry?.entityType).toBe('VideoAsset');
    expect(entry?.entityId).toBe('asset-1');
    expect(entry?.actorEmail).toBe('screener@x.io');
    expect(entry?.reason).toContain('Screening preview served: 6 sample frame');
  });

  it('discards the frames and 409s WITHOUT a READ audit when a decision commits mid-extraction', async () => {
    // Finding B regression pin: the initial status check passed, frames
    // were extracted, and then a screening decision (here a rejection)
    // committed before the final guarded authorization. The guard — which
    // serializes with decisions on the asset's advisory lock — observes
    // the terminal status: the preview must throw the existing not-pending
    // 409, serve nothing, and write NO audit entry (the repository only
    // records the READ when it authorizes a QUARANTINED serve).
    const authorizeScreeningPreviewServe = jest.fn(
      async () => VideoAssetStatus.REJECTED,
    );
    const { service, extractor, auditLog } = buildService({
      repository: {
        findByIdInternal: jest.fn(async () => quarantined()),
        authorizeScreeningPreviewServe,
      },
    });
    const error: Error = await service
      .screeningPreview(TENANT, 'asset-1')
      .then(() => {
        throw new Error('expected rejection');
      })
      .catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.message).toContain('REJECTED');
    expect(error.message).toContain('screening preview is only available');
    // Extraction DID run (the race is mid-extraction), but nothing served
    // and nothing audited.
    expect(extractor.extractFrameAt).toHaveBeenCalled();
    expect(auditLog.record).not.toHaveBeenCalled();
  });

  it('404s when the asset is deleted between extraction and the final guard, with no audit', async () => {
    const { service, auditLog } = buildService({
      repository: {
        findByIdInternal: jest.fn(async () => quarantined()),
        authorizeScreeningPreviewServe: jest.fn(async () => null),
      },
    });
    await expect(
      service.screeningPreview(TENANT, 'asset-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(auditLog.record).not.toHaveBeenCalled();
  });

  it('409s a PENDING_MEDIA asset BEFORE any probe (media may not exist)', async () => {
    const { service, extractor } = buildService({
      repository: {
        findByIdInternal: jest.fn(async () =>
          assetRow({ status: VideoAssetStatus.PENDING_MEDIA }),
        ),
      },
    });
    const error: Error = await service
      .screeningPreview(TENANT, 'asset-1')
      .then(() => {
        throw new Error('expected rejection');
      })
      .catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.message).toContain('PENDING_MEDIA');
    expect(extractor.probe).not.toHaveBeenCalled();
  });

  it('serves a single frame for a very short clip', async () => {
    const { service, extractor } = buildService({
      repository: { findByIdInternal: jest.fn(async () => quarantined()) },
      extractor: {
        probe: jest.fn(async () => ({
          durationMs: 800,
          width: 640,
          height: 360,
          fps: 30,
        })),
      },
    });
    const preview = await service.screeningPreview(TENANT, 'asset-1');
    expect(preview.frames).toHaveLength(1);
    expect(preview.frames[0].timestampMs).toBe(0);
    expect(extractor.extractFrameAt).toHaveBeenCalledTimes(1);
  });

  it('previews EVERY started second (parity with the pre-storage screen): a 1.9 s clip serves two frames below 1900 ms', async () => {
    // Same Math.ceil fix as the pre-storage sampler — the preview
    // documents the identical one-frame-per-started-second policy, so a
    // 1.9 s clip must show the screener its second started second too,
    // with both timestamps strictly inside the duration.
    const { service, extractor } = buildService({
      repository: { findByIdInternal: jest.fn(async () => quarantined()) },
      extractor: {
        probe: jest.fn(async () => ({
          durationMs: 1900,
          width: 640,
          height: 360,
          fps: 30,
        })),
      },
    });
    const preview = await service.screeningPreview(TENANT, 'asset-1');
    expect(preview.frames.map((frame) => frame.timestampMs)).toEqual([0, 1000]);
    expect(
      preview.frames.every((frame) => frame.timestampMs < 1900),
    ).toBe(true);
    expect(extractor.extractFrameAt).toHaveBeenCalledTimes(2);
  });

  it('skips undecodable sample positions instead of failing the preview', async () => {
    // Container durations routinely overshoot the last decodable frame —
    // a missing sample is a gap in the strip, not an error.
    const { service } = buildService({
      repository: { findByIdInternal: jest.fn(async () => quarantined()) },
      extractor: {
        extractFrameAt: jest.fn(async (_k: string, _p: unknown, ts: number) => {
          if (ts > 5000) {
            throw new FrameUnavailableError();
          }
          return {
            data: Buffer.from('f'),
            width: 1280,
            height: 720,
            mimeType: 'image/png',
            timestampMs: ts,
          };
        }),
      },
    });
    const preview = await service.screeningPreview(TENANT, 'asset-1');
    expect(preview.frames.map((frame) => frame.timestampMs)).toEqual([
      0, 1666, 3333, 5000,
    ]);
  });

  it('503s (controlled) when the configured extractor does not read real bytes', async () => {
    // Informed-screening gate: the simulated extractor renders placeholder
    // pixels that ignore the stored media — serving them as a "preview"
    // would let a screener approve card-bearing footage without ever
    // seeing it. Refused BEFORE any probe, extraction, or audit; nothing
    // transitions, so the screening decision stays open (REJECT is still
    // available without a preview).
    const { service, extractor, repository, auditLog } = buildService({
      repository: { findByIdInternal: jest.fn(async () => quarantined()) },
      extractor: { readsRealBytes: false },
    });
    const error: Error = await service
      .screeningPreview(TENANT, 'asset-1')
      .then(() => {
        throw new Error('expected rejection');
      })
      .catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(error.message).toContain('byte-reading extractor');
    expect(error.message).toContain('VIDEO_FFMPEG_ENABLED');
    expect(extractor.probe).not.toHaveBeenCalled();
    expect(extractor.extractFrameAt).not.toHaveBeenCalled();
    expect(auditLog.record).not.toHaveBeenCalled();
    expect(repository.transitionStatus).not.toHaveBeenCalled();
    // Finding D corollary: the serve authorization — the ONLY writer of
    // APPROVE inspection evidence — is never reached, so a simulated
    // extractor can never mint the evidence an approval requires.
    expect(repository.authorizeScreeningPreviewServe).not.toHaveBeenCalled();
  });

  it('a preview that serves ZERO frames reports servedFrameCount 0 (the repository stamps no evidence)', async () => {
    // Every sample position undecodable: the preview still serves (an
    // empty strip, audited READ), but the inspection payload carries
    // frames=0 — and the repository only stamps evidence for frames > 0,
    // so a frameless preview can never enable an approval.
    const { service, repository } = buildService({
      repository: { findByIdInternal: jest.fn(async () => quarantined()) },
      extractor: {
        extractFrameAt: jest.fn(async () => {
          throw new FrameUnavailableError();
        }),
      },
    });
    const preview = await service.screeningPreview(TENANT, 'asset-1', {
      id: 'u1',
      email: 'screener@x.io',
    });
    expect(preview.frames).toHaveLength(0);
    const [, , inspection] = (
      repository.authorizeScreeningPreviewServe as jest.Mock
    ).mock.calls[0] as unknown as [
      string,
      string,
      { actorId: string | null; servedFrameCount: number },
    ];
    expect(inspection).toEqual({ actorId: 'u1', servedFrameCount: 0 });
  });

  it('bounds EVERY extractor call by the remaining preview budget (before the decode)', async () => {
    // The per-frame cap must be the SHRINKING remainder of the
    // preview-specific 16 MiB budget — not a constant, and never the far
    // larger extraction batch budget.
    const frameBytes = 1024 * 1024; // 1 MiB per served frame
    const { service, extractor } = buildService({
      repository: { findByIdInternal: jest.fn(async () => quarantined()) },
      extractor: {
        extractFrameAt: jest.fn(async (_k: string, _p: unknown, ts: number) => ({
          data: Buffer.alloc(frameBytes),
          width: 1280,
          height: 720,
          mimeType: 'image/png',
          timestampMs: ts,
        })),
      },
    });
    await service.screeningPreview(TENANT, 'asset-1');
    const caps = (
      (extractor.extractFrameAt as jest.Mock).mock.calls as unknown as [
        string,
        unknown,
        number,
        { maxBytes: number },
      ][]
    ).map((call) => call[3].maxBytes);
    expect(caps).toEqual(
      Array.from(
        { length: SCREENING_PREVIEW_MAX_FRAMES },
        (_, index) => SCREENING_PREVIEW_TOTAL_BYTES - index * frameBytes,
      ),
    );
  });

  it('skips a budget-refused frame (FrameExceedsBudgetError) and reports it — never a 503', async () => {
    // An adapter that enforces the caller cap refuses the oversized frame
    // itself; the service treats that as the SAME bounded skip as its own
    // backstop and keeps serving the remaining frames.
    const { service, repository } = buildService({
      repository: { findByIdInternal: jest.fn(async () => quarantined()) },
      extractor: {
        extractFrameAt: jest.fn(async (_k: string, _p: unknown, ts: number) => {
          if (ts === 0) {
            throw new FrameExceedsBudgetError();
          }
          return {
            data: Buffer.from('f'),
            width: 1280,
            height: 720,
            mimeType: 'image/png',
            timestampMs: ts,
          };
        }),
      },
    });
    const preview = await service.screeningPreview(TENANT, 'asset-1');
    expect(preview.skippedOverBudget).toBe(1);
    expect(preview.frames).toHaveLength(SCREENING_PREVIEW_MAX_FRAMES - 1);
    expect(
      preview.frames.some((frame) => frame.timestampMs === 0),
    ).toBe(false);
    // Still a served (and audited) preview — a skip is not a failure. The
    // audit rides the final guarded serve authorization.
    expect(repository.authorizeScreeningPreviewServe).toHaveBeenCalledTimes(1);
  });

  it('skips frames that would exceed the 16 MiB preview budget and reports the skip', async () => {
    // Backstop for extractors that ignore the per-call cap: a frame just
    // over the PREVIEW-SPECIFIC budget (far below the extraction batch
    // budget) is dropped and COUNTED, never partially returned.
    const huge = { length: SCREENING_PREVIEW_TOTAL_BYTES + 1 } as Buffer;
    const { service } = buildService({
      repository: { findByIdInternal: jest.fn(async () => quarantined()) },
      extractor: {
        extractFrameAt: jest.fn(async (_k: string, _p: unknown, ts: number) => ({
          data: ts === 0 ? huge : Buffer.from('f'),
          width: 1280,
          height: 720,
          mimeType: 'image/png',
          timestampMs: ts,
        })),
      },
    });
    const preview = await service.screeningPreview(TENANT, 'asset-1');
    expect(preview.skippedOverBudget).toBe(1);
    expect(preview.frames).toHaveLength(SCREENING_PREVIEW_MAX_FRAMES - 1);
    expect(
      preview.frames.some((frame) => frame.timestampMs === 0),
    ).toBe(false);
  });

  it('stops sampling once the remainder cannot hold any frame and reports the rest as skipped', async () => {
    // The first frame consumes almost the whole preview budget, leaving a
    // remainder below the minimum decodable frame size — the loop must
    // STOP (no doomed extractor calls) and count the unserved positions.
    const nearBudget =
      SCREENING_PREVIEW_TOTAL_BYTES - SCREENING_PREVIEW_MIN_FRAME_BYTES + 1;
    const { service, extractor } = buildService({
      repository: { findByIdInternal: jest.fn(async () => quarantined()) },
      extractor: {
        extractFrameAt: jest.fn(async (_k: string, _p: unknown, ts: number) => ({
          data: { length: nearBudget, toString: () => '' } as unknown as Buffer,
          width: 1280,
          height: 720,
          mimeType: 'image/png',
          timestampMs: ts,
        })),
      },
    });
    const preview = await service.screeningPreview(TENANT, 'asset-1');
    expect(preview.frames).toHaveLength(1);
    expect(preview.skippedOverBudget).toBe(SCREENING_PREVIEW_MAX_FRAMES - 1);
    // Exactly ONE extraction — the loop stopped instead of decoding more.
    expect(extractor.extractFrameAt).toHaveBeenCalledTimes(1);
  });

  it.each([
    [VideoAssetStatus.UPLOADED],
    [VideoAssetStatus.VALIDATED],
    [VideoAssetStatus.READY],
    [VideoAssetStatus.REJECTED],
    [VideoAssetStatus.FAILED],
  ])('409s a preview of a non-QUARANTINED asset (%s)', async (status) => {
    // Screening decisions are only pending while QUARANTINED — outside
    // that window the preview would be a general-purpose frame download.
    const { service, extractor } = buildService({
      repository: {
        findByIdInternal: jest.fn(async () => assetRow({ status })),
      },
    });
    await expect(
      service.screeningPreview(TENANT, 'asset-1'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(extractor.probe).not.toHaveBeenCalled();
    expect(extractor.extractFrameAt).not.toHaveBeenCalled();
  });

  it('404s an unknown asset and REDACTS a payment-bearing route id', async () => {
    const pan = '4111111111111111';
    const { service } = buildService({
      repository: { findByIdInternal: jest.fn(async () => null) },
    });
    const error: Error = await service
      .screeningPreview(TENANT, pan)
      .then(() => {
        throw new Error('expected rejection');
      })
      .catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(NotFoundException);
    expect(error.message).toContain('[REDACTED]');
    expect(error.message).not.toContain(pan);
  });

  it('maps extractor-unavailable and infrastructure failures to 503 with no transition', async () => {
    for (const failure of [
      new ExtractorUnavailableError(),
      new ExtractionInfrastructureError(),
    ]) {
      const { service, repository, auditLog } = buildService({
        repository: { findByIdInternal: jest.fn(async () => quarantined()) },
        extractor: {
          probe: jest.fn(async () => {
            throw failure;
          }),
        },
      });
      await expect(
        service.screeningPreview(TENANT, 'asset-1'),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(repository.transitionStatus).not.toHaveBeenCalled();
      expect(auditLog.record).not.toHaveBeenCalled();
    }
  });

  it('maps unreadable content to a controlled 400 WITHOUT any status transition', async () => {
    // A preview failure must never auto-reject: the screening decision
    // remains open (this also covers the DB-first crash window — a
    // QUARANTINED row whose media never landed previews as a 400).
    const { service, repository } = buildService({
      repository: { findByIdInternal: jest.fn(async () => quarantined()) },
      extractor: {
        probe: jest.fn(async () => {
          throw new ExtractionFailedError();
        }),
      },
    });
    await expect(
      service.screeningPreview(TENANT, 'asset-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repository.transitionStatus).not.toHaveBeenCalled();
  });
});

describe('VideoAssetsService crop & frame extraction', () => {
  it('rejects a timestamp outside the probed duration', async () => {
    const { service } = buildService();
    await expect(
      service.createCrop(TENANT, 'asset-1', {
        timestampMs: 10_001,
        x: 0,
        y: 0,
        width: 10,
        height: 10,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a crop box that exceeds the probed dimensions', async () => {
    const { service } = buildService();
    await expect(
      service.createCrop(TENANT, 'asset-1', {
        timestampMs: 1000,
        x: 1200,
        y: 0,
        width: 100, // 1200 + 100 > 1280
        height: 100,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('maps an unavailable frame to a 400 WITHOUT failing the asset', async () => {
    // A timestamp inside the reported duration can land past the last
    // decodable frame — that is a caller-input problem, not a broken video.
    const { service, repository } = buildService({
      extractor: {
        extractFrameAt: jest.fn(async () => {
          throw new FrameUnavailableError();
        }),
      },
    });
    await expect(
      service.extractFrames(TENANT, 'asset-1', { timestampMs: 9_999 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    // No FAILED transition was recorded.
    expect(repository.transitionStatus).not.toHaveBeenCalled();
  });

  it('maps an infrastructure failure during extraction to 503 WITHOUT failing the asset', async () => {
    // Tooling killed/refused mid-extraction is transient, not a property
    // of the video — no FAILED transition, no audit, a controlled 503.
    const { service, repository } = buildService({
      extractor: {
        extractFrameAt: jest.fn(async () => {
          throw new ExtractionInfrastructureError();
        }),
      },
    });
    await expect(
      service.extractFrames(TENANT, 'asset-1', { timestampMs: 500 }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(repository.transitionStatus).not.toHaveBeenCalled();
  });

  it('requires validation before extraction', async () => {
    const { service } = buildService({
      repository: {
        findByIdInternal: jest.fn(async () =>
          assetRow({ status: VideoAssetStatus.UPLOADED }),
        ),
      },
    });
    await expect(
      service.extractFrames(TENANT, 'asset-1', {}),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('409s frame extraction AND crops on a QUARANTINED asset', async () => {
    // Quarantine must hold at EVERY processing entry point — an unscreened
    // clip's bytes never become artifacts (the ONLY decode path while
    // QUARANTINED is the audited, in-memory screening preview).
    const { service, extractor, storage } = buildService({
      repository: {
        findByIdInternal: jest.fn(async () =>
          assetRow({ status: VideoAssetStatus.QUARANTINED }),
        ),
      },
    });
    await expect(
      service.extractFrames(TENANT, 'asset-1', {}),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      service.createCrop(TENANT, 'asset-1', {
        timestampMs: 1000,
        x: 0,
        y: 0,
        width: 10,
        height: 10,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(extractor.extractFrames).not.toHaveBeenCalled();
    expect(extractor.extractFrameAt).not.toHaveBeenCalled();
    expect(extractor.extractCrop).not.toHaveBeenCalled();
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('409s frame extraction AND crops on a PENDING_MEDIA asset with a truthful message', async () => {
    // The staging state is not processable either — and the message must
    // not claim "validate it first" (a PENDING_MEDIA asset cannot be
    // validated: its media write never completed).
    const { service, extractor, storage } = buildService({
      repository: {
        findByIdInternal: jest.fn(async () =>
          assetRow({ status: VideoAssetStatus.PENDING_MEDIA }),
        ),
      },
    });
    for (const attempt of [
      () => service.extractFrames(TENANT, 'asset-1', {}),
      () =>
        service.createCrop(TENANT, 'asset-1', {
          timestampMs: 1000,
          x: 0,
          y: 0,
          width: 10,
          height: 10,
        }),
    ]) {
      const error: Error = await attempt()
        .then(() => {
          throw new Error('expected rejection');
        })
        .catch((caught: Error) => caught);
      expect(error).toBeInstanceOf(ConflictException);
      expect(error.message).toContain('PENDING_MEDIA');
      expect(error.message).toContain('media write never completed');
    }
    expect(extractor.extractFrames).not.toHaveBeenCalled();
    expect(extractor.extractFrameAt).not.toHaveBeenCalled();
    expect(extractor.extractCrop).not.toHaveBeenCalled();
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('persists a CROP artifact with checksum, geometry, and reason', async () => {
    const { service, repository, storage } = buildService();
    const { artifact } = await service.createCrop(TENANT, 'asset-1', {
      timestampMs: 1000,
      x: 10,
      y: 20,
      width: 300,
      height: 200,
      reason: VideoCropReason.PRODUCT_PICKUP,
    });
    expect(artifact.artifactType).toBe(VideoArtifactType.CROP);
    const [, , , , items] = repository.createArtifactsBatch.mock
      .calls[0] as unknown as [
      string,
      string,
      VideoAssetStatus[],
      string | undefined,
      {
        cropX: number;
        cropWidth: number;
        checksumSha256: string;
        storageKey: string;
        reason: VideoCropReason;
      }[],
    ];
    expect(items[0].cropX).toBe(10);
    expect(items[0].cropWidth).toBe(300);
    expect(items[0].reason).toBe(VideoCropReason.PRODUCT_PICKUP);
    expect(items[0].checksumSha256).toMatch(/^[0-9a-f]{64}$/);
    // DETERMINISTIC staging key: under the ASSET's prefix, an operation
    // directory derived from the request identity (sha256 hex), then the
    // artifact index — never a random UUID (crash-recoverable staging).
    expect(items[0].storageKey).toMatch(
      new RegExp(`^${TENANT}/uuid-1/artifacts/[0-9a-f]{64}/0\\.png$`),
    );
    expect(storage.put).toHaveBeenCalled();
  });

  it('publishes frames atomically and marks the asset READY in the same batch', async () => {
    const { service, repository } = buildService();
    const { asset, artifacts } = await service.extractFrames(TENANT, 'asset-1', {});
    expect(artifacts).toHaveLength(1);
    expect(asset.status).toBe(VideoAssetStatus.READY);
    // ONE atomic publish call carries the rows AND the status flip.
    expect(repository.createArtifactsBatch).toHaveBeenCalledTimes(1);
  });

  it('rejects a timestamp AT the duration (exclusive endpoint)', async () => {
    const { service } = buildService();
    await expect(
      service.createCrop(TENANT, 'asset-1', {
        timestampMs: 10_000, // == durationMs — no frame exists there
        x: 0,
        y: 0,
        width: 10,
        height: 10,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('removes staged files when the atomic publish fails (nothing committed)', async () => {
    const { service, storage } = buildService({
      repository: {
        createArtifactsBatch: jest.fn(async () => {
          throw new Error('db down');
        }),
      },
    });
    await expect(
      service.createCrop(TENANT, 'asset-1', {
        timestampMs: 1000,
        x: 0,
        y: 0,
        width: 10,
        height: 10,
      }),
    ).rejects.toThrow('db down');
    // The staged artifact file was cleaned up — no orphaned media.
    expect(storage.delete).toHaveBeenCalledTimes(1);
  });

  it('rejects a batch whose decoded bytes exceed the per-request budget', async () => {
    const { service, storage } = buildService({
      extractor: {
        extractCrop: jest.fn(async () => ({
          // Length-only stand-in: the budget check runs BEFORE staging.
          data: { length: 200 * 1024 * 1024 } as Buffer,
          width: 10,
          height: 10,
          mimeType: 'image/png',
          timestampMs: 1000,
        })),
      },
    });
    await expect(
      service.createCrop(TENANT, 'asset-1', {
        timestampMs: 1000,
        x: 0,
        y: 0,
        width: 10,
        height: 10,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(storage.put).not.toHaveBeenCalled();
  });
});

describe('extraction idempotency', () => {
  it('replays a committed request WITHOUT re-running extraction', async () => {
    const replayResult = {
      asset: assetRow({ status: VideoAssetStatus.READY }),
      artifacts: [artifactRow()],
      replayed: true as const,
      requestFingerprint: cropFingerprint({
        timestampMs: 1000,
        x: 10,
        y: 20,
        width: 300,
        height: 200,
      }),
    };
    const { service, extractor, storage, repository } = buildService({
      repository: {
        findExtractionReplay: jest.fn(async () => replayResult),
      },
    });
    const result = await service.createCrop(TENANT, 'asset-1', {
      timestampMs: 1000,
      x: 10,
      y: 20,
      width: 300,
      height: 200,
      idempotencyKey: 'op-1',
    });
    expect(result.replayed).toBe(true);
    expect(extractor.extractCrop).not.toHaveBeenCalled();
    expect(storage.put).not.toHaveBeenCalled();
    expect(repository.createArtifactsBatch).not.toHaveBeenCalled();
  });

  it('409s a key whose committed batch is a DIFFERENT operation type', async () => {
    // A frames-batch key replayed through POST /crops must not hand back an
    // arbitrary FRAME artifact as "the crop".
    const framesReplay = {
      asset: assetRow({ status: VideoAssetStatus.READY }),
      artifacts: [
        artifactRow({ artifactType: VideoArtifactType.FRAME, cropX: null }),
        artifactRow({ id: 'artifact-2', artifactType: VideoArtifactType.FRAME, cropX: null }),
      ],
      replayed: true as const,
    };
    const { service } = buildService({
      repository: { findExtractionReplay: jest.fn(async () => framesReplay) },
    });
    await expect(
      service.createCrop(TENANT, 'asset-1', {
        timestampMs: 1000,
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        idempotencyKey: 'frames-op-key',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    // And the reverse: a crop key replayed through extract-frames.
    const cropReplay = {
      asset: assetRow({ status: VideoAssetStatus.READY }),
      artifacts: [artifactRow()],
      replayed: true as const,
    };
    const { service: service2 } = buildService({
      repository: { findExtractionReplay: jest.fn(async () => cropReplay) },
    });
    await expect(
      service2.extractFrames(TENANT, 'asset-1', { idempotencyKey: 'crop-op-key' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('409s a key already used for a different asset', async () => {
    const { service } = buildService({
      repository: {
        findExtractionReplay: jest.fn(async () => 'key-conflict' as const),
      },
    });
    await expect(
      service.extractFrames(TENANT, 'asset-1', { idempotencyKey: 'op-1' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('replays the winner when two firsts race the same key (P2002)', async () => {
    const replayResult = {
      asset: assetRow({ status: VideoAssetStatus.READY }),
      artifacts: [artifactRow()],
      replayed: true as const,
      requestFingerprint: cropFingerprint({
        timestampMs: 1000,
        x: 0,
        y: 0,
        width: 10,
        height: 10,
      }),
    };
    const findExtractionReplay = jest
      .fn()
      .mockResolvedValueOnce(null) // pre-check: nothing committed yet
      .mockResolvedValueOnce(replayResult); // after P2002: the winner's batch
    const { service, storage } = buildService({
      repository: {
        findExtractionReplay,
        createArtifactsBatch: jest.fn(async () => {
          throw Object.assign(new Error('unique'), { code: 'P2002' });
        }),
      },
    });
    const result = await service.createCrop(TENANT, 'asset-1', {
      timestampMs: 1000,
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      idempotencyKey: 'op-1',
    });
    expect(result.replayed).toBe(true);
    // The loser's staged file was cleaned up.
    expect(storage.delete).toHaveBeenCalledTimes(1);
  });

  it('rejects idempotency keys carrying sensitive content, including grouped PANs', async () => {
    // The key is PERSISTED verbatim in VideoExtractionRequest, so both the
    // shared payment predicate AND the grouping-aware PAN detector screen
    // it: "4111_1111_1111_1111" (any single separator) must 400 before the
    // key is read or written anywhere.
    const { service, repository } = buildService();
    const panParts = ['4111', '1111', '1111', '1111'];
    for (const idempotencyKey of [
      `pan-${panParts.join(' ')}`,
      panParts.join('_'), // grouped PAN the shared predicate cannot see
      `key.${panParts.join('.')}`,
    ]) {
      await expect(
        service.extractFrames(TENANT, 'asset-1', { idempotencyKey }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.createCrop(TENANT, 'asset-1', {
          timestampMs: 1000,
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          idempotencyKey,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    // The key never reached the persistence layer on any path.
    expect(repository.findExtractionReplay).not.toHaveBeenCalled();
    expect(repository.createArtifactsBatch).not.toHaveBeenCalled();
  });

  it('409s a same-key crop retry whose timestamp, box, or reason changed', async () => {
    // The recorded batch answers the ORIGINAL request only: a reused key
    // with any changed parameter must conflict, never silently hand back
    // the old artifact as if it answered the new request.
    const original = {
      timestampMs: 1000,
      x: 10,
      y: 20,
      width: 300,
      height: 200,
    };
    const changed = [
      { ...original, timestampMs: 2000 }, // changed timestamp
      { ...original, x: 11 }, // changed box
      { ...original, reason: VideoCropReason.SHELF_AUDIT }, // changed reason
    ];
    for (const dto of changed) {
      const { service, extractor, storage, repository } = buildService({
        repository: {
          findExtractionReplay: jest.fn(async () => ({
            asset: assetRow({ status: VideoAssetStatus.READY }),
            artifacts: [artifactRow()],
            replayed: true as const,
            requestFingerprint: cropFingerprint(original),
          })),
        },
      });
      await expect(
        service.createCrop(TENANT, 'asset-1', { ...dto, idempotencyKey: 'op-1' }),
      ).rejects.toBeInstanceOf(ConflictException);
      // Nothing was extracted, staged, committed, or linked.
      expect(extractor.extractCrop).not.toHaveBeenCalled();
      expect(storage.put).not.toHaveBeenCalled();
      expect(repository.createArtifactsBatch).not.toHaveBeenCalled();
    }
  });

  it('409s a same-key frames retry whose timestamp, interval, or limit changed', async () => {
    const framesReplay = () => ({
      asset: assetRow({ status: VideoAssetStatus.READY }),
      artifacts: [
        artifactRow({ artifactType: VideoArtifactType.FRAME, cropX: null }),
      ],
      replayed: true as const,
      // Original request: interval sampling with the defaults.
      requestFingerprint: framesFingerprint(),
    });
    for (const dto of [
      { intervalMs: 2000 }, // changed interval
      { maxFrames: 10 }, // changed limit
      { timestampMs: 0 }, // sampling → single-frame mode change
    ]) {
      const { service, extractor, storage, repository } = buildService({
        repository: { findExtractionReplay: jest.fn(async () => framesReplay()) },
      });
      await expect(
        service.extractFrames(TENANT, 'asset-1', {
          ...dto,
          idempotencyKey: 'op-1',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(extractor.extractFrames).not.toHaveBeenCalled();
      expect(extractor.extractFrameAt).not.toHaveBeenCalled();
      expect(storage.put).not.toHaveBeenCalled();
      expect(repository.createArtifactsBatch).not.toHaveBeenCalled();
    }
  });

  it('replays a same-key frames retry whose parameters are IDENTICAL (defaults applied)', async () => {
    // Canonical means normalized: an omitted interval/limit and the same
    // values written out explicitly are the SAME request.
    const framesReplay = {
      asset: assetRow({ status: VideoAssetStatus.READY }),
      artifacts: [
        artifactRow({ artifactType: VideoArtifactType.FRAME, cropX: null }),
      ],
      replayed: true as const,
      requestFingerprint: framesFingerprint(),
    };
    const { service, extractor } = buildService({
      repository: { findExtractionReplay: jest.fn(async () => framesReplay) },
    });
    const implicit = await service.extractFrames(TENANT, 'asset-1', {
      idempotencyKey: 'op-1',
    });
    expect(implicit.replayed).toBe(true);
    const explicit = await service.extractFrames(TENANT, 'asset-1', {
      intervalMs: 1000,
      maxFrames: 5,
      idempotencyKey: 'op-1',
    });
    expect(explicit.replayed).toBe(true);
    expect(extractor.extractFrames).not.toHaveBeenCalled();
  });

  it('409s a single-frame same-key retry whose SUPPLIED interval or limit changed', async () => {
    // Single-frame extraction ignores interval/limit, but a supplied value
    // is still part of the request identity: a same-key retry changing a
    // supplied-but-ignored field must 409, never replay the old batch as
    // if it answered the new request.
    const singleFrameReplay = () => ({
      asset: assetRow({ status: VideoAssetStatus.READY }),
      artifacts: [
        artifactRow({ artifactType: VideoArtifactType.FRAME, cropX: null }),
      ],
      replayed: true as const,
      // Original request: timestampMs WITH both supplementary fields
      // supplied (and ignored by extraction).
      requestFingerprint: framesFingerprint({
        timestampMs: 0,
        intervalMs: 1000,
        maxFrames: 5,
      }),
    });
    for (const dto of [
      { timestampMs: 0, intervalMs: 2000, maxFrames: 5 }, // changed interval
      { timestampMs: 0, intervalMs: 1000, maxFrames: 10 }, // changed limit
      { timestampMs: 0 }, // previously-supplied fields now absent
    ]) {
      const { service, extractor, storage, repository } = buildService({
        repository: {
          findExtractionReplay: jest.fn(async () => singleFrameReplay()),
        },
      });
      await expect(
        service.extractFrames(TENANT, 'asset-1', {
          ...dto,
          idempotencyKey: 'op-1',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(extractor.extractFrameAt).not.toHaveBeenCalled();
      expect(storage.put).not.toHaveBeenCalled();
      expect(repository.createArtifactsBatch).not.toHaveBeenCalled();
    }
  });

  it('replays an IDENTICAL single-frame retry including supplied-but-ignored fields', async () => {
    const singleFrameReplay = {
      asset: assetRow({ status: VideoAssetStatus.READY }),
      artifacts: [
        artifactRow({ artifactType: VideoArtifactType.FRAME, cropX: null }),
      ],
      replayed: true as const,
      requestFingerprint: framesFingerprint({
        timestampMs: 0,
        intervalMs: 1000,
        maxFrames: 5,
      }),
    };
    const { service, extractor } = buildService({
      repository: {
        findExtractionReplay: jest.fn(async () => singleFrameReplay),
      },
    });
    const result = await service.extractFrames(TENANT, 'asset-1', {
      timestampMs: 0,
      intervalMs: 1000,
      maxFrames: 5,
      idempotencyKey: 'op-1',
    });
    expect(result.replayed).toBe(true);
    expect(extractor.extractFrameAt).not.toHaveBeenCalled();
  });

  it('fails CLOSED on a recorded batch with no fingerprint (pre-column row)', async () => {
    // A legacy request row cannot prove the retried request is identical —
    // it is rejected like a changed request, never replayed unverifiably.
    const { service } = buildService({
      repository: {
        findExtractionReplay: jest.fn(async () => ({
          asset: assetRow({ status: VideoAssetStatus.READY }),
          artifacts: [artifactRow()],
          replayed: true as const,
          requestFingerprint: null,
        })),
      },
    });
    await expect(
      service.createCrop(TENANT, 'asset-1', {
        timestampMs: 1000,
        x: 10,
        y: 20,
        width: 300,
        height: 200,
        idempotencyKey: 'legacy-op',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('verifies parameters on the IN-TRANSACTION replay path too', async () => {
    // A concurrent batch that committed first inside the tx window replays
    // through createArtifactsBatch itself — the same identical-request
    // guard applies, and the loser's staged file is still cleaned up.
    const { service, storage } = buildService({
      repository: {
        createArtifactsBatch: jest.fn(async () => ({
          asset: assetRow({ status: VideoAssetStatus.READY }),
          artifacts: [
            artifactRow({ artifactType: VideoArtifactType.FRAME, cropX: null }),
          ],
          replayed: true,
          requestFingerprint: framesFingerprint({ intervalMs: 2000 }),
        })),
      },
    });
    await expect(
      service.extractFrames(TENANT, 'asset-1', { idempotencyKey: 'op-1' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(storage.delete).toHaveBeenCalledTimes(1);
  });

  it('passes the canonical fingerprint to the atomic publish', async () => {
    const { service, repository } = buildService();
    await service.createCrop(TENANT, 'asset-1', {
      timestampMs: 1000,
      x: 10,
      y: 20,
      width: 300,
      height: 200,
      reason: VideoCropReason.PRODUCT_PICKUP,
      idempotencyKey: 'op-1',
    });
    const call = repository.createArtifactsBatch.mock.calls[0] as unknown[];
    expect(call[3]).toBe('op-1');
    expect(call[7]).toBe(
      cropFingerprint({
        timestampMs: 1000,
        x: 10,
        y: 20,
        width: 300,
        height: 200,
        reason: VideoCropReason.PRODUCT_PICKUP,
      }),
    );
  });
});

describe('staged-artifact cleanup escalation', () => {
  const cropDto = { timestampMs: 1000, x: 0, y: 0, width: 10, height: 10 };

  it('retries a transient staged-file cleanup failure and still surfaces the ORIGINAL error', async () => {
    // Publish failed, first delete throws, the retry succeeds: the caller
    // sees the original failure — the cleanup hiccup was transient and is
    // NOT escalated.
    const del = jest
      .fn()
      .mockRejectedValueOnce(new Error('EBUSY'))
      .mockResolvedValueOnce(undefined);
    const { service } = buildService({
      storage: { delete: del },
      repository: {
        createArtifactsBatch: jest.fn(async () => {
          throw new Error('db down');
        }),
      },
    });
    await expect(service.createCrop(TENANT, 'asset-1', cropDto)).rejects.toThrow(
      'db down',
    );
    expect(del).toHaveBeenCalledTimes(2);
  });

  it('escalates a PERSISTENT staged-file cleanup failure as 503 (bounded attempts)', async () => {
    // Publish failed AND both delete attempts failed: no row references
    // the staged key, so silently reporting only the original error would
    // strand orphaned media. The controlled 503 names the condition.
    const del = jest.fn(async () => {
      throw new Error('EACCES');
    });
    const { service } = buildService({
      storage: { delete: del },
      repository: {
        createArtifactsBatch: jest.fn(async () => {
          throw new Error('db down');
        }),
      },
    });
    await expect(
      service.createCrop(TENANT, 'asset-1', cropDto),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    // One retry, then escalation — never an unbounded loop.
    expect(del).toHaveBeenCalledTimes(2);
  });
});

describe('deterministic artifact staging keys (crash-recoverable staging)', () => {
  // Codex P2: staging files under random UUID keys BEFORE the batch
  // transaction meant a crash between put and commit orphaned files that
  // no row referenced and no retry could ever find (a retry staged NEW
  // UUIDs). Keys are now DETERMINISTIC from the request identity —
  // idempotency key when supplied, else the canonical fingerprint — plus
  // the artifact index, so an identical retry re-puts over the SAME keys
  // (the adapter's temp+rename put overwrites atomically) and committed
  // rows record the deterministic keys directly (no promotion step).
  const cropDto = { timestampMs: 1000, x: 0, y: 0, width: 10, height: 10 };
  const keyShape = new RegExp(
    `^${TENANT}/uuid-1/artifacts/[0-9a-f]{64}/0\\.png$`,
  );

  it('a retried identical request stages over the SAME keys after a simulated crash (put succeeded, batch never committed)', async () => {
    const createArtifactsBatch = jest
      .fn()
      .mockRejectedValueOnce(new Error('db crash'))
      .mockResolvedValueOnce({
        asset: assetRow({ status: VideoAssetStatus.READY }),
        artifacts: [artifactRow()],
        replayed: false,
      });
    const { service, storage } = buildService({
      repository: { createArtifactsBatch },
    });
    const dto = { ...cropDto, idempotencyKey: 'op-1' };
    await expect(service.createCrop(TENANT, 'asset-1', dto)).rejects.toThrow(
      'db crash',
    );
    await service.createCrop(TENANT, 'asset-1', dto);
    expect(storage.put).toHaveBeenCalledTimes(2);
    const [firstKey] = storage.put.mock.calls[0] as unknown as [string];
    const [retryKey] = storage.put.mock.calls[1] as unknown as [string];
    // IDENTICAL keys across attempts — the crash window self-heals by
    // overwrite instead of orphaning a fresh UUID per attempt — and the
    // key shape is the deterministic asset-prefixed operation directory.
    expect(retryKey).toBe(firstKey);
    expect(firstKey).toMatch(keyShape);
  });

  it('derives DIFFERENT operation prefixes for different request identities', async () => {
    const { service, storage } = buildService();
    await service.createCrop(TENANT, 'asset-1', {
      ...cropDto,
      idempotencyKey: 'op-1',
    });
    await service.createCrop(TENANT, 'asset-1', {
      ...cropDto,
      idempotencyKey: 'op-2',
    });
    const [keyA] = storage.put.mock.calls[0] as unknown as [string];
    const [keyB] = storage.put.mock.calls[1] as unknown as [string];
    expect(keyA).toMatch(keyShape);
    expect(keyB).toMatch(keyShape);
    expect(keyA).not.toBe(keyB);
  });

  it('cleanup after a failed publish KEEPS staged keys that a committed batch recorded (shared deterministic keys)', async () => {
    // A keyless identical retry (or a same-key race loser) stages over
    // the very keys the earlier committed batch recorded — deleting them
    // in the failure path would destroy media that live artifact rows
    // reference. The cleanup consults the committed rows and skips them.
    const { service, storage } = buildService({
      repository: {
        createArtifactsBatch: jest.fn(async () => {
          throw new Error('db down');
        }),
        listArtifactStorageKeys: jest.fn(
          async (_t: string, keys: string[]) => keys,
        ),
      },
    });
    await expect(service.createCrop(TENANT, 'asset-1', cropDto)).rejects.toThrow(
      'db down',
    );
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('an in-transaction replay of the IDENTICAL request keeps its staged files — they ARE the recorded batch', async () => {
    const { service, storage } = buildService({
      repository: {
        createArtifactsBatch: jest.fn(async () => ({
          asset: assetRow({ status: VideoAssetStatus.READY }),
          artifacts: [artifactRow()],
          replayed: true,
          requestFingerprint: cropFingerprint(cropDto),
        })),
        listArtifactStorageKeys: jest.fn(
          async (_t: string, keys: string[]) => keys,
        ),
      },
    });
    const result = await service.createCrop(TENANT, 'asset-1', {
      ...cropDto,
      idempotencyKey: 'op-1',
    });
    expect(result.replayed).toBe(true);
    // The staged puts overwrote the recorded keys with identical content;
    // deleting the "surplus" would delete the batch itself.
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('fails CLOSED when staged-key ownership cannot be verified: 503, nothing deleted', async () => {
    // Deleting blindly could destroy committed media; keeping the staged
    // files is always recoverable (an identical retry overwrites them,
    // asset deletion removes the whole prefix).
    const { service, storage } = buildService({
      repository: {
        createArtifactsBatch: jest.fn(async () => {
          throw new Error('db down');
        }),
        listArtifactStorageKeys: jest.fn(async () => {
          throw new Error('db down');
        }),
      },
    });
    await expect(
      service.createCrop(TENANT, 'asset-1', cropDto),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('a changed-parameters same-key retry 409s BEFORE any staging write (crashed-attempt leftovers stay discoverable)', async () => {
    // The fingerprint guard rejects the divergent retry before extraction
    // or staging — staged files from a crashed attempt remain under their
    // deterministic prefix (reconcilable by key shape; removed with the
    // asset), and no new writes happen.
    const { service, storage } = buildService({
      repository: {
        findExtractionReplay: jest.fn(async () => ({
          asset: assetRow({ status: VideoAssetStatus.READY }),
          artifacts: [artifactRow()],
          replayed: true,
          requestFingerprint: cropFingerprint({ ...cropDto, timestampMs: 999 }),
        })),
      },
    });
    await expect(
      service.createCrop(TENANT, 'asset-1', {
        ...cropDto,
        idempotencyKey: 'op-1',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(storage.put).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
  });
});

describe('plain-id validation on reads', () => {
  it('rejects control characters in route ids and list filters with 400', async () => {
    const { service, repository } = buildService();
    await expect(service.findById(TENANT, 'a\u0000b')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      service.findArtifactById(TENANT, 'a\u0000b'),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.delete(TENANT, 'a\u0000b')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      service.createInferenceJobFromCrop(TENANT, 'a\u0000b', {}),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.list(TENANT, { sessionId: 'a\u0000b' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    // Nothing reached the persistence layer.
    expect(repository.findById).not.toHaveBeenCalled();
    expect(repository.findArtifactById).not.toHaveBeenCalled();
    expect(repository.list).not.toHaveBeenCalled();
  });

  it('REDACTS a payment-bearing route id from not-found messages', async () => {
    // 404 messages reflect the CALLER-SUPPLIED path segment; a PAN used as
    // an id must echo back as [REDACTED] (error responses are logged).
    const pan = '4111111111111111';
    const { service } = buildService({
      repository: {
        findById: jest.fn(async () => null),
        findArtifactById: jest.fn(async () => null),
      },
    });
    for (const lookup of [
      () => service.findById(TENANT, pan),
      () => service.findArtifactById(TENANT, pan),
    ]) {
      const error: Error = await lookup()
        .then(() => {
          throw new Error('expected rejection');
        })
        .catch((caught: Error) => caught);
      expect(error).toBeInstanceOf(NotFoundException);
      expect(error.message).toContain('[REDACTED]');
      expect(error.message).not.toContain(pan);
    }
  });
});

describe('VideoAssetsService.createInferenceJobFromCrop', () => {
  it('fails closed AND audits ACCESS_DENIED when the inference module is disabled', async () => {
    const { service, inference, auditLog } = buildService({
      modules: { isEnabledForTenant: jest.fn(async () => false) },
    });
    await expect(
      service.createInferenceJobFromCrop(TENANT, 'artifact-1', {}),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(inference.create).not.toHaveBeenCalled();
    // Same auditable semantics as ModuleEnabledGuard: the cross-module
    // denial is never invisible in the authorization audit trail.
    expect(auditLog.record).toHaveBeenCalledTimes(1);
    const [entry] = auditLog.record.mock.calls[0] as unknown as [
      { action: string; entityType: string; entityId: string },
    ];
    expect(entry.action).toBe('ACCESS_DENIED');
    expect(entry.entityType).toBe('VideoArtifact');
    expect(entry.entityId).toBe('artifact-1');
  });

  it('REDACTS a sensitive path-segment id in the existence-blind denial audit', async () => {
    // /video-crops/<PAN>/inference-job with the module disabled records an
    // audit entry BEFORE any lookup — the attacker-controlled id must not
    // land verbatim (AGENTS.md payments invariant).
    const { service, auditLog } = buildService({
      modules: { isEnabledForTenant: jest.fn(async () => false) },
    });
    const pan = ['4111', '1111', '1111', '1111'].join('');
    await expect(
      service.createInferenceJobFromCrop(TENANT, pan, {}),
    ).rejects.toBeInstanceOf(ForbiddenException);
    const [entry] = auditLog.record.mock.calls[0] as unknown as [
      { entityId: string },
    ];
    expect(entry.entityId).toBe('[REDACTED]');
  });

  it('never links a replayed job whose jobType differs from the request', async () => {
    // A preclaimed job with the right descriptor/context but a DIFFERENT
    // jobType would bind the crop to the wrong operation.
    const { service, repository } = buildService({
      inference: {
        create: jest.fn(async (_t: string, dto: { inputDescriptor: unknown; sourceId?: string }) => ({
          id: 'job-1',
          jobType: InferenceJobType.PRODUCT_RECOGNITION, // request resolves SHELF_AUDIT below
          inputDescriptor: dto.inputDescriptor,
          sourceType: EvidenceSourceType.VISION, // isolate the jobType mismatch
          sourceId: dto.sourceId ?? null,
          locationId: null,
          unitId: null,
          deviceId: null,
          sessionId: null,
        })),
      },
      repository: {
        findArtifactById: jest.fn(async () =>
          artifactRow({ reason: VideoCropReason.SHELF_AUDIT }),
        ),
      },
    });
    await expect(
      service.createInferenceJobFromCrop(TENANT, 'artifact-1', {}),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(repository.linkArtifactToInferenceJob).not.toHaveBeenCalled();
  });

  it('stamps the server-derived VISION sourceType on every crop-created job (never a schema default, never client-tunable)', async () => {
    const { service, inference } = buildService();
    await service.createInferenceJobFromCrop(TENANT, 'artifact-1', {});
    const [, dto] = inference.create.mock.calls[0] as unknown as [
      string,
      { sourceType: EvidenceSourceType },
    ];
    expect(dto.sourceType).toBe(EvidenceSourceType.VISION);
  });

  it('never links a preclaimed job whose sourceType is not the server-derived VISION provenance', async () => {
    // Codex P2: a same-tenant caller holding inference:manage can squat
    // the derived `video-crop:<id>` key with the EXACT expected
    // descriptor, context, and jobType but sourceType ADMIN — without
    // this guard the crop links to that job and its VisionEvent inherits
    // false provenance. Everything matches here EXCEPT sourceType, so
    // the 409 isolates the provenance check.
    const { service, repository } = buildService({
      inference: {
        create: jest.fn(
          async (
            _t: string,
            dto: {
              jobType: InferenceJobType;
              inputDescriptor: unknown;
              sourceId?: string;
              locationId?: string;
              unitId?: string;
              deviceId?: string;
              sessionId?: string;
            },
          ) => ({
            id: 'job-squatted',
            jobType: dto.jobType,
            inputDescriptor: dto.inputDescriptor,
            sourceType: EvidenceSourceType.ADMIN, // the ONLY mismatch
            sourceId: dto.sourceId ?? null,
            locationId: dto.locationId ?? null,
            unitId: dto.unitId ?? null,
            deviceId: dto.deviceId ?? null,
            sessionId: dto.sessionId ?? null,
          }),
        ),
      },
    });
    await expect(
      service.createInferenceJobFromCrop(TENANT, 'artifact-1', {}),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(repository.linkArtifactToInferenceJob).not.toHaveBeenCalled();
  });

  it('409s an already-linked replay whose linked job carries a non-VISION sourceType', async () => {
    // Mirror of the preclaimed matcher on the already-linked path: a link
    // whose job is MANUAL/ADMIN provenance is not a crop-created job and
    // must never be handed back as one.
    const { service, inference, repository } = buildService({
      repository: {
        findArtifactById: jest.fn(async () =>
          artifactRow({ inferenceJobId: 'job-9' }),
        ),
      },
      inference: {
        findById: jest.fn(async () => ({
          id: 'job-9',
          jobType: InferenceJobType.PRODUCT_RECOGNITION,
          sourceType: EvidenceSourceType.MANUAL,
        })),
      },
    });
    await expect(
      service.createInferenceJobFromCrop(TENANT, 'artifact-1', {}),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(inference.create).not.toHaveBeenCalled();
    expect(repository.linkArtifactToInferenceJob).not.toHaveBeenCalled();
  });

  it('never links a replayed job that does not reference this crop', async () => {
    // A caller with inference:manage could have squatted the derived
    // `video-crop:<id>` key with an unrelated direct Phase 9 create — the
    // tenant-scoped idempotency replay then returns THAT job.
    const { service, repository } = buildService({
      inference: {
        create: jest.fn(async () => ({
          id: 'job-foreign',
          jobType: InferenceJobType.PRODUCT_RECOGNITION,
          sourceType: EvidenceSourceType.VISION, // isolate the descriptor mismatch
          inputDescriptor: { cropArtifactId: 'someone-elses-crop' },
        })),
      },
    });
    await expect(
      service.createInferenceJobFromCrop(TENANT, 'artifact-1', {}),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(repository.linkArtifactToInferenceJob).not.toHaveBeenCalled();
  });

  it('refuses FRAME artifacts', async () => {
    const { service } = buildService({
      repository: {
        findArtifactById: jest.fn(async () =>
          artifactRow({ artifactType: VideoArtifactType.FRAME, cropX: null }),
        ),
      },
    });
    await expect(
      service.createInferenceJobFromCrop(TENANT, 'artifact-1', {}),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('builds a SAFE descriptor (opaque ids only) with a derived idempotency key', async () => {
    const { service, inference } = buildService({
      repository: {
        findById: jest.fn(async () =>
          assetRow({ deviceId: 'device-1', locationId: 'loc-1', unitId: 'unit-1' }),
        ),
      },
    });
    const result = await service.createInferenceJobFromCrop(TENANT, 'artifact-1', {});
    expect(result.replayed).toBe(false);
    const [tenantArg, dto] = inference.create.mock.calls[0] as unknown as [
      string,
      {
        jobType: InferenceJobType;
        idempotencyKey: string;
        inputDescriptor: Record<string, unknown>;
      },
    ];
    expect(tenantArg).toBe(TENANT);
    expect(dto.idempotencyKey).toBe('video-crop:artifact-1');
    // Reason PRODUCT_PICKUP has no 1:1 job type → PRODUCT_RECOGNITION.
    expect(dto.jobType).toBe(InferenceJobType.PRODUCT_RECOGNITION);
    const flat = JSON.stringify(dto.inputDescriptor);
    expect(dto.inputDescriptor.cropArtifactId).toBe('artifact-1');
    expect(dto.inputDescriptor.videoAssetId).toBe('asset-1');
    // NEVER a storage key, path, URL, or bytes.
    expect(flat).not.toMatch(/storageKey|\.mp4|\.png|:\/\/|\\\\|base64/);
  });

  it('maps 1:1 reasons to their job types', async () => {
    const { service, inference } = buildService({
      repository: {
        findArtifactById: jest.fn(async () =>
          artifactRow({ reason: VideoCropReason.SHELF_AUDIT }),
        ),
      },
    });
    await service.createInferenceJobFromCrop(TENANT, 'artifact-1', {});
    const [, dto] = inference.create.mock.calls[0] as unknown as [string, { jobType: InferenceJobType }];
    expect(dto.jobType).toBe(InferenceJobType.SHELF_AUDIT);
  });

  it('hands the crop’s PARENT asset id to the one-shot link (the repository’s advisory-lock key)', async () => {
    // Finding: the link must serialize with DELETE /video-assets/:id on
    // the parent asset's advisory lock — the repository takes the lock
    // BEFORE its guarded read, so the service passes the parent id
    // explicitly from the already-resolved artifact.
    const { service, repository } = buildService();
    await service.createInferenceJobFromCrop(TENANT, 'artifact-1', {});
    expect(repository.linkArtifactToInferenceJob).toHaveBeenCalledWith(
      TENANT,
      'asset-1',
      'artifact-1',
      'job-1',
      expect.any(Function),
    );
  });

  it('replays the linked job instead of creating a duplicate', async () => {
    const { service, inference } = buildService({
      repository: {
        findArtifactById: jest.fn(async () =>
          artifactRow({ inferenceJobId: 'job-9' }),
        ),
      },
    });
    const result = await service.createInferenceJobFromCrop(TENANT, 'artifact-1', {});
    expect(result.replayed).toBe(true);
    expect(inference.create).not.toHaveBeenCalled();
    expect(inference.findById).toHaveBeenCalledWith(TENANT, 'job-9');
  });

  it('409s an already-linked replay that resolves to a DIFFERENT jobType', async () => {
    // The linked job is PRODUCT_RECOGNITION; a retry explicitly requesting
    // SHELF_AUDIT must not be silently handed the existing job.
    const { service, inference, repository } = buildService({
      repository: {
        findArtifactById: jest.fn(async () =>
          artifactRow({ inferenceJobId: 'job-9' }),
        ),
      },
      inference: {
        findById: jest.fn(async () => ({
          id: 'job-9',
          jobType: InferenceJobType.PRODUCT_RECOGNITION,
          sourceType: EvidenceSourceType.VISION,
        })),
      },
    });
    await expect(
      service.createInferenceJobFromCrop(TENANT, 'artifact-1', {
        jobType: InferenceJobType.SHELF_AUDIT,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(inference.create).not.toHaveBeenCalled();
    expect(repository.linkArtifactToInferenceJob).not.toHaveBeenCalled();
  });

  it('replays an already-linked crop when the retry resolves to the SAME jobType', async () => {
    // Explicitly requesting the type the link already has (or omitting it
    // so the resolution lands there — covered above) still replays.
    const { service, inference } = buildService({
      repository: {
        findArtifactById: jest.fn(async () =>
          artifactRow({ inferenceJobId: 'job-9' }),
        ),
      },
      inference: {
        findById: jest.fn(async () => ({
          id: 'job-9',
          jobType: InferenceJobType.PRODUCT_RECOGNITION,
          // The server-derived provenance the replay guard requires.
          sourceType: EvidenceSourceType.VISION,
        })),
      },
    });
    const result = await service.createInferenceJobFromCrop(TENANT, 'artifact-1', {
      jobType: InferenceJobType.PRODUCT_RECOGNITION,
    });
    expect(result.replayed).toBe(true);
    expect(inference.create).not.toHaveBeenCalled();
  });

  it('refuses crops whose source asset was deleted', async () => {
    const { service } = buildService({
      repository: { findById: jest.fn(async () => null) },
    });
    await expect(
      service.createInferenceJobFromCrop(TENANT, 'artifact-1', {}),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('CANCELS the just-created job when the parent asset is deleted before the link, then 404s', async () => {
    // Deletion race: the job creation committed, then DELETE
    // /video-assets/:id soft-deleted the parent before the one-shot link
    // could stamp — the link write zeroes out and the artifact re-read
    // sees nothing. The created job must not stay QUEUED as orphan work:
    // it is cancelled through the inference module's internal seam BEFORE
    // the 404 surfaces.
    const { service, inference, auditLog } = buildService({
      repository: {
        findArtifactById: jest
          .fn()
          .mockResolvedValueOnce(artifactRow()) // initial resolve
          .mockResolvedValueOnce(null), // post-link re-read: parent deleted
        linkArtifactToInferenceJob: jest.fn(async () => null),
      },
    });
    await expect(
      service.createInferenceJobFromCrop(TENANT, 'artifact-1', {}),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(inference.cancelOrphanedJob).toHaveBeenCalledWith(
      TENANT,
      'job-1',
      expect.stringContaining('deleted'),
      undefined,
    );
    // Cancellation succeeded — no orphan-condition audit entry is needed
    // (the cancel itself is audited inside the inference module).
    expect(auditLog.record).not.toHaveBeenCalled();
  });

  it('AUDITS the orphan condition when the created job is no longer cancellable, and still 404s', async () => {
    // The job was claimed (RUNNING) before the compensation ran: it cannot
    // be cancelled, so the orphan condition is recorded in the audit trail
    // and the caller still gets the honest 404.
    const { service, inference, auditLog } = buildService({
      repository: {
        findArtifactById: jest
          .fn()
          .mockResolvedValueOnce(artifactRow())
          .mockResolvedValueOnce(null),
        linkArtifactToInferenceJob: jest.fn(async () => null),
      },
      inference: {
        cancelOrphanedJob: jest.fn(async () => 'not-cancellable' as const),
      },
    });
    await expect(
      service.createInferenceJobFromCrop(TENANT, 'artifact-1', {}),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(inference.cancelOrphanedJob).toHaveBeenCalledTimes(1);
    expect(auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'InferenceJob',
        entityId: 'job-1',
        reason: expect.stringContaining('Orphaned inference job'),
      }),
    );
  });
});

describe('VideoAssetsService.delete', () => {
  it('commits the audited soft-delete FIRST, then removes local files', async () => {
    const { service, storage, repository } = buildService();
    await service.delete(TENANT, 'asset-1');
    expect(repository.softDelete).toHaveBeenCalled();
    expect(storage.deletePrefix).toHaveBeenCalledWith(`${TENANT}/uuid-1`);
    // Filesystem removal must never precede the durable, audited row flip.
    const softDeleteOrder = (repository.softDelete as jest.Mock).mock
      .invocationCallOrder[0];
    const deletePrefixOrder = (storage.deletePrefix as jest.Mock).mock
      .invocationCallOrder[0];
    expect(softDeleteOrder).toBeLessThan(deletePrefixOrder);
  });

  it('audits the soft-delete as cleanup PENDING and records completion only AFTER the cleanup succeeded', async () => {
    // Finding J: the soft-delete transaction commits BEFORE linked-job
    // retirement and the storage removal run — durable evidence written
    // there must never claim the media was already removed. Completion
    // gets its own entry via the exactly-once marker CAS once the cleanup
    // actually finished.
    let softDeleteEntry: { reason?: string } | undefined;
    const softDelete = jest.fn(
      async (
        _t: string,
        _id: string,
        build: (b: unknown, mediaAlreadyRemoved: boolean) => unknown,
      ) => {
        const before = assetRow();
        softDeleteEntry = build(before, false) as { reason?: string };
        return { asset: before, mediaAlreadyRemoved: false };
      },
    );
    const { service, storage, repository, auditLog } = buildService({
      repository: { softDelete },
    });
    await service.delete(TENANT, 'asset-1');
    expect(softDeleteEntry?.reason).toContain('cleanup pending');
    expect(softDeleteEntry?.reason).not.toContain('removed');
    // Completion is recorded through the marker CAS, AFTER deletePrefix.
    expect(repository.recordMediaRemovalCompleted).toHaveBeenCalledTimes(1);
    const removalOrder = (storage.deletePrefix as jest.Mock).mock
      .invocationCallOrder[0];
    expect(
      (repository.recordMediaRemovalCompleted as jest.Mock).mock
        .invocationCallOrder[0],
    ).toBeGreaterThan(removalOrder);
    const completion = (
      (repository.recordMediaRemovalCompleted as jest.Mock).mock
        .calls[0][2] as () => {
        action: string;
        entityType: string;
        entityId: string;
        reason: string;
      }
    )();
    expect(completion.action).toBe('DELETE');
    expect(completion.entityType).toBe('VideoAsset');
    expect(completion.entityId).toBe('asset-1');
    // The reason distinguishes the delete cleanup from the screening
    // removal (same marker column, different completion evidence).
    expect(completion.reason).toContain('deletion cleanup completed');
    // No direct service-side audit write — the completion entry commits
    // inside the repository's marker transaction.
    expect(auditLog.record).not.toHaveBeenCalled();
  });

  it('audits a METADATA-ONLY delete (no pending promise, no completion attempt) when a screening rejection already removed and recorded the media', async () => {
    // Codex P2: the single mediaRemovedAt marker was already claimed by
    // the screening-rejection removal — auditing this delete as "cleanup
    // pending (completion recorded in the audit trail)" would promise a
    // completion whose CAS always loses and never writes, leaving the
    // deletion permanently pending in the audit trail. The marker is read
    // inside softDelete's locked transaction; the audit tells the honest
    // metadata-only story and the service skips the completion recording.
    let softDeleteEntry: { reason?: string } | undefined;
    const softDelete = jest.fn(
      async (
        _t: string,
        _id: string,
        build: (b: unknown, mediaAlreadyRemoved: boolean) => unknown,
      ) => {
        const before = assetRow({ status: VideoAssetStatus.REJECTED });
        softDeleteEntry = build(before, true) as { reason?: string };
        return { asset: before, mediaAlreadyRemoved: true };
      },
    );
    const { service, storage, repository, auditLog } = buildService({
      repository: {
        findByIdInternalIncludingDeleted: jest.fn(async () =>
          assetRow({
            status: VideoAssetStatus.REJECTED,
            mediaRemovedAt: new Date(),
          }),
        ),
        softDelete,
      },
      // The rejection already removed the bytes — nothing under the prefix.
      storage: { deletePrefix: jest.fn(async () => false) },
    });
    await expect(service.delete(TENANT, 'asset-1')).resolves.toEqual({
      deleted: true,
    });
    // Honest wording: already removed, metadata-only — never a pending
    // cleanup promise.
    expect(softDeleteEntry?.reason).toContain('already removed');
    expect(softDeleteEntry?.reason).toContain('metadata-only');
    expect(softDeleteEntry?.reason).not.toContain('pending');
    // No completion is owed or attempted — the screening rejection's
    // completion entry is the one and only removal evidence.
    expect(repository.recordMediaRemovalCompleted).not.toHaveBeenCalled();
    expect(auditLog.record).not.toHaveBeenCalled();
    // The idempotent straggler sweep still runs.
    expect(storage.deletePrefix).toHaveBeenCalledTimes(1);
  });

  it('a replay over the metadata-only delete stays quiet: no second soft-delete, no completion attempt', async () => {
    // Idempotent DELETE replay of the case above — the row is deleted and
    // the marker already claimed, so nothing is promised, attempted, or
    // audited again.
    const { service, storage, repository, auditLog } = buildService({
      repository: {
        findByIdInternalIncludingDeleted: jest.fn(async () =>
          assetRow({
            status: VideoAssetStatus.REJECTED,
            deletedAt: new Date(),
            mediaRemovedAt: new Date(),
          }),
        ),
      },
      storage: { deletePrefix: jest.fn(async () => false) },
    });
    await expect(service.delete(TENANT, 'asset-1')).resolves.toEqual({
      deleted: true,
    });
    expect(repository.softDelete).not.toHaveBeenCalled();
    expect(repository.recordMediaRemovalCompleted).not.toHaveBeenCalled();
    expect(auditLog.record).not.toHaveBeenCalled();
    expect(storage.deletePrefix).toHaveBeenCalledTimes(1);
  });

  it('a failed cleanup surfaces the controlled 503 and records NO completion — the durable state stays honestly pending', async () => {
    const deletePrefix = jest.fn(async () => {
      throw new VideoStorageOperationError();
    });
    const { service, repository } = buildService({
      storage: { deletePrefix },
    });
    await expect(service.delete(TENANT, 'asset-1')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    // The soft-delete's "cleanup pending" audit remains the only durable
    // evidence; no completion is recorded until a replay succeeds.
    expect(repository.recordMediaRemovalCompleted).not.toHaveBeenCalled();
  });

  it('retries file cleanup idempotently for an already-deleted asset', async () => {
    // A crash between the durable soft-delete and the file removal leaves
    // orphaned files; re-issuing DELETE completes the cleanup without a
    // second soft-delete or audit row.
    const { service, storage, repository } = buildService({
      repository: {
        findByIdInternalIncludingDeleted: jest.fn(async () =>
          assetRow({ deletedAt: new Date() }),
        ),
      },
    });
    await expect(service.delete(TENANT, 'asset-1')).resolves.toEqual({
      deleted: true,
    });
    expect(repository.softDelete).not.toHaveBeenCalled();
    expect(storage.deletePrefix).toHaveBeenCalledWith(`${TENANT}/uuid-1`);
    // The replay that finishes the cleanup records completion exactly
    // once — the marker CAS dedupes any concurrent attempt.
    expect(repository.recordMediaRemovalCompleted).toHaveBeenCalledTimes(1);
  });

  it('a delete replay over an already-recorded removal writes no duplicate completion', async () => {
    // The asset's media was already removed AND recorded (e.g. a
    // screening rejection, or a previous fully-successful delete): the
    // replay still attempts the marker CAS, loses it, and re-audits
    // nothing.
    const recordMediaRemovalCompleted = jest.fn(
      async () => 'already-recorded' as const,
    );
    const { service, auditLog } = buildService({
      storage: { deletePrefix: jest.fn(async () => false) },
      repository: {
        findByIdInternalIncludingDeleted: jest.fn(async () =>
          assetRow({ deletedAt: new Date() }),
        ),
        recordMediaRemovalCompleted,
      },
    });
    await expect(service.delete(TENANT, 'asset-1')).resolves.toEqual({
      deleted: true,
    });
    expect(recordMediaRemovalCompleted).toHaveBeenCalledTimes(1);
    expect(auditLog.record).not.toHaveBeenCalled();
  });

  it('404s for a missing asset', async () => {
    const { service } = buildService({
      repository: {
        findByIdInternalIncludingDeleted: jest.fn(async () => null),
      },
    });
    await expect(service.delete(TENANT, 'nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('cancels every linked QUEUED inference job (multiple artifacts) BEFORE removing media', async () => {
    // Finding D regression pin: crops already linked to Phase 9 jobs must
    // not leave claimable QUEUED work behind once their input media is
    // deleted. Cancellation reuses the existing audited internal seam and
    // runs before the media disappears.
    const { service, storage, inference, auditLog } = buildService({
      repository: {
        listLinkedInferenceJobs: jest.fn(async () => [
          { id: 'job-1', status: InferenceJobStatus.QUEUED },
          { id: 'job-2', status: InferenceJobStatus.QUEUED },
        ]),
      },
    });
    await service.delete(TENANT, 'asset-1', { id: 'u1', email: 'u@x.io' });
    expect(inference.cancelOrphanedJob).toHaveBeenCalledTimes(2);
    expect(inference.cancelOrphanedJob).toHaveBeenCalledWith(
      TENANT,
      'job-1',
      expect.stringContaining('deleted'),
      { id: 'u1', email: 'u@x.io' },
    );
    expect(inference.cancelOrphanedJob).toHaveBeenCalledWith(
      TENANT,
      'job-2',
      expect.stringContaining('deleted'),
      { id: 'u1', email: 'u@x.io' },
    );
    // Retirement completes BEFORE the media removal.
    const lastCancelOrder = (inference.cancelOrphanedJob as jest.Mock).mock
      .invocationCallOrder[1];
    const removalOrder = (storage.deletePrefix as jest.Mock).mock
      .invocationCallOrder[0];
    expect(lastCancelOrder).toBeLessThan(removalOrder);
    // Both cancels succeeded — no orphan-condition audit entries.
    expect(auditLog.record).not.toHaveBeenCalled();
  });

  it('AUDITS a RUNNING linked job as an orphan condition instead of attempting a cancel', async () => {
    const { service, inference, auditLog } = buildService({
      repository: {
        listLinkedInferenceJobs: jest.fn(async () => [
          { id: 'job-1', status: InferenceJobStatus.RUNNING },
        ]),
      },
    });
    await service.delete(TENANT, 'asset-1');
    expect(inference.cancelOrphanedJob).not.toHaveBeenCalled();
    expect(auditLog.record).toHaveBeenCalledTimes(1);
    expect(auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'InferenceJob',
        entityId: 'job-1',
        reason: expect.stringContaining('Orphaned inference job'),
      }),
    );
  });

  it('replays quietly: terminal linked jobs are neither re-cancelled nor re-audited', async () => {
    // Idempotent delete replay: the first attempt cancelled the QUEUED
    // jobs (now CANCELLED) and the finished ones are SUCCEEDED/FAILED —
    // none of them may produce another cancel attempt or another audit
    // entry, so replays never spam the audit trail.
    const { service, inference, auditLog, storage } = buildService({
      repository: {
        findByIdInternalIncludingDeleted: jest.fn(async () =>
          assetRow({ deletedAt: new Date() }),
        ),
        listLinkedInferenceJobs: jest.fn(async () => [
          { id: 'job-1', status: InferenceJobStatus.CANCELLED },
          { id: 'job-2', status: InferenceJobStatus.SUCCEEDED },
          { id: 'job-3', status: InferenceJobStatus.FAILED },
        ]),
      },
    });
    await expect(service.delete(TENANT, 'asset-1')).resolves.toEqual({
      deleted: true,
    });
    expect(inference.cancelOrphanedJob).not.toHaveBeenCalled();
    expect(auditLog.record).not.toHaveBeenCalled();
    // The idempotent file cleanup still runs.
    expect(storage.deletePrefix).toHaveBeenCalledTimes(1);
  });

  it('re-reads a QUEUED job that raced into a claim: terminal → silent, still running → orphan audit', async () => {
    // The enumeration saw QUEUED but the CAS lost (the job was claimed in
    // between). The re-read decides honestly: a job that already FINISHED
    // is not an orphan (silent); one still RUNNING is recorded.
    const cancelOrphanedJob = jest.fn(async () => 'not-cancellable' as const);
    const findById = jest
      .fn()
      .mockResolvedValueOnce({ id: 'job-1', status: InferenceJobStatus.SUCCEEDED })
      .mockResolvedValueOnce({ id: 'job-2', status: InferenceJobStatus.RUNNING });
    const { service, auditLog } = buildService({
      repository: {
        listLinkedInferenceJobs: jest.fn(async () => [
          { id: 'job-1', status: InferenceJobStatus.QUEUED },
          { id: 'job-2', status: InferenceJobStatus.QUEUED },
        ]),
      },
      inference: { cancelOrphanedJob, findById },
    });
    await service.delete(TENANT, 'asset-1');
    expect(cancelOrphanedJob).toHaveBeenCalledTimes(2);
    // Only the still-RUNNING job produced the orphan-condition entry.
    expect(auditLog.record).toHaveBeenCalledTimes(1);
    expect(auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'InferenceJob',
        entityId: 'job-2',
        reason: expect.stringContaining('could not be cancelled'),
      }),
    );
  });
});

describe('response safety', () => {
  it('list/detail views never include storageKey (safe select contract)', async () => {
    const { service } = buildService({
      repository: {
        findById: jest.fn(async () => {
          const row = assetRow();
          // The repository's safe select strips storageKey; mirror it here.
          delete (row as Record<string, unknown>).storageKey;
          return row;
        }),
      },
    });
    const asset = await service.findById(TENANT, 'asset-1');
    expect('storageKey' in asset).toBe(false);
  });
});
