import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  PayloadTooLargeException,
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
} from './extraction/video-frame-extractor.port';
import {
  UploadedVideoFile,
  VideoAssetsService,
} from './video-assets.service';

const TENANT = 'tenant-1';

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
      const created = assetRow({ status: VideoAssetStatus.UPLOADED, ...(data as Record<string, unknown>) });
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
        return { asset, artifacts };
      },
    ),
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
    // Echo the dto so the service's replayed-job descriptor verification
    // sees a job that genuinely references the requested crop.
    create: jest.fn(async (_t: string, dto: { jobType: InferenceJobType; inputDescriptor: unknown }) => ({
      id: 'job-1',
      jobType: dto.jobType,
      inputDescriptor: dto.inputDescriptor,
    })),
    findById: jest.fn(async () => ({ id: 'job-1' })),
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
    await service.upload(TENANT, uploadFile(), {}, { id: 'u1', email: 'u@x.io' });

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

  it('rejects a missing file part', async () => {
    const { service } = buildService();
    await expect(service.upload(TENANT, undefined, {})).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it.each([
    ['../../../etc/passwd.mp4'],
    ['dir/clip.mp4'],
    ['dir\\clip.mp4'],
    ['.hidden.mp4'],
  ])('rejects traversal-shaped filename %p', async (originalname) => {
    const { service, storage } = buildService();
    await expect(
      service.upload(TENANT, uploadFile({ originalname }), {}),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('sanitizes awkward-but-safe filenames for display', async () => {
    const { service, repository } = buildService();
    await service.upload(TENANT, uploadFile({ originalname: 'my clip (1).mp4' }), {});
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
      service.upload(TENANT, uploadFile({ originalname, mimetype }), {}),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('rejects content whose magic bytes do not match the container', async () => {
    const { service, storage } = buildService();
    const script = Buffer.from('#!/bin/sh\necho pwned\n'.padEnd(64, ' '), 'ascii');
    await expect(
      service.upload(TENANT, uploadFile({ buffer: script, size: script.length }), {}),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('rejects oversized uploads with 413', async () => {
    const { service, storage } = buildService({ maxUploadBytes: '64' });
    const big = Buffer.concat([mp4Buffer(), Buffer.alloc(128)]);
    await expect(
      service.upload(TENANT, uploadFile({ buffer: big, size: big.length }), {}),
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
        service.upload(TENANT, uploadFile({ originalname }), {}),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
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
      service.upload(TENANT, uploadFile(), { unitId: 'other-tenant-unit' }),
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

  it('404s for another tenant’s asset (tenant-scoped lookup)', async () => {
    const { service, repository } = buildService({
      repository: { findByIdInternal: jest.fn(async () => null) },
    });
    await expect(service.validate(TENANT, 'foreign')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect((repository.findByIdInternal.mock.calls[0] as unknown as [string])[0]).toBe(TENANT);
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
    const [, , , items] = repository.createArtifactsBatch.mock
      .calls[0] as unknown as [
      string,
      string,
      VideoAssetStatus[],
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
