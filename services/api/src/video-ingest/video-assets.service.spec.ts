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
  InferenceJobType,
  VideoArtifactType,
  VideoAssetStatus,
  VideoCropReason,
} from '@prisma/client';
import {
  ExtractionFailedError,
  ExtractionInfrastructureError,
  ExtractorUnavailableError,
  FrameUnavailableError,
} from './extraction/video-frame-extractor.port';
import { VideoScreeningDecision } from './dto/screen-video-asset.dto';
import { VideoStorageOperationError } from './storage/video-storage.port';
import {
  SCREENING_PREVIEW_MAX_FRAMES,
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
    uploadedById: null,
    deletedAt: null,
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
  inference?: Record<string, unknown>;
  modules?: Record<string, unknown>;
  maxUploadBytes?: string;
} = {}) {
  const repository = {
    createAsset: jest.fn(async (_t: string, data: unknown, build: (a: unknown) => unknown) => {
      // Mirrors the real repository: every new upload is persisted
      // QUARANTINED (status is forced at the persistence layer, never
      // caller-supplied).
      const created = assetRow({
        ...(data as Record<string, unknown>),
        status: VideoAssetStatus.QUARANTINED,
      });
      build(created);
      return created;
    }),
    findById: jest.fn(async () => assetRow()),
    findByIdInternal: jest.fn(async () => assetRow()),
    findByIdInternalIncludingDeleted: jest.fn(async () => assetRow()),
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
    softDelete: jest.fn(async (_t: string, _id: string, build: (b: unknown) => unknown) => {
      const before = assetRow();
      build(before);
      return before;
    }),
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
    linkArtifactToInferenceJob: jest.fn(
      async (
        _t: string,
        _id: string,
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
    deletePrefix: jest.fn(async () => undefined),
    internalPathFor: jest.fn(() => '/root/x'),
    ...overrides.storage,
  };
  const extractor = {
    kind: 'simulated',
    probe: jest.fn(async () => ({ durationMs: 10_000, width: 1280, height: 720, fps: 30 })),
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
  const inference = {
    // Echo the dto so the service's replayed-job verification sees a job
    // whose FULL descriptor and context genuinely reference the crop.
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
        id: 'job-1',
        jobType: dto.jobType,
        inputDescriptor: dto.inputDescriptor,
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
      key === 'VIDEO_MAX_UPLOAD_BYTES' ? overrides.maxUploadBytes : undefined,
  } as unknown as ConfigService;

  const service = new VideoAssetsService(
    repository as never,
    storage as never,
    extractor as never,
    inference as never,
    modules as never,
    auditLog as never,
    config,
  );
  return { service, repository, storage, extractor, inference, modules, auditLog };
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

  it('creates the asset QUARANTINED pending frame-content screening', async () => {
    // The attestation proves nothing about the bytes: the upload must land
    // NON-processable until an audited screening decision releases it.
    const { service } = buildService();
    const asset = await service.upload(TENANT, uploadFile(), { ...ATTEST });
    expect((asset as { status: VideoAssetStatus }).status).toBe(
      VideoAssetStatus.QUARANTINED,
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
    // media dir is removed best-effort, the row transitions QUARANTINED →
    // FAILED with the stable UPLOAD_INCOMPLETE code (error codes exist
    // exactly on REJECTED/FAILED — the error_only_terminal_check
    // constraint), the transition is audited, and the caller sees the
    // storage failure as the existing controlled 503. The row remains as
    // durable evidence referencing the key.
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
          assetRow({ status: VideoAssetStatus.QUARANTINED }),
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
    expect(expected).toEqual([VideoAssetStatus.QUARANTINED]);
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
});

describe('VideoAssetsService.screen', () => {
  const quarantined = () => assetRow({ status: VideoAssetStatus.QUARANTINED });

  it('APPROVE transitions QUARANTINED → UPLOADED through the audited CAS machinery', async () => {
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
    const { service, repository } = buildService({
      repository: {
        findByIdInternal: jest.fn(async () => quarantined()),
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
    const [, , expected, data] = repository.transitionStatus.mock
      .calls[0] as unknown as [
      string,
      string,
      VideoAssetStatus[],
      { status: VideoAssetStatus; errorCode?: string },
    ];
    expect(expected).toEqual([VideoAssetStatus.QUARANTINED]);
    expect(data.status).toBe(VideoAssetStatus.UPLOADED);
    expect(data.errorCode).toBeUndefined();
    expect(entry?.reason).toContain('screening approved');
  });

  it('APPROVE unlocks validation (the released asset probes normally)', async () => {
    const findByIdInternal = jest
      .fn()
      .mockResolvedValueOnce(quarantined()) // screen() read
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
    const { service, storage, repository } = buildService({
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
      { status: VideoAssetStatus; errorCode: string },
    ];
    expect(expected).toEqual([VideoAssetStatus.QUARANTINED]);
    expect(data.status).toBe(VideoAssetStatus.REJECTED);
    expect(data.errorCode).toBe('SCREENING_REJECTED');
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
      .mockResolvedValueOnce(undefined);
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
    const { service, repository } = buildService({
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
  });

  it('REJECT replays on an asset already REJECTED by screening: re-attempts the removal and succeeds', async () => {
    // Recovery path for a removal that failed post-claim: the SAME
    // endpoint, retried, re-runs the (idempotent) media removal and
    // returns success — allowed for EXACTLY errorCode SCREENING_REJECTED,
    // because only a screening rejection claims media it then removes.
    const rejectedRow = () =>
      assetRow({
        status: VideoAssetStatus.REJECTED,
        errorCode: 'SCREENING_REJECTED',
        errorMessage:
          'Frame-content screening rejected this upload; the stored media ' +
          'was removed',
      });
    const { service, storage, repository } = buildService({
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
    // The removal re-ran; no second transition and no second audit entry.
    expect(storage.deletePrefix).toHaveBeenCalledWith(`${TENANT}/uuid-1`);
    expect(repository.transitionStatus).not.toHaveBeenCalled();
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
      repository: { findByIdInternal: jest.fn(async () => quarantined()) },
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
        findByIdInternal: jest.fn(async () => quarantined()),
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

  it('AUDITS every served preview (READ action, frame count in the reason)', async () => {
    const { service, auditLog } = buildService({
      repository: { findByIdInternal: jest.fn(async () => quarantined()) },
    });
    await service.screeningPreview(TENANT, 'asset-1', {
      id: 'u1',
      email: 'screener@x.io',
    });
    expect(auditLog.record).toHaveBeenCalledTimes(1);
    const [entry] = auditLog.record.mock.calls[0] as unknown as [
      {
        action: string;
        entityType: string;
        entityId: string;
        actorEmail: string;
        reason: string;
      },
    ];
    expect(entry.action).toBe('READ');
    expect(entry.entityType).toBe('VideoAsset');
    expect(entry.entityId).toBe('asset-1');
    expect(entry.actorEmail).toBe('screener@x.io');
    expect(entry.reason).toContain('Screening preview served: 6 sample frame');
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

  it('skips frames that would exceed the decoded-byte budget and reports the skip', async () => {
    // Reuses the module's request-wide extraction byte budget — an
    // over-budget frame is dropped and COUNTED, never partially returned.
    const huge = { length: 200 * 1024 * 1024 } as Buffer;
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
    expect(items[0].storageKey).toMatch(/artifacts\/[0-9a-f-]{36}\.png$/);
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

  it('never links a replayed job that does not reference this crop', async () => {
    // A caller with inference:manage could have squatted the derived
    // `video-crop:<id>` key with an unrelated direct Phase 9 create — the
    // tenant-scoped idempotency replay then returns THAT job.
    const { service, repository } = buildService({
      inference: {
        create: jest.fn(async () => ({
          id: 'job-foreign',
          jobType: InferenceJobType.PRODUCT_RECOGNITION,
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
