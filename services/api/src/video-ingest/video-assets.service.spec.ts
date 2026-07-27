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
  FrameUnavailableError,
} from './extraction/video-frame-extractor.port';
import { VideoScreeningDecision } from './dto/screen-video-asset.dto';
import {
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

/** Mirrors the service's CANONICAL frames fingerprint (defaults applied). */
function framesFingerprint(params: {
  timestampMs?: number;
  intervalMs?: number;
  maxFrames?: number;
} = {}): string {
  return params.timestampMs !== undefined
    ? JSON.stringify({ op: 'FRAMES', timestampMs: params.timestampMs })
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

  it('retries a transient cleanup failure and still surfaces the ORIGINAL error', async () => {
    // File stored, row failed (broken FK), first deletePrefix throws, the
    // retry succeeds: the caller sees the controlled 400 for the broken
    // reference — the cleanup failure was transient and is NOT escalated.
    const deletePrefix = jest
      .fn()
      .mockRejectedValueOnce(new Error('EBUSY'))
      .mockResolvedValueOnce(undefined);
    const { service } = buildService({
      storage: { deletePrefix },
      repository: {
        createAsset: jest.fn(async () => {
          throw Object.assign(new Error('fk'), { code: 'P2003' });
        }),
      },
    });
    await expect(
      service.upload(TENANT, uploadFile(), { ...ATTEST, unitId: 'missing-unit' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(deletePrefix).toHaveBeenCalledTimes(2);
  });

  it('escalates a PERSISTENT cleanup failure as 503 instead of discarding it', async () => {
    // Row creation failed AND both cleanup attempts failed: no asset row
    // references the generated key, so silently ignoring the failure would
    // strand untracked media on disk. The controlled 503 names the
    // condition so the operator acts on it.
    const deletePrefix = jest.fn(async () => {
      throw new Error('EACCES');
    });
    const { service } = buildService({
      storage: { deletePrefix },
      repository: {
        createAsset: jest.fn(async () => {
          throw Object.assign(new Error('fk'), { code: 'P2003' });
        }),
      },
    });
    await expect(
      service.upload(TENANT, uploadFile(), { ...ATTEST }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    // One retry, then escalation — never an unbounded loop.
    expect(deletePrefix).toHaveBeenCalledTimes(2);
  });

  it('rejects context references that do not form one consistent hierarchy', async () => {
    // Same rules and vocabulary as PrismaInferenceQueue.enqueue(): an asset
    // the queue would later reject must fail AT UPLOAD.
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
    // The stored file must not outlive the rejected row.
    expect(storage.deletePrefix).toHaveBeenCalledTimes(1);
  });

  it('maps broken references to a controlled 400 and cleans the stored file', async () => {
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
    expect(storage.deletePrefix).toHaveBeenCalledTimes(1);
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
    // The screened operator note rides in the audited record.
    expect(entry?.reason).toContain('screening rejected');
    expect(entry?.reason).toContain('payment terminal visible in frame 3');
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

  it('REJECT escalates a persistent media-removal failure as 503 and stays QUARANTINED', async () => {
    // The 503 fires BEFORE any transition, so the rejection is retryable
    // through the same endpoint — bytes can never outlive a recorded
    // rejection.
    const deletePrefix = jest.fn(async () => {
      throw new Error('EACCES');
    });
    const { service, repository } = buildService({
      storage: { deletePrefix },
      repository: { findByIdInternal: jest.fn(async () => quarantined()) },
    });
    await expect(
      service.screen(TENANT, 'asset-1', {
        decision: VideoScreeningDecision.REJECT,
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    // One retry, then escalation — never an unbounded loop.
    expect(deletePrefix).toHaveBeenCalledTimes(2);
    expect(repository.transitionStatus).not.toHaveBeenCalled();
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
    const { service, repository } = buildService();
    for (const note of [
      ['4111', '1111', '1111', '1111'].join(' '),
      'password=hunter2',
    ]) {
      await expect(
        service.screen(TENANT, 'asset-1', {
          decision: VideoScreeningDecision.APPROVE,
          note,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(repository.findByIdInternal).not.toHaveBeenCalled();
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
    // clip's bytes are never decoded, sampled, or cropped.
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

  it('rejects idempotency keys carrying sensitive content', async () => {
    const { service } = buildService();
    await expect(
      service.extractFrames(TENANT, 'asset-1', {
        idempotencyKey: `pan-${['4111', '1111', '1111', '1111'].join(' ')}`,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
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
