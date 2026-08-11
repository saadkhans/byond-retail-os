import { createHash } from 'node:crypto';
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
  VideoMediaWriteState,
} from '@prisma/client';
import { DEFAULT_PRIORITY } from '../inference/dto/create-inference-job.dto';
import {
  ExtractionFailedError,
  ExtractionInfrastructureError,
  ExtractorUnavailableError,
  FrameCountExceededError,
  FrameExceedsBudgetError,
  FrameUnavailableError,
  ScreeningDeadlineExceededError,
} from './extraction/video-frame-extractor.port';
import { UNSTREAMABLE_CONTAINER_MESSAGE } from './extraction/ffmpeg-extractor.adapter';
import {
  FrameTextRecognitionFailedError,
  FrameTextRecognitionInfrastructureError,
} from './recognition/frame-text-recognizer.port';
import { VideoScreeningDecision } from './dto/screen-video-asset.dto';
import { VideoStorageOperationError } from './storage/video-storage.port';
import {
  SCREENING_TOOLING_UNAVAILABLE_MESSAGE,
  TEST_MEDIA_GATE_CLOSED_MESSAGE,
} from './test-media-gate.guard';
import {
  PRESTORE_SCREENING_MAX_FRAME_BYTES,
  SCREENING_PREVIEW_MAX_FRAMES,
  SCREENING_PREVIEW_MIN_FRAME_BYTES,
  SCREENING_PREVIEW_TOTAL_BYTES,
  STAGED_ARTIFACT_KEY_DIGEST_CHARS,
  UploadedVideoFile,
  VideoAssetsService,
} from './video-assets.service';

const TENANT = 'tenant-1';

/**
 * The FOUR required upload attestations — see UploadVideoAssetDto. They
 * are the operator's DECLARATIONS about controlled test media, not a
 * finding about the content; the thing that authorizes storing a clip is
 * the controlled test-media POLICY GATE (see POLICY_GATE_OPEN below).
 */
const ATTEST = {
  controlledTestMedia: 'true',
  noPaymentCardsVisible: 'true',
  noCustomerPII: 'true',
  attestNoSensitiveContent: 'true',
};

/** Every attestation field, for the per-field refusal matrix. */
const ATTESTATION_FIELDS = Object.keys(ATTEST) as (keyof typeof ATTEST)[];

/**
 * The CONTENT-ADDRESSED staging key shape (Codex P1): the asset prefix, the
 * operation directory (sha256 hex of the request identity), then the
 * artifact index joined to a truncated sha256 OF THE BYTES BEING WRITTEN.
 * The digest segment is what makes two concurrent first attempts producing
 * DIFFERENT bytes land on DIFFERENT files instead of overwriting each other
 * before either reaches the publication lock.
 */
function stagedKeyShape(index = 0): RegExp {
  return new RegExp(
    `^${TENANT}/uuid-1/artifacts/[0-9a-f]{64}/${index}-` +
      `[0-9a-f]{${STAGED_ARTIFACT_KEY_DIGEST_CHARS}}\\.png$`,
  );
}

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
    // Durable media-write state — SUCCEEDED by default (the upload's put
    // returned long ago, so nothing is in flight); the drain tests opt
    // into PENDING/FAILED/null.
    mediaWriteState: VideoMediaWriteState.SUCCEEDED,
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
  maxScreeningFrames?: string;
  screeningTimeoutMs?: string;
  // The CONTROLLED TEST-MEDIA POLICY GATE — the only thing that authorizes
  // an ingest. Defaults below open it ('true' + a non-production NODE_ENV)
  // so the rest of the suite exercises the paths behind it; the policy-gate
  // suite drives these explicitly.
  testMediaIngestEnabled?: string;
  // The unscreened-upload bypass is REMOVED: this remains wired into the
  // mock ConfigService ONLY so tests can prove the service ignores it
  // completely in every environment.
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
    // Advisory-lock-guarded liveness read + durable media-write CLAIM the
    // upload takes immediately before its media write (delete-race window
    // shrink, and the PENDING state a later delete OBSERVES) — 'live' by
    // default; the concurrent-delete tests override.
    beginMediaWriteUnderLock: jest.fn(async () => 'live' as const),
    // Durable resolution of that claim: SUCCEEDED the moment the put
    // returns, FAILED when it throws.
    resolveMediaWrite: jest.fn(async () => undefined),
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
        build: (
          b: unknown,
          mediaAlreadyRemoved: boolean,
          mediaWriteUndecided: boolean,
        ) => unknown,
      ) => {
        const before = assetRow();
        build(before, false, false);
        return {
          asset: before,
          mediaAlreadyRemoved: false,
          mediaWriteUndecided: false,
        };
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
    // The publication transaction: it takes the OPERATION advisory lock as
    // its own first statement (there is no outer lock wrapper any more) and
    // reports the committed-owner verdict for the staged keys alongside its
    // outcome. Default: a clean first publish with no pre-existing owner.
    createArtifactsBatch: jest.fn(
      async (
        _t: string,
        videoAssetId: string,
        _operationHash: string,
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
        return {
          asset,
          artifacts,
          replayed: false,
          committedStagedKeys: [],
        };
      },
    ),
    findExtractionReplay: jest.fn(async () => null),
    findArtifactById: jest.fn(async () => artifactRow()),
    listArtifacts: jest.fn(async () => [artifactRow()]),
    // No crop is linked to a job by default — delete-flow tests override.
    listLinkedInferenceJobs: jest.fn(async () => []),
    // Crash-window sweep source: UNLINKED crop artifacts of the asset, each
    // probed under its deterministic `video-crop:<id>` idempotency key.
    listCropArtifactIds: jest.fn(async () => [] as string[]),
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
    // EXHAUSTIVE STREAMING decode backing the DEFAULT buffer-inspection
    // session (pre-storage screening). This mock supplies the FRAME
    // STREAM (or throws a controlled decode failure); the session below
    // drives the service's onFrame callback over it exactly as the real
    // adapter does. The real contract yields EVERY source frame; the
    // default mock yields one DISTINCT raw PNG buffer per STARTED second
    // of the probed duration — the minimum stream that satisfies the
    // service's completeness floor — so a test that overrides `probe`
    // drives the frame count too, and per-test overrides supply denser
    // streams. Frames are byte-distinct so the service's sha256 dedupe
    // does not collapse them (dedupe tests override with identical
    // buffers deliberately). Receives (options, durationMs) — the session
    // derives durationMs from the shared probe mock.
    streamFrames: jest.fn(
      async (
        _options: {
          maxFrames: number;
          maxBytesPerFrame: number;
          deadlineMs: number;
        },
        durationMs: number,
      ) =>
        Array.from(
          { length: Math.max(1, Math.ceil(durationMs / 1000)) },
          (_, index) => Buffer.from(`frame-${index}`),
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
    // opening runs no tooling; probe() is memoized; ONE streaming
    // decode; idempotent close). Delegates to the SAME probe/streamFrames
    // mocks (including per-test overrides), so a test that overrides one
    // surface drives the pre-storage screen too. The session DRIVES the
    // callback per the port contract: one frame at a time in decode
    // order, a 'stop' verdict abandons the rest and RESOLVES with
    // stoppedEarly:true (never an error), an onFrame rejection propagates
    // unchanged, and zero frames from an otherwise successful decode is
    // FrameUnavailableError.
    extractor.inspectBuffer = jest.fn(async (data: Buffer) => {
      void data;
      let probed: Promise<unknown> | null = null;
      // The probe is a BUDGETED external-tool stage exactly like the
      // decode, so the session forwards the caller's options (its
      // `deadlineMs` slice of the upload-wide budget) to the shared probe
      // mock — memoized on the first call, per the port contract.
      const probe = (options?: { deadlineMs?: number }) =>
        (probed ??= (
          extractor.probe as (
            key: string,
            options?: { deadlineMs?: number },
          ) => Promise<unknown>
        )('in-memory-upload', options));
      return {
        probe,
        streamFrames: async (options: {
          maxFrames: number;
          maxBytesPerFrame: number;
          deadlineMs: number;
          onFrame: (frame: Buffer, index: number) => Promise<'continue' | 'stop'>;
        }) => {
          const { durationMs } = (await probe()) as { durationMs: number };
          const frames = await (
            extractor.streamFrames as (
              options: {
                maxFrames: number;
                maxBytesPerFrame: number;
                deadlineMs: number;
              },
              durationMs: number,
            ) => Promise<Buffer[]>
          )(options, durationMs);
          let framesSeen = 0;
          for (let index = 0; index < frames.length; index += 1) {
            framesSeen += 1;
            if ((await options.onFrame(frames[index], index)) === 'stop') {
              return { framesSeen, stoppedEarly: true };
            }
          }
          if (framesSeen === 0) {
            throw new FrameUnavailableError();
          }
          return { framesSeen, stoppedEarly: false };
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
          priority?: number;
        },
        _actor?: unknown,
        options?: { createPendingLink?: boolean },
      ) => ({
        id: 'job-1',
        jobType: dto.jobType,
        inputDescriptor: dto.inputDescriptor,
        sourceType: dto.sourceType ?? EvidenceSourceType.VISION,
        sourceId: dto.sourceId ?? null,
        // Mirrors the real create: the persisted priority is the dto's,
        // defaulted exactly as the inference module defaults it.
        priority: dto.priority ?? DEFAULT_PRIORITY,
        // Two-phase creation: the opt-in lands the job in the NON-CLAIMABLE
        // PENDING_LINK state (the real module's contract), so the mock must
        // report it — the service gates its compensation on exactly this.
        status:
          options?.createPendingLink === true
            ? InferenceJobStatus.PENDING_LINK
            : InferenceJobStatus.QUEUED,
        locationId: dto.locationId ?? null,
        unitId: dto.unitId ?? null,
        deviceId: dto.deviceId ?? null,
        sessionId: dto.sessionId ?? null,
      }),
    ),
    // PENDING_LINK → QUEUED CAS, run only after the link committed.
    publishPendingLinkJob: jest.fn(async (_t: string, jobId: string) => ({
      id: jobId,
      jobType: InferenceJobType.PRODUCT_RECOGNITION,
      sourceType: EvidenceSourceType.VISION,
      priority: DEFAULT_PRIORITY,
      status: InferenceJobStatus.QUEUED,
    })),
    // Crash-window discovery seam: no unlinked job by default.
    findByIdempotencyKey: jest.fn(async () => null),
    findById: jest.fn(async () => ({
      id: 'job-1',
      jobType: InferenceJobType.PRODUCT_RECOGNITION,
      sourceType: EvidenceSourceType.VISION,
      priority: DEFAULT_PRIORITY,
      status: InferenceJobStatus.QUEUED,
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
  const configured: Record<string, string | undefined> = {
    VIDEO_MAX_UPLOAD_BYTES: overrides.maxUploadBytes,
    VIDEO_MAX_SCREENING_DURATION_MS: overrides.maxScreeningDurationMs,
    VIDEO_MAX_SCREENING_FRAMES: overrides.maxScreeningFrames,
    VIDEO_SCREENING_TIMEOUT_MS: overrides.screeningTimeoutMs,
    VIDEO_UNSAFE_ALLOW_UNSCREENED_UPLOADS: overrides.allowUnscreenedUploads,
    // Policy gate OPEN by default so the suite reaches the code behind it.
    // 'testMediaIngestEnabled' in overrides is checked (not ??) so a test
    // can drive an EXPLICIT undefined — the "flag absent" case.
    VIDEO_TEST_MEDIA_INGEST_ENABLED:
      'testMediaIngestEnabled' in overrides
        ? overrides.testMediaIngestEnabled
        : 'true',
    NODE_ENV: 'nodeEnv' in overrides ? overrides.nodeEnv : 'test',
  };
  const config = {
    get: (key: string) => configured[key],
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

  it('skips the media write with a controlled 409 when the locked media-write claim observes a committed delete', async () => {
    // Shrinks the delete/put race window: a DELETE that completed while
    // the upload was still screening in memory has already run its prefix
    // cleanup — writing the media NOW would recreate bytes under a prefix
    // whose delete caller was told cleanup completed. The advisory-locked
    // claim (same per-asset lock as softDelete) catches that BEFORE the
    // put: no byte is written, no publish is attempted, and the caller
    // gets the same controlled 409 as a lost publish CAS.
    const { service, storage, repository } = buildService({
      repository: {
        beginMediaWriteUnderLock: jest.fn(async () => 'deleted' as const),
      },
    });
    await expect(
      service.upload(TENANT, uploadFile(), { ...ATTEST }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(storage.put).not.toHaveBeenCalled();
    expect(repository.transitionStatus).not.toHaveBeenCalled();
    expect(storage.deletePrefix).not.toHaveBeenCalled();
    // Nothing to resolve: the claim was never taken, so the durable state
    // stays NULL (no media write was ever attempted) and a delete may
    // record its completion.
    expect(repository.resolveMediaWrite).not.toHaveBeenCalled();
  });

  it('claims the media write under the lock BETWEEN the in-memory screen and the put, then resolves it SUCCEEDED before the publish CAS', async () => {
    const { service, storage, repository } = buildService();
    await service.upload(TENANT, uploadFile(), { ...ATTEST });
    const claimOrder = (repository.beginMediaWriteUnderLock as jest.Mock).mock
      .invocationCallOrder[0];
    const putOrder = (storage.put as jest.Mock).mock.invocationCallOrder[0];
    const resolveOrder = (repository.resolveMediaWrite as jest.Mock).mock
      .invocationCallOrder[0];
    const publishOrder = (repository.transitionStatus as jest.Mock).mock
      .invocationCallOrder[0];
    expect(claimOrder).toBeLessThan(putOrder);
    // The put RETURNED before the state was resolved...
    expect(putOrder).toBeLessThan(resolveOrder);
    // ...and the resolution lands BEFORE the publish CAS, which can LOSE
    // to a concurrent delete — folding it into the CAS would leave the
    // state PENDING exactly when a delete is waiting to learn it drained.
    expect(resolveOrder).toBeLessThan(publishOrder);
    expect(repository.resolveMediaWrite).toHaveBeenCalledWith(
      TENANT,
      'asset-1',
      'SUCCEEDED',
    );
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
    // Text screening cannot inspect pixels and never certifies a clip:
    // nothing reaches storage unless the operator explicitly declared the
    // staged clip's frames carry no payment-card/credential content.
    const { service, storage, repository } = buildService();
    for (const value of ['', 'false', 'TRUE ']) {
      await expect(
        service.upload(TENANT, uploadFile(), {
          ...ATTEST,
          attestNoSensitiveContent: value,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    await expect(
      service.upload(TENANT, uploadFile(), {} as typeof ATTEST),
    ).rejects.toBeInstanceOf(BadRequestException);
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

  it('resolves the media-write claim FAILED when the put throws, BEFORE the compensating removal and the FAILED transition', async () => {
    // The claim must not be left PENDING on a write that will never land:
    // every DELETE (fresh or replayed) withholds its media-removal
    // completion while the state is PENDING, so an unresolved failure
    // would be a permanently outstanding drain obligation for bytes that
    // do not exist.
    const put = jest.fn(async () => {
      throw new VideoStorageOperationError();
    });
    const { service, repository, storage } = buildService({ storage: { put } });
    await expect(
      service.upload(TENANT, uploadFile(), { ...ATTEST }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(repository.resolveMediaWrite).toHaveBeenCalledWith(
      TENANT,
      'asset-1',
      'FAILED',
    );
    const resolveOrder = (repository.resolveMediaWrite as jest.Mock).mock
      .invocationCallOrder[0];
    expect(resolveOrder).toBeGreaterThan(
      (put as jest.Mock).mock.invocationCallOrder[0],
    );
    expect(resolveOrder).toBeLessThan(
      (storage.deletePrefix as jest.Mock).mock.invocationCallOrder[0],
    );
    expect(resolveOrder).toBeLessThan(
      (repository.transitionStatus as jest.Mock).mock.invocationCallOrder[0],
    );
  });

  it('never lets a media-write resolution failure mask the storage error the caller must see', async () => {
    // Best effort on the failing path: the durable FAILED row below is the
    // operator-facing evidence, and the swallowed cost is honest (the
    // state stays PENDING, so DELETE keeps reporting cleanup as pending
    // instead of falsely recording a completion).
    const { service } = buildService({
      storage: {
        put: jest.fn(async () => {
          throw new VideoStorageOperationError();
        }),
      },
      repository: {
        resolveMediaWrite: jest.fn(async () => {
          throw new Error('db down');
        }),
      },
    });
    await expect(
      service.upload(TENANT, uploadFile(), { ...ATTEST }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
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

describe('VideoAssetsService.upload controlled test-media policy gate', () => {
  // THE authorization for a Phase 10 ingest. The strategy this suite pins:
  // a quiet OCR result is NOT proof a clip is safe (rotated, blurred,
  // stylized, occluded or low-quality digits defeat recognition), so
  // storage is authorized by the POLICY GATE — controlled internal test
  // media, explicit audited operator attestations, a non-production
  // runtime opted in by configuration — and text screening only ever
  // REJECTS on top of it.
  const RECOGNIZER_SAYS_NOTHING = {
    recognize: jest.fn(async () => 'aisle four shelf camera'),
  };

  it('refuses uploads with a controlled 503 when the gate flag is ABSENT — a quiet recognizer authorizes nothing', async () => {
    const { service, repository, storage, extractor, recognizer } =
      buildService({
        testMediaIngestEnabled: undefined,
        recognizer: { ...RECOGNIZER_SAYS_NOTHING },
      });
    const error: Error = await service
      .upload(TENANT, uploadFile(), { ...ATTEST })
      .then(() => {
        throw new Error('expected rejection');
      })
      .catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(error.message).toContain('VIDEO_TEST_MEDIA_INGEST_ENABLED');
    expect(error.message).toContain('CONTROLLED INTERNAL TEST MEDIA');
    // The refusal never suggests screening could substitute for the gate.
    expect(error.message).not.toMatch(/\bsafe\b|verified|card-free/i);
    // Refused BEFORE the row commit, any decode, any recognition, any byte.
    expect(repository.createAsset).not.toHaveBeenCalled();
    expect(extractor.inspectBuffer).not.toHaveBeenCalled();
    expect(recognizer.recognize).not.toHaveBeenCalled();
    expect(storage.put).not.toHaveBeenCalled();
  });

  it.each(['false', 'FALSE', '1', '', 'yes', 'enabled'])(
    'keeps the gate CLOSED (503, nothing persisted) for the flag value %p',
    async (testMediaIngestEnabled) => {
      const { service, repository, storage, extractor } = buildService({
        testMediaIngestEnabled,
      });
      await expect(
        service.upload(TENANT, uploadFile(), { ...ATTEST }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(repository.createAsset).not.toHaveBeenCalled();
      expect(extractor.inspectBuffer).not.toHaveBeenCalled();
      expect(storage.put).not.toHaveBeenCalled();
    },
  );

  it.each(['TRUE', 'True', ' true ', 'true\n'])(
    'NORMALIZES the flag: %p opens the gate under a non-production runtime',
    async (testMediaIngestEnabled) => {
      // Codex P2: the gate used to compare the RAW value against 'true', so
      // a development deployment configured with `=TRUE` booted fine, wired
      // up the real screening tooling, and then 503'd every single upload —
      // a config typo that looks like an outage. The flag is now read
      // through the codebase's ONE helper (isEnvFlagEnabled: trimmed,
      // case-folded, fail-closed on anything else), the same way every
      // other flag in this module is read.
      const { service, storage } = buildService({
        testMediaIngestEnabled,
        nodeEnv: 'development',
      });
      const asset = await service.upload(TENANT, uploadFile(), { ...ATTEST });
      expect((asset as { status: VideoAssetStatus }).status).toBe(
        VideoAssetStatus.QUARANTINED,
      );
      expect(storage.put).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['TRUE', ' true '])(
    'a normalized flag value %p still cannot open the gate in production',
    async (testMediaIngestEnabled) => {
      const { service, repository, storage } = buildService({
        testMediaIngestEnabled,
        nodeEnv: 'production',
      });
      await expect(
        service.upload(TENANT, uploadFile(), { ...ATTEST }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(repository.createAsset).not.toHaveBeenCalled();
      expect(storage.put).not.toHaveBeenCalled();
    },
  );

  it('raises the gate and tooling 503s with the EXACT messages the pre-buffer guard exports', async () => {
    // The gate runs in two places — the route guard (before the multipart
    // body is read) and this defense-in-depth service check — and they must
    // be indistinguishable from the outside. The service now IMPORTS the
    // guard's constants instead of holding a second copy of each string, so
    // the two can no longer drift apart.
    const closed = buildService({ testMediaIngestEnabled: undefined });
    await expect(
      closed.service.upload(TENANT, uploadFile(), { ...ATTEST }),
    ).rejects.toThrow(TEST_MEDIA_GATE_CLOSED_MESSAGE);
    const untooled = buildService({
      extractor: { readsRealBytes: false },
    });
    await expect(
      untooled.service.upload(TENANT, uploadFile(), { ...ATTEST }),
    ).rejects.toThrow(SCREENING_TOOLING_UNAVAILABLE_MESSAGE);
  });

  it.each(['production', undefined])(
    'DEFENSE IN DEPTH: the gate stays CLOSED under NODE_ENV=%s even with the flag true',
    async (nodeEnv) => {
      // Startup validation already refuses the flag outside
      // development/test; the service re-checks so a config that somehow
      // carries true in production still ingests nothing.
      const { service, repository, storage, extractor, recognizer } =
        buildService({
          testMediaIngestEnabled: 'true',
          nodeEnv,
          recognizer: { ...RECOGNIZER_SAYS_NOTHING },
        });
      const error: Error = await service
        .upload(TENANT, uploadFile(), { ...ATTEST })
        .then(() => {
          throw new Error('expected rejection');
        })
        .catch((caught: Error) => caught);
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect(error.message).toContain('CONTROLLED INTERNAL TEST MEDIA');
      expect(repository.createAsset).not.toHaveBeenCalled();
      expect(extractor.inspectBuffer).not.toHaveBeenCalled();
      expect(recognizer.recognize).not.toHaveBeenCalled();
      expect(storage.put).not.toHaveBeenCalled();
    },
  );

  it.each(['development', 'test'])(
    'proceeds under NODE_ENV=%s with the flag true and EVERY attestation present',
    async (nodeEnv) => {
      const { service, storage } = buildService({
        testMediaIngestEnabled: 'true',
        nodeEnv,
      });
      const asset = await service.upload(TENANT, uploadFile(), { ...ATTEST });
      expect((asset as { status: VideoAssetStatus }).status).toBe(
        VideoAssetStatus.QUARANTINED,
      );
      expect(storage.put).toHaveBeenCalledTimes(1);
    },
  );

  it.each(ATTESTATION_FIELDS)(
    'refuses with a controlled 400 and persists NOTHING when %s is missing or not "true"',
    async (field) => {
      for (const dto of [
        { ...ATTEST, [field]: 'false' },
        { ...ATTEST, [field]: '' },
        (() => {
          const partial = { ...ATTEST } as Record<string, string>;
          delete partial[field];
          return partial as typeof ATTEST;
        })(),
      ]) {
        const { service, repository, storage, extractor, recognizer } =
          buildService({ recognizer: { ...RECOGNIZER_SAYS_NOTHING } });
        const error: Error = await service
          .upload(TENANT, uploadFile(), dto as typeof ATTEST)
          .then(() => {
            throw new Error('expected rejection');
          })
          .catch((caught: Error) => caught);
        expect(error).toBeInstanceOf(BadRequestException);
        expect(error.message).toContain(field);
        // Refused BEFORE any row, decode, recognition, or byte — and a
        // recognizer that would have found nothing cannot substitute for
        // the missing declaration.
        expect(repository.createAsset).not.toHaveBeenCalled();
        expect(extractor.inspectBuffer).not.toHaveBeenCalled();
        expect(recognizer.recognize).not.toHaveBeenCalled();
        expect(storage.put).not.toHaveBeenCalled();
      }
    },
  );

  it('still REJECTS an OCR detection with the gate open and every attestation present', async () => {
    // The gate authorizes the ingest; screening still rejects on top of it.
    const pan = '4111 1111 1111 1111';
    const { service, repository, storage } = buildService({
      recognizer: {
        recognize: jest.fn(async () => `PAY CARD ${pan} OK`),
      },
    });
    const error: Error = await service
      .upload(TENANT, uploadFile(), { ...ATTEST })
      .then(() => {
        throw new Error('expected rejection');
      })
      .catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.message).not.toContain('4111');
    expect(storage.put).not.toHaveBeenCalled();
    const [, , , data] = repository.transitionStatus.mock
      .calls[0] as unknown as [
      string,
      string,
      VideoAssetStatus[],
      { status: VideoAssetStatus; errorCode: string },
    ];
    expect(data.status).toBe(VideoAssetStatus.REJECTED);
    expect(data.errorCode).toBe('PRESTORE_SCREENING_REJECTED');
  });

  it('audits the ingest authorization HONESTLY: the policy gate and the operator declarations, never a safety finding', async () => {
    // The persisted create reason must say what is true — accepted under
    // the controlled test-media policy with the operator's attestations —
    // and must claim NOTHING about the content having been verified.
    let createReason: string | undefined;
    const createAsset = jest.fn(
      async (
        _t: string,
        data: unknown,
        build: (a: unknown) => { reason?: string },
      ) => {
        const created = assetRow({
          ...(data as Record<string, unknown>),
          status: VideoAssetStatus.PENDING_MEDIA,
        });
        createReason = build(created).reason;
        return created;
      },
    );
    const { service } = buildService({ repository: { createAsset } });
    await service.upload(TENANT, uploadFile(), { ...ATTEST });
    expect(createReason).toContain('controlled test-media policy gate');
    for (const field of ATTESTATION_FIELDS) {
      expect(createReason).toContain(field);
    }
    // No safety/verification claim of any shape.
    expect(createReason).not.toMatch(
      /\bsafe\b|verified|card-free|screened clean|proves/i,
    );
    // And it says plainly that screening cannot certify the clip.
    expect(createReason).toContain('can only reject');
  });
});

describe('VideoAssetsService.upload pre-storage frame screening', () => {
  it('screens EVERY decoded source frame through OCR from the IN-MEMORY buffer: a 10 s 30 fps clip OCRs ALL 300 frames', async () => {
    // Codex P1 "screen every source frame before storing the video": the
    // fps=1 sample dropped the frames between one-second ticks, so a PAN
    // visible only between samples passed and the container persisted.
    // The mandatory pre-storage screen now decodes EVERY source frame in
    // ONE exhaustive streamFrames pass and OCRs each unique frame —
    // no sampling of any kind. Each frame's recognized text runs through
    // the fused sensitive-text predicate, and only a clean, COMPLETE pass
    // reaches durable storage. The session is closed.
    const { service, repository, storage, extractor, recognizer, inspectClose } =
      buildService({
        extractor: {
          // A 10 s 30 fps clip decodes to 300 distinct source frames.
          streamFrames: jest.fn(async () =>
            Array.from({ length: 300 }, (_, index) =>
              Buffer.from(`source-frame-${index}`),
            ),
          ),
        },
      });
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
    // ONE exhaustive streaming pass carrying the configured frame budget,
    // the derived per-frame byte budget, AND the remaining slice of the
    // upload-wide screening deadline (default 30 s).
    expect(extractor.streamFrames).toHaveBeenCalledTimes(1);
    const streamOptions = (extractor.streamFrames as jest.Mock).mock
      .calls[0][0] as {
      maxFrames: number;
      maxBytesPerFrame: number;
      deadlineMs: number;
      onFrame: unknown;
    };
    expect(streamOptions.maxFrames).toBe(900);
    expect(streamOptions.maxBytesPerFrame).toBe(
      PRESTORE_SCREENING_MAX_FRAME_BYTES,
    );
    expect(streamOptions.deadlineMs).toBeGreaterThan(0);
    expect(streamOptions.deadlineMs).toBeLessThanOrEqual(30_000);
    expect(typeof streamOptions.onFrame).toBe('function');
    // ALL 300 decoded (byte-distinct) frames OCR'd — not 10 one-second
    // samples, not 6 sparse previews.
    expect(recognizer.recognize).toHaveBeenCalledTimes(300);
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

  it('requires and screens at least TWO frames for a 1.9 s clip (completeness floor: every STARTED second)', async () => {
    // ceil(1900/1000) = 2 started seconds → a floor of 2 frames, both
    // delivered by the single exhaustive pass and both OCR'd.
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
    expect(extractor.streamFrames).not.toHaveBeenCalled();
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
    // fps 20 × 45 s = 900 estimated frames — exactly the default frame
    // budget, so the pre-decode gate passes and the whole clip screens.
    const { service, storage, recognizer } = buildService({
      maxScreeningDurationMs: '60000',
      extractor: {
        probe: jest.fn(async () => ({
          durationMs: 45_000,
          width: 1280,
          height: 720,
          fps: 20,
        })),
      },
    });
    await service.upload(TENANT, uploadFile(), { ...ATTEST });
    // The default mock delivers the 45-frame floor stream (one distinct
    // frame per started second), every frame OCR'd before the media write.
    expect(recognizer.recognize).toHaveBeenCalledTimes(45);
    expect(storage.put).toHaveBeenCalledTimes(1);
  });

  it('rejects a clip whose ESTIMATED frame count exceeds the screening frame budget BEFORE any decode (audited 400)', async () => {
    // The exhaustive screen decodes EVERY source frame, so the probe's
    // own ceil(fps × duration) estimate — here 30 s × 60 fps = 1800 >
    // the default 900 — already proves the clip cannot be screened
    // inside the budget: audited PENDING_MEDIA → REJECTED with the
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
            durationMs: 30_000,
            width: 1280,
            height: 720,
            fps: 60,
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
      'exceeds the Phase 10 screening frame budget',
    );
    // Refused before ANY frame extraction or OCR.
    expect(extractor.streamFrames).not.toHaveBeenCalled();
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
    expect(auditReason).toContain('VIDEO_MAX_SCREENING_FRAMES');
    expect(auditReason).toContain('1800');
  });

  it('honors a configured VIDEO_MAX_SCREENING_FRAMES above the estimate (no pre-gate rejection)', async () => {
    // 30 s × 60 fps = 1800 estimated frames passes a raised 2000 budget.
    const { service, storage, recognizer } = buildService({
      maxScreeningFrames: '2000',
      extractor: {
        probe: jest.fn(async () => ({
          durationMs: 30_000,
          width: 1280,
          height: 720,
          fps: 60,
        })),
      },
    });
    await service.upload(TENANT, uploadFile(), { ...ATTEST });
    // The default mock delivers the 30-frame floor stream; the point here
    // is that the pre-gate did not fire and the screen detected nothing
    // (which rejects nothing — the policy gate is what allowed the store).
    expect(recognizer.recognize).toHaveBeenCalledTimes(30);
    expect(storage.put).toHaveBeenCalledTimes(1);
  });

  it('rejects with the SAME audited frame-budget 400 when the exhaustive decode exceeds the budget (FrameCountExceededError)', async () => {
    // VFR clips can decode to MORE frames than ceil(fps × duration)
    // estimated — the adapter's controlled count verdict lands on the
    // same audited fail-closed rejection as the pre-decode gate.
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
          streamFrames: jest.fn(async () => {
            throw new FrameCountExceededError();
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
    expect(error.message).toContain(
      'exceeds the Phase 10 screening frame budget',
    );
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
    expect(auditReason).toContain('VIDEO_MAX_SCREENING_FRAMES');
    expect(auditReason).toContain('exhaustive decode');
  });

  it('sha256-dedupes byte-identical frames before OCR: 300 frames with 3 unique payloads → 3 recognitions', async () => {
    // Identical bytes ⇒ identical pixels ⇒ identical OCR verdict, so a
    // static scene collapses massively WITHOUT weakening the screen —
    // every unique frame is still recognized exactly once.
    const { service, storage, recognizer } = buildService({
      extractor: {
        streamFrames: jest.fn(async () =>
          Array.from({ length: 300 }, (_, index) =>
            Buffer.from(`unique-${index % 3}`),
          ),
        ),
      },
    });
    await service.upload(TENANT, uploadFile(), { ...ATTEST });
    expect(recognizer.recognize).toHaveBeenCalledTimes(3);
    expect(storage.put).toHaveBeenCalledTimes(1);
  });

  it('attributes a deduped hit to the FIRST frame index carrying those bytes', async () => {
    // Frames 0..4 share one benign payload; frames 5..299 share the
    // PAN-bearing payload. Dedupe recognizes each payload once (2 OCR
    // calls total) and the audited index must be 5 — the FIRST frame
    // carrying the hit bytes, not whichever duplicate was screened.
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
    const { service, repository, storage, recognizer } = buildService({
      extractor: {
        streamFrames: jest.fn(async () =>
          Array.from({ length: 300 }, (_, index) =>
            Buffer.from(index < 5 ? 'static-scene' : 'pan-scene'),
          ),
        ),
      },
      recognizer: {
        recognize: jest.fn(async (frame: Buffer) =>
          frame.toString('utf8') === 'pan-scene'
            ? `PAY CARD ${pan} OK`
            : 'aisle four',
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
    expect(recognizer.recognize).toHaveBeenCalledTimes(2);
    expect(auditReason).toContain('frame 5');
    expect(auditReason).not.toContain('4111');
    expect(storage.put).not.toHaveBeenCalled();
    const [, , , data] = repository.transitionStatus.mock
      .calls[0] as unknown as [
      string,
      string,
      VideoAssetStatus[],
      { status: VideoAssetStatus; errorCode: string },
    ];
    expect(data.status).toBe(VideoAssetStatus.REJECTED);
    expect(data.errorCode).toBe('PRESTORE_SCREENING_REJECTED');
  });

  it('fails CLOSED (400, incomplete frame coverage) when the exhaustive decode yields fewer frames than started seconds', async () => {
    // Codex P1 "fail closed when no frame can be screened" — generalized:
    // a full decode of any real clip yields at least one frame per
    // started second, so a stream below that floor (here 4 of 10) proves
    // the clip was NOT exhaustively screened and is refused exactly like
    // an unscreened upload.
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
          streamFrames: jest.fn(async () =>
            Array.from({ length: 4 }, (_, index) =>
              Buffer.from(`frame-${index}`),
            ),
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
    // The 4 frames that DID arrive were screened as they streamed (the
    // count is only knowable once the stream ends), but a short stream is
    // still refused wholesale — screening 4 of 10 required frames removes
    // nothing and stores nothing.
    expect(recognizer.recognize).toHaveBeenCalledTimes(4);
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
          streamFrames: jest.fn(async () => {
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
          streamFrames: jest.fn(async () => {
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
    // The PAN sits in FRAME 3 of the decoded stream; the recorded index
    // identifies that frame within the exhaustive pass.
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
    // Only WHICH frame of the decoded stream tripped the screen is
    // recorded.
    expect(auditReason).toContain('frame 3');
    expect(auditReason).toContain('decoded source frame stream');
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
    // retry — a pending "nothing detected" verdict is replaced by the
    // same fail-closed contract as any other screening-infrastructure
    // trouble.
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
          streamFrames: async (options: {
            onFrame: (frame: Buffer, index: number) => Promise<'continue' | 'stop'>;
          }) => {
            for (let index = 0; index < 10; index += 1) {
              await options.onFrame(Buffer.from(`frame-${index}`), index);
            }
            return { framesSeen: 10, stoppedEarly: false };
          },
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

  it('bounds the WHOLE screen with ONE upload-wide deadline: an expiry mid-stream stops the recognizer and rejects 400 with nothing stored', async () => {
    // Codex P1 "bound the total OCR screening time": the sequential
    // per-frame loop could otherwise spend a full recognizer timeout on
    // EACH of up to VIDEO_MAX_SCREENING_FRAMES frames (900 × 30 s = 7.5
    // hours). ONE absolute deadline, fixed at screening start, covers the
    // decode AND every recognition; the callback re-checks it before each
    // recognizer call and abandons the rest of the stream.
    let clock = 1_700_000_000_000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => clock);
    try {
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
      const {
        service,
        repository,
        storage,
        extractor,
        recognizer,
        inspectClose,
      } = buildService({
        screeningTimeoutMs: '5000',
        extractor: {
          streamFrames: jest.fn(async () =>
            Array.from({ length: 300 }, (_, index) =>
              Buffer.from(`slow-frame-${index}`),
            ),
          ),
        },
        recognizer: {
          // Each recognition burns 2 s of the 5 s upload-wide budget.
          recognize: jest.fn(async () => {
            clock += 2000;
            return 'aisle four';
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
      expect(error.message).toContain('screening time budget');
      // Three recognitions fit (t=0, 2000, 4000); the fourth frame is
      // checked at t=6000 — past the 5 s deadline — so the recognizer is
      // NEVER called again and the remaining 296 frames are abandoned.
      expect(recognizer.recognize).toHaveBeenCalledTimes(3);
      // The decode carried the SAME aggregate budget, not a per-frame one.
      expect(
        (
          (extractor.streamFrames as jest.Mock).mock.calls[0][0] as {
            deadlineMs: number;
          }
        ).deadlineMs,
      ).toBe(5000);
      // Fail closed: nothing durably stored, session closed, terminal
      // REJECTED claim with the module's stable pre-storage code.
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
      expect(auditReason).toContain('VIDEO_SCREENING_TIMEOUT_MS');
      expect(auditReason).toContain('NOT screened end to end');
      // An unfinished screen is never recorded as a pass.
      expect(auditReason).not.toMatch(/\bsafe\b|verified|card-free/i);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('rejects fail-closed (400) when the DECODE itself outlives the deadline (ScreeningDeadlineExceededError)', async () => {
    // The adapter kills a wedged decode and reports the controlled
    // deadline error; the service treats it as the same fail-closed
    // rejection as an expiry it observed itself — never infrastructure,
    // never a pass.
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
          streamFrames: jest.fn(async () => {
            throw new ScreeningDeadlineExceededError();
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
    expect(error.message).toContain('screening time budget');
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
    expect(auditReason).toContain('VIDEO_SCREENING_TIMEOUT_MS');
  });

  it('bounds the PROBE with the same upload-wide budget (the deadline the port actually receives)', async () => {
    // Codex P2: the probe spawns the same external tooling the decode
    // does, and it used to run unbudgeted — a wedged binary could hold the
    // request for the adapter's own command timeout ON TOP of the whole
    // screening allowance the audit promises. `options` is OPTIONAL on the
    // port, so nothing but this assertion can catch the wiring going away.
    const { service, extractor } = buildService({ screeningTimeoutMs: '1000' });
    await service.upload(TENANT, uploadFile(), { ...ATTEST });
    const [key, options] = (extractor.probe as jest.Mock).mock.calls[0] as [
      string,
      { deadlineMs: number } | undefined,
    ];
    expect(key).toBe('in-memory-upload');
    expect(options?.deadlineMs).toBeGreaterThan(0);
    expect(options?.deadlineMs).toBeLessThanOrEqual(1000);
    // The decode gets what is LEFT of the same absolute deadline.
    const decodeDeadline = (
      (extractor.streamFrames as jest.Mock).mock.calls[0][0] as {
        deadlineMs: number;
      }
    ).deadlineMs;
    expect(decodeDeadline).toBeLessThanOrEqual(options?.deadlineMs ?? 0);
  });

  it('rejects fail-closed (400, audited) when the PROBE outlives the deadline — never an uncontrolled 500', async () => {
    // The probe's ScreeningDeadlineExceededError has no branch in
    // mapPrestoreScreeningError, so letting it fall through would surface
    // the raw error as a 500. It is caught at the call site and lands on
    // the SAME audited fail-closed rejection as a decode expiry.
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
    const { service, repository, storage, extractor, recognizer } = buildService(
      {
        extractor: {
          probe: jest.fn(async () => {
            throw new ScreeningDeadlineExceededError();
          }),
        },
        repository: { transitionStatus },
      },
    );
    const error: Error = await service
      .upload(TENANT, uploadFile(), { ...ATTEST })
      .then(() => {
        throw new Error('expected rejection');
      })
      .catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.message).toContain('screening time budget');
    // Nothing was decoded, recognized, or stored.
    expect(extractor.streamFrames).not.toHaveBeenCalled();
    expect(recognizer.recognize).not.toHaveBeenCalled();
    expect(storage.put).not.toHaveBeenCalled();
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
    expect(auditReason).toContain('VIDEO_SCREENING_TIMEOUT_MS');
  });

  it('refuses BEFORE spawning the probe when the budget is already spent', async () => {
    // A degenerate/expired remaining budget reaches the port as a
    // non-positive deadline, which the adapter refuses without spawning —
    // the mock stands in for that contract, and the verdict is the same.
    const probe = jest.fn(async (_key: string, options?: { deadlineMs?: number }) => {
      if ((options?.deadlineMs ?? Infinity) <= 0) {
        throw new ScreeningDeadlineExceededError();
      }
      return { durationMs: 10_000, width: 1280, height: 720, fps: 30 };
    });
    const { service, storage } = buildService({
      screeningTimeoutMs: '1000',
      extractor: { probe },
    });
    const nowSpy = jest.spyOn(Date, 'now');
    const base = Date.now();
    // First call fixes the absolute deadline; every later reading is past it.
    nowSpy.mockReturnValueOnce(base).mockReturnValue(base + 5000);
    try {
      await expect(
        service.upload(TENANT, uploadFile(), { ...ATTEST }),
      ).rejects.toBeInstanceOf(BadRequestException);
    } finally {
      nowSpy.mockRestore();
    }
    expect((probe.mock.calls[0][1] as { deadlineMs: number }).deadlineMs).toBeLessThanOrEqual(0);
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('hands the streaming decode the configured budget, clamped to the adapter-enforceable ceiling', async () => {
    // The adapter clamps any deadline DOWN to its own 120 s ceiling and
    // never up, so a larger configured budget would be unenforceable at
    // the decode: the service clamps first, so what it audits is what is
    // enforced.
    const tight = buildService({ screeningTimeoutMs: '1000' });
    await tight.service.upload(TENANT, uploadFile(), { ...ATTEST });
    const tightDeadline = (
      (tight.extractor.streamFrames as jest.Mock).mock.calls[0][0] as {
        deadlineMs: number;
      }
    ).deadlineMs;
    expect(tightDeadline).toBeGreaterThan(0);
    expect(tightDeadline).toBeLessThanOrEqual(1000);

    const wide = buildService({ screeningTimeoutMs: '300000' });
    await wide.service.upload(TENANT, uploadFile(), { ...ATTEST });
    const wideDeadline = (
      (wide.extractor.streamFrames as jest.Mock).mock.calls[0][0] as {
        deadlineMs: number;
      }
    ).deadlineMs;
    expect(wideDeadline).toBeLessThanOrEqual(120_000);
    expect(wideDeadline).toBeGreaterThan(119_000);
  });

  it('does NOT apply the completeness floor to a stream that stopped EARLY on a detection', async () => {
    // An early stop legitimately screens fewer frames than the floor
    // requires (that IS the point of stopping), so the detection verdict
    // must stand on its own rather than being masked by an
    // "incomplete coverage" rejection.
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
    const { service, storage, recognizer } = buildService({
      // 10 s clip → a floor of 10 frames; the detection lands on frame 0,
      // so only ONE frame is ever seen.
      recognizer: {
        recognize: jest.fn(async () => 'PAY CARD 4111 1111 1111 1111 OK'),
      },
      repository: { transitionStatus },
    });
    await expect(
      service.upload(TENANT, uploadFile(), { ...ATTEST }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(recognizer.recognize).toHaveBeenCalledTimes(1);
    expect(auditReason).toContain('frame 0');
    expect(auditReason).not.toContain('incomplete frame coverage');
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
        idempotencyKey: 'op-1',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  describe('single-frame timestamp bounds on a 6000 ms video', () => {
    // The full acceptance matrix for `0 <= timestampMs < durationMs` on a
    // 6.0 s asset: the duration endpoint itself is EXCLUSIVE, and an
    // invalid value is a controlled 400 that never reaches the extractor —
    // never a silent clamp or fallback to 0.
    const buildSixSecondService = () =>
      buildService({
        repository: {
          findByIdInternal: jest.fn(async () => assetRow({ durationMs: 6000 })),
        },
      });

    it.each([[0], [2500], [5999]])(
      'accepts %d ms and extracts exactly that frame',
      async (timestampMs) => {
        const { service, extractor } = buildSixSecondService();
        await expect(
          service.extractFrames(TENANT, 'asset-1', {
            timestampMs,
            idempotencyKey: `op-ts-${timestampMs}`,
          }),
        ).resolves.toBeDefined();
        expect(extractor.extractFrameAt).toHaveBeenCalledTimes(1);
        expect(
          (extractor.extractFrameAt as jest.Mock).mock.calls[0][2],
        ).toBe(timestampMs);
      },
    );

    it.each([[6000], [7000], [-1]])(
      'rejects %d ms with a 400 and never invokes the extractor',
      async (timestampMs) => {
        const { service, extractor } = buildSixSecondService();
        await expect(
          service.extractFrames(TENANT, 'asset-1', {
            timestampMs,
            idempotencyKey: `op-ts-${timestampMs}`,
          }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(extractor.extractFrameAt).not.toHaveBeenCalled();
      },
    );

    it('rejects a NaN timestamp with a 400 and never invokes the extractor', async () => {
      // Defense in depth: the DTO transform maps blank strings to NaN and
      // @IsInt 400s them at the pipe, but the service must hold the same
      // line if a NaN ever reaches it — not coerce, not treat as 0.
      const { service, extractor } = buildSixSecondService();
      await expect(
        service.extractFrames(TENANT, 'asset-1', {
          timestampMs: Number.NaN,
          idempotencyKey: 'op-ts-nan',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(extractor.extractFrameAt).not.toHaveBeenCalled();
    });
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
        idempotencyKey: 'op-1',
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
      service.extractFrames(TENANT, 'asset-1', {
        timestampMs: 9_999,
        idempotencyKey: 'op-1',
      }),
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
      service.extractFrames(TENANT, 'asset-1', {
        timestampMs: 500,
        idempotencyKey: 'op-1',
      }),
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
      service.extractFrames(TENANT, 'asset-1', { idempotencyKey: 'op-1' }),
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
      service.extractFrames(TENANT, 'asset-1', { idempotencyKey: 'op-1' }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      service.createCrop(TENANT, 'asset-1', {
        timestampMs: 1000,
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        idempotencyKey: 'op-2',
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
      () => service.extractFrames(TENANT, 'asset-1', { idempotencyKey: 'op-1' }),
      () =>
        service.createCrop(TENANT, 'asset-1', {
          timestampMs: 1000,
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          idempotencyKey: 'op-2',
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
      idempotencyKey: 'op-1',
    });
    expect(artifact.artifactType).toBe(VideoArtifactType.CROP);
    const [, , , , , items] = repository.createArtifactsBatch.mock
      .calls[0] as unknown as [
      string,
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
    // DETERMINISTIC, CONTENT-ADDRESSED staging key: under the ASSET's
    // prefix, an operation directory derived from the request identity
    // (sha256 hex), then the artifact index AND the digest of the exact
    // bytes — never a random UUID (crash-recoverable staging).
    expect(items[0].storageKey).toMatch(stagedKeyShape());
    // The recorded checksum IS the digest the key embeds: the row can
    // never describe bytes other than the ones stored at its key.
    expect(items[0].storageKey).toContain(`/0-${items[0].checksumSha256.slice(0, 32)}.png`);
    expect(storage.put).toHaveBeenCalled();
  });

  it('publishes frames atomically and marks the asset READY in the same batch', async () => {
    const { service, repository } = buildService();
    const { asset, artifacts } = await service.extractFrames(TENANT, 'asset-1', {
      idempotencyKey: 'op-1',
    });
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
        idempotencyKey: 'op-1',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('KEEPS staged files when the atomic publish fails (nothing committed, no terminal verdict)', async () => {
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
        idempotencyKey: 'op-1',
      }),
    ).rejects.toThrow('db down');
    // FAIL CLOSED: a rival attempt of the same operation staged the SAME
    // deterministic keys and may still publish them, and the deletes
    // cannot run under the operation lock — so the file stays where an
    // identical retry overwrites it and asset deletion removes it.
    expect(storage.delete).not.toHaveBeenCalled();
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
        idempotencyKey: 'op-1',
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
    // The loser's staged file is KEPT: with deterministic keys it IS the
    // winner's committed file, and the P2002 rollback returned no
    // lock-ordered ownership verdict that could prove otherwise.
    expect(storage.delete).not.toHaveBeenCalled();
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
          // The recorded batch owns none of OUR staged keys (different
          // parameters, different operation prefix) — true surplus.
          committedStagedKeys: [],
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
    expect(call[4]).toBe('op-1');
    expect(call[8]).toBe(
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

  // The cleanup only ever runs on the one TERMINAL outcome (a replay: the
  // idempotency key is consumed, so no attempt of this operation can ever
  // publish these keys again), so these escalation pins are driven through
  // a replay whose committed batch does NOT own the staged keys.
  function replayWithSurplusStagedFiles() {
    return jest.fn(async () => ({
      asset: assetRow({ status: VideoAssetStatus.READY }),
      artifacts: [artifactRow()],
      replayed: true,
      requestFingerprint: cropFingerprint(cropDto),
      // The recorded batch owns NOTHING we staged — true surplus.
      committedStagedKeys: [],
    }));
  }

  it('retries a transient staged-file cleanup failure and still surfaces the result', async () => {
    // First delete throws, the retry succeeds: the cleanup hiccup was
    // transient and is NOT escalated — the replayed batch is returned.
    const del = jest
      .fn()
      .mockRejectedValueOnce(new Error('EBUSY'))
      .mockResolvedValueOnce(undefined);
    const { service } = buildService({
      storage: { delete: del },
      repository: {
        createArtifactsBatch: replayWithSurplusStagedFiles(),
      },
    });
    const result = await service.createCrop(TENANT, 'asset-1', {
      ...cropDto,
      idempotencyKey: 'op-1',
    });
    expect(result.replayed).toBe(true);
    expect(del).toHaveBeenCalledTimes(2);
  });

  it('escalates a PERSISTENT staged-file cleanup failure as 503 (bounded attempts)', async () => {
    // Both delete attempts failed: no row will ever reference the surplus
    // staged key (the operation is terminal), so silently succeeding would
    // strand orphaned media. The controlled 503 names the condition.
    const del = jest.fn(async () => {
      throw new Error('EACCES');
    });
    const { service } = buildService({
      storage: { delete: del },
      repository: {
        createArtifactsBatch: replayWithSurplusStagedFiles(),
      },
    });
    await expect(
      service.createCrop(TENANT, 'asset-1', {
        ...cropDto,
        idempotencyKey: 'op-1',
      }),
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
  // the artifact index AND the content digest, so an identical retry
  // re-puts identical bytes over the SAME keys (the adapter's temp+rename
  // put overwrites atomically) and committed rows record the deterministic
  // keys directly (no promotion step).
  const cropDto = { timestampMs: 1000, x: 0, y: 0, width: 10, height: 10 };
  const keyShape = stagedKeyShape();

  it('a retried identical request stages over the SAME keys after a simulated crash (put succeeded, batch never committed)', async () => {
    const createArtifactsBatch = jest
      .fn()
      .mockRejectedValueOnce(new Error('db crash'))
      .mockResolvedValueOnce({
        asset: assetRow({ status: VideoAssetStatus.READY }),
        artifacts: [artifactRow()],
        replayed: false,
        committedStagedKeys: [],
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

  it('two concurrent first attempts producing DIFFERENT bytes stage under DIFFERENT keys: neither can overwrite the other', async () => {
    // Codex P1: with the file named by its index alone, two first attempts
    // of the SAME operation wrote the SAME key before either reached the
    // publication lock (the lock cannot be held across file I/O — that is
    // the pool-exhaustion deadlock fixed last pass). The extractor port
    // promises nothing about byte-for-byte determinism, so attempt B could
    // overwrite the file while attempt A committed a checksum taken from
    // A's bytes. The key now embeds the digest OF THE BYTES, so differing
    // bytes simply cannot collide.
    const committed = new Set<string>();
    const chain = { tail: Promise.resolve() as Promise<unknown> };
    let publishes = 0;
    let releaseWinner: () => void = () => undefined;
    const winnerGate = new Promise<void>((resolve) => {
      releaseWinner = resolve;
    });
    const createArtifactsBatch = jest.fn(
      (
        _t: string,
        _id: string,
        _hash: string,
        _expected: unknown,
        _key: string | undefined,
        items: { storageKey: string }[],
      ) => {
        const next = chain.tail.then(async () => {
          publishes += 1;
          if (publishes === 1) {
            await winnerGate;
            for (const item of items) {
              committed.add(item.storageKey);
            }
            return {
              asset: assetRow({ status: VideoAssetStatus.READY }),
              artifacts: [artifactRow()],
              replayed: false,
              committedStagedKeys: [],
            };
          }
          return {
            asset: assetRow({ status: VideoAssetStatus.READY }),
            artifacts: [artifactRow()],
            replayed: true,
            requestFingerprint: cropFingerprint(cropDto),
            committedStagedKeys: items
              .map((item) => item.storageKey)
              .filter((key) => committed.has(key)),
          };
        });
        chain.tail = next.then(
          () => undefined,
          () => undefined,
        );
        return next;
      },
    );
    // A NON-deterministic extractor: each call encodes different bytes.
    let encodes = 0;
    const { service, storage } = buildService({
      repository: { createArtifactsBatch },
      extractor: {
        extractCrop: jest.fn(
          async (
            _k: string,
            _p: unknown,
            ts: number,
            box: { width: number; height: number },
          ) => {
            encodes += 1;
            return {
              data: Buffer.from(`encoder-output-${encodes}`),
              width: box.width,
              height: box.height,
              mimeType: 'image/png',
              timestampMs: ts,
            };
          },
        ),
      },
    });
    const dto = { ...cropDto, idempotencyKey: 'op-1' };
    const attempts = [
      service.createCrop(TENANT, 'asset-1', dto),
      service.createCrop(TENANT, 'asset-1', dto),
    ];
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(storage.put).toHaveBeenCalledTimes(2);
    releaseWinner();
    await Promise.all(attempts);
    const [keyA] = storage.put.mock.calls[0] as unknown as [string];
    const [keyB] = storage.put.mock.calls[1] as unknown as [string];
    // SAME operation directory (the lock's granularity), DIFFERENT files.
    expect(keyA.slice(0, keyA.lastIndexOf('/'))).toBe(
      keyB.slice(0, keyB.lastIndexOf('/')),
    );
    expect(keyA).not.toBe(keyB);
    expect(keyA).toMatch(keyShape);
    expect(keyB).toMatch(keyShape);
    // The committed key was never written twice, so the recorded checksum
    // still describes the bytes at it...
    const committedKey = [...committed][0];
    const writtenKeys = (storage.put.mock.calls as unknown as [string][]).map(
      ([key]) => key,
    );
    expect(writtenKeys.filter((key) => key === committedKey)).toHaveLength(1);
    // ...and the loser removed only its OWN surplus file.
    expect(storage.delete).toHaveBeenCalledTimes(1);
    expect(storage.delete).not.toHaveBeenCalledWith(committedKey);
  });

  it('identical bytes produce an IDENTICAL key whose overwrite is a no-op', async () => {
    // The other half of content addressing: a retry (or a rival attempt)
    // that encodes the SAME bytes lands on the SAME key with byte-identical
    // content, so the atomic temp+rename put changes nothing at all.
    const { service, storage } = buildService();
    const dto = { ...cropDto, idempotencyKey: 'op-1' };
    await service.createCrop(TENANT, 'asset-1', dto);
    await service.createCrop(TENANT, 'asset-1', dto);
    expect(storage.put).toHaveBeenCalledTimes(2);
    // Same key AND same payload — an overwrite that cannot change a byte.
    expect(storage.put.mock.calls[1]).toEqual(storage.put.mock.calls[0]);
  });

  it('a committed artifact’s recorded checksum matches the bytes stored at its key (by construction)', async () => {
    const { service, repository, storage } = buildService();
    await service.createCrop(TENANT, 'asset-1', {
      ...cropDto,
      idempotencyKey: 'op-1',
    });
    const [, , , , , items] = repository.createArtifactsBatch.mock
      .calls[0] as unknown as [
      string,
      string,
      string,
      unknown,
      string | undefined,
      { checksumSha256: string; storageKey: string }[],
    ];
    const [storageKey, data] = storage.put.mock.calls[0] as unknown as [
      string,
      Buffer,
    ];
    const digest = createHash('sha256').update(data).digest('hex');
    // The row's checksum IS the digest of the bytes that were written...
    expect(items[0].checksumSha256).toBe(digest);
    expect(items[0].storageKey).toBe(storageKey);
    // ...and the key NAMES that digest, so no other bytes can ever occupy
    // it: the row can never describe content other than what is stored.
    expect(storageKey).toContain(
      `/0-${digest.slice(0, STAGED_ARTIFACT_KEY_DIGEST_CHARS)}.png`,
    );
  });

  it('a replay returns the RECORDED artifacts, never a rival attempt’s re-encoded content', async () => {
    // The committed batch's key is content-addressed to the WINNER's bytes.
    // This attempt re-encodes differently, so its file is a different key
    // the publish reports as surplus: the committed file is untouched and
    // the recorded artifacts come back.
    const recorded = artifactRow({ id: 'artifact-committed' });
    const { service, storage } = buildService({
      extractor: {
        extractCrop: jest.fn(
          async (
            _k: string,
            _p: unknown,
            ts: number,
            box: { width: number; height: number },
          ) => ({
            data: Buffer.from('re-encoded-differently'),
            width: box.width,
            height: box.height,
            mimeType: 'image/png',
            timestampMs: ts,
          }),
        ),
      },
      repository: {
        createArtifactsBatch: jest.fn(async () => ({
          asset: assetRow({ status: VideoAssetStatus.READY }),
          artifacts: [recorded],
          replayed: true,
          requestFingerprint: cropFingerprint(cropDto),
          // The committed batch owns a DIFFERENT (winner-bytes) key.
          committedStagedKeys: [],
        })),
      },
    });
    const result = await service.createCrop(TENANT, 'asset-1', {
      ...cropDto,
      idempotencyKey: 'op-1',
    });
    expect(result.replayed).toBe(true);
    expect(result.artifact.id).toBe('artifact-committed');
    const [stagedKey] = storage.put.mock.calls[0] as unknown as [string];
    // Only our own surplus re-encode was removed.
    expect(storage.delete).toHaveBeenCalledTimes(1);
    expect(storage.delete).toHaveBeenCalledWith(stagedKey);
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

  it('a replay KEEPS staged keys the committed batch recorded (shared deterministic keys)', async () => {
    // A keyless identical retry (or a same-key race loser) stages over
    // the very keys the earlier committed batch recorded — deleting them
    // would destroy media that live artifact rows reference. The verdict
    // the locked publish transaction returned names them, and they stay.
    const { service, storage } = buildService({
      repository: {
        createArtifactsBatch: jest.fn(
          async (
            _t: string,
            _id: string,
            _hash: string,
            _expected: unknown,
            _key: string | undefined,
            items: { storageKey: string }[],
          ) => ({
            asset: assetRow({ status: VideoAssetStatus.READY }),
            artifacts: [artifactRow()],
            replayed: true,
            requestFingerprint: cropFingerprint(cropDto),
            committedStagedKeys: items.map((item) => item.storageKey),
          }),
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

describe('extraction operation lock (publication serialization, no nested transaction)', () => {
  // Codex P1 (round 1): staging keys are DETERMINISTIC per operation, so a
  // FAILING attempt could run its committed-owner lookup while the WINNING
  // attempt's artifact transaction was still uncommitted, observe no owner,
  // and delete the shared key — leaving append-only artifact rows whose
  // file is missing.
  // Codex P1 (round 2): the outer lock transaction that fixed that held a
  // pooled connection across the section's storage I/O while every DB call
  // inside it needed a SECOND one. The lock now lives INSIDE the
  // publication transaction: staging runs with NO transaction open, and
  // the committed-owner verdict is decided in the same locked transaction
  // as the publication decision.
  const cropDto = {
    timestampMs: 1000,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    // REQUIRED on every crop request (see the DTO): the key is the
    // operation's identity, so committed artifact files are never rewritten.
    idempotencyKey: 'op-1',
  };

  it('passes the SAME operation hash the deterministic staging keys are derived from to the publish transaction', async () => {
    const { service, repository, storage } = buildService();
    await service.createCrop(TENANT, 'asset-1', {
      ...cropDto,
      idempotencyKey: 'op-1',
    });
    const [tenantId, assetId, operationHash] = (
      repository.createArtifactsBatch as jest.Mock
    ).mock.calls[0] as unknown as [string, string, string];
    expect(tenantId).toBe(TENANT);
    expect(assetId).toBe('asset-1');
    const [stagedKey] = storage.put.mock.calls[0] as unknown as [string];
    // The lock's granularity IS the staging PREFIX: same hash, same
    // operation directory (the file name inside it is content-addressed,
    // which is deliberately finer than the lock — see the staging loop).
    expect(stagedKey).toMatch(
      new RegExp(
        `^${TENANT}/uuid-1/artifacts/${operationHash}/0-` +
          `[0-9a-f]{${STAGED_ARTIFACT_KEY_DIGEST_CHARS}}\\.png$`,
      ),
    );
  });

  it('stages with NO transaction open: every file write happens before the locked publish transaction starts', async () => {
    const events: string[] = [];
    const { service } = buildService({
      repository: {
        createArtifactsBatch: jest.fn(async () => {
          events.push('publish-tx');
          return {
            asset: assetRow({ status: VideoAssetStatus.READY }),
            artifacts: [artifactRow()],
            replayed: false,
            committedStagedKeys: [],
          };
        }),
      },
      storage: {
        put: jest.fn(async () => {
          events.push('put');
        }),
      },
    });
    await service.createCrop(TENANT, 'asset-1', cropDto);
    // No lock wrapper exists any more, so there is nothing that could hold
    // a transaction (and a pooled connection) across the put.
    expect(events).toEqual(['put', 'publish-tx']);
  });

  it('needs NO second DB call for the cleanup decision: the verdict rides the publish result', async () => {
    // The old cleanup issued its own root-client ownership query; inside a
    // held lock transaction that required a SECOND pooled connection —
    // the pool-exhaustion path Codex flagged. The verdict is now decided
    // inside the publish transaction and handed back with the outcome.
    const events: string[] = [];
    const { service, storage } = buildService({
      repository: {
        createArtifactsBatch: jest.fn(async () => {
          events.push('publish-tx');
          return {
            asset: assetRow({ status: VideoAssetStatus.READY }),
            artifacts: [artifactRow()],
            replayed: true,
            requestFingerprint: cropFingerprint(cropDto),
            committedStagedKeys: [],
          };
        }),
      },
      storage: {
        delete: jest.fn(async () => {
          events.push('delete');
        }),
      },
    });
    await service.createCrop(TENANT, 'asset-1', {
      ...cropDto,
      idempotencyKey: 'op-1',
    });
    // Exactly one DB round trip, then the deletes — no ownership query.
    expect(events).toEqual(['publish-tx', 'delete']);
    expect(storage.delete).toHaveBeenCalledTimes(1);
  });

  it('serializes two identical concurrent attempts on the publish transaction: the loser replays and both keep the shared files', async () => {
    // The regression this exists for: the loser must never observe "no
    // committed owner" for a key the winner is about to commit. The
    // verdict is computed INSIDE the winner-ordered locked transaction, so
    // the loser's answer already contains the winner's keys.
    const events: string[] = [];
    const committed = new Set<string>();
    const chain = { tail: Promise.resolve() as Promise<unknown> };
    let publishes = 0;
    let releaseWinner: () => void = () => undefined;
    const winnerGate = new Promise<void>((resolve) => {
      releaseWinner = resolve;
    });
    // Stands in for pg_advisory_xact_lock taken as the transaction's first
    // statement: publications for one operation hash run strictly serially.
    const createArtifactsBatch = jest.fn(
      (
        _t: string,
        _id: string,
        _hash: string,
        _expected: unknown,
        _key: string | undefined,
        items: { storageKey: string }[],
      ) => {
        const next = chain.tail.then(async () => {
          events.push('enter-tx');
          try {
            publishes += 1;
            if (publishes === 1) {
              // Still UNCOMMITTED here — the window in which an
              // unserialized loser used to delete the shared key.
              await winnerGate;
              for (const item of items) {
                committed.add(item.storageKey);
              }
              events.push('publish');
              return {
                asset: assetRow({ status: VideoAssetStatus.READY }),
                artifacts: [artifactRow()],
                replayed: false,
                committedStagedKeys: [],
              };
            }
            events.push('replay');
            return {
              asset: assetRow({ status: VideoAssetStatus.READY }),
              artifacts: [artifactRow()],
              replayed: true,
              requestFingerprint: cropFingerprint(cropDto),
              // Decided INSIDE this locked transaction, so it sees
              // everything committed before it.
              committedStagedKeys: items
                .map((item) => item.storageKey)
                .filter((key) => committed.has(key)),
            };
          } finally {
            events.push('exit-tx');
          }
        });
        chain.tail = next.then(
          () => undefined,
          () => undefined,
        );
        return next;
      },
    );
    const { service, storage } = buildService({
      repository: { createArtifactsBatch },
    });
    const dto = { ...cropDto, idempotencyKey: 'op-1' };
    const attempts = [
      service.createCrop(TENANT, 'asset-1', dto),
      service.createCrop(TENANT, 'asset-1', dto),
    ];
    // Staging is unserialized on purpose (identical bytes, identical keys,
    // atomic temp+rename put), so BOTH attempts may have staged already.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(storage.put).toHaveBeenCalledTimes(2);
    releaseWinner();
    const [winner, loser] = await Promise.all(attempts);

    expect(winner.replayed).toBe(false);
    expect(loser.replayed).toBe(true);
    // Strict serialization of the publications: they never interleave.
    expect(events).toEqual([
      'enter-tx',
      'publish',
      'exit-tx',
      'enter-tx',
      'replay',
      'exit-tx',
    ]);
    // The loser's verdict was decided after the winner committed, so the
    // shared deterministic keys were KEPT.
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('KEEPS staged files when the publication gives no terminal verdict (failed publish): nothing is deleted', async () => {
    // Fail closed. A rival attempt of the same operation may still publish
    // these very keys, and the deletes cannot run under the lock — so the
    // files stay at their deterministic keys (an identical retry
    // overwrites them, asset deletion removes the whole prefix).
    const { service, storage } = buildService({
      repository: {
        createArtifactsBatch: jest.fn(async () => {
          throw new Error('db down');
        }),
      },
    });
    await expect(service.createCrop(TENANT, 'asset-1', cropDto)).rejects.toThrow(
      'db down',
    );
    expect(storage.put).toHaveBeenCalledTimes(1);
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('KEEPS staged files when the status CAS is lost: a rival attempt could still publish these keys', async () => {
    const { service, storage } = buildService({
      repository: { createArtifactsBatch: jest.fn(async () => null) },
    });
    await expect(
      service.createCrop(TENANT, 'asset-1', cropDto),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('REMOVES staged files when DELETION won the publication race (terminal — no rival can ever publish them)', async () => {
    // Codex P1: extraction passed requireProcessable(), a DELETE then
    // soft-deleted the asset and removed its prefix, and these staging puts
    // RECREATED files underneath it. Keeping them (the fail-closed rule for
    // every other outcome) is wrong here: deletion is terminal, so no rival
    // attempt can ever publish them, and the delete may already have
    // recorded its mediaRemovedAt completion — the recreated media would
    // then have neither a live artifact row nor a pending cleanup marker.
    const { service, storage } = buildService({
      repository: {
        createArtifactsBatch: jest.fn(async () => 'parent-deleted' as const),
      },
    });
    await expect(
      service.createCrop(TENANT, 'asset-1', cropDto),
    ).rejects.toBeInstanceOf(ConflictException);
    const [stagedKey] = storage.put.mock.calls[0] as unknown as [string];
    expect(storage.delete).toHaveBeenCalledTimes(1);
    expect(storage.delete).toHaveBeenCalledWith(stagedKey);
  });

  it('never SWALLOWS a failed post-deletion cleanup: retryable 503 + a durable cleanup-obligation audit', async () => {
    // Same contract as the upload's compensating removal after a lost
    // publish CAS: one retry per file, then the obligation is recorded in
    // the audit trail and a retryable 503 propagates.
    const del = jest.fn(async () => {
      throw new Error('EACCES');
    });
    const { service, auditLog } = buildService({
      storage: { delete: del },
      repository: {
        createArtifactsBatch: jest.fn(async () => 'parent-deleted' as const),
      },
    });
    await expect(
      service.createCrop(TENANT, 'asset-1', cropDto),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    // One retry, then escalation — never an unbounded loop.
    expect(del).toHaveBeenCalledTimes(2);
    const [entry] = auditLog.record.mock.calls.at(-1) as unknown as [
      { entityId: string; reason: string },
    ];
    expect(entry.entityId).toBe('asset-1');
    expect(entry.reason).toContain('lost to a concurrent delete');
    expect(entry.reason).toContain('DELETE /video-assets/:id');
  });

  it('KEEPS staged files when the idempotency key belongs to another asset (key-conflict)', async () => {
    const { service, storage } = buildService({
      repository: {
        createArtifactsBatch: jest.fn(async () => 'key-conflict' as const),
      },
    });
    await expect(
      service.createCrop(TENANT, 'asset-1', {
        ...cropDto,
        idempotencyKey: 'op-1',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('surfaces a publish-transaction lock failure as a retryable 503, never an uncontrolled 500', async () => {
    const { service, storage } = buildService({
      repository: {
        createArtifactsBatch: jest.fn(async () => {
          throw Object.assign(new Error('Transaction API error'), {
            code: 'P2028',
          });
        }),
      },
    });
    await expect(
      service.createCrop(TENANT, 'asset-1', cropDto),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    // Nothing was published, and the staged file is kept (deterministic
    // key — the retry the 503 asks for overwrites it).
    expect(storage.delete).not.toHaveBeenCalled();
  });
});

describe('extraction idempotency key is REQUIRED', () => {
  // Codex P1: with no key the operation hash derived from the request
  // FINGERPRINT alone, so every later identical keyless request staged to
  // the very keys a committed append-only artifact row already recorded. If
  // the extractor's encoded bytes ever differed (adapter upgrade, any
  // nondeterministic port implementation) the second put rewrote the file
  // under a row that keeps its old checksum — silent lineage corruption.
  // The MVP fix is to REQUIRE the key on both extraction endpoints.
  const box = { timestampMs: 1000, x: 0, y: 0, width: 10, height: 10 };

  it('400s extract-frames with NO idempotencyKey, before anything is read, extracted, or staged', async () => {
    const { service, repository, extractor, storage } = buildService();
    await expect(
      service.extractFrames(TENANT, 'asset-1', {} as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    // Nothing was created OR staged: not even the replay lookup ran.
    expect(repository.findExtractionReplay).not.toHaveBeenCalled();
    expect(repository.findByIdInternal).not.toHaveBeenCalled();
    expect(repository.createArtifactsBatch).not.toHaveBeenCalled();
    expect(extractor.extractFrames).not.toHaveBeenCalled();
    expect(extractor.extractFrameAt).not.toHaveBeenCalled();
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('400s crops with NO idempotencyKey, before anything is read, extracted, or staged', async () => {
    const { service, repository, extractor, storage } = buildService();
    await expect(
      service.createCrop(TENANT, 'asset-1', { ...box } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repository.findExtractionReplay).not.toHaveBeenCalled();
    expect(repository.findByIdInternal).not.toHaveBeenCalled();
    expect(repository.createArtifactsBatch).not.toHaveBeenCalled();
    expect(extractor.extractCrop).not.toHaveBeenCalled();
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('explains WHY the key is required (the 400 names the artifact-file rewrite it prevents)', async () => {
    const { service } = buildService();
    const error: Error = await service
      .createCrop(TENANT, 'asset-1', { ...box } as never)
      .then(() => {
        throw new Error('expected rejection');
      })
      .catch((caught: Error) => caught);
    expect(error.message).toContain('idempotencyKey is required');
    expect(error.message).toContain('rewrite');
  });

  it('still SCREENS the required key: control characters and PAN-shaped keys are 400s', async () => {
    // Requiring the key must not weaken the opaque-key screening.
    const { service, repository } = buildService();
    const pan = ['4111', '1111', '1111', '1111'].join('_');
    for (const idempotencyKey of ['a\u0000b', pan]) {
      await expect(
        service.createCrop(TENANT, 'asset-1', { ...box, idempotencyKey }),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(repository.findExtractionReplay).not.toHaveBeenCalled();
  });

  it('derives the staging prefix from the KEY, so an identical request under a NEW key never lands on a committed batch’s artifact files', async () => {
    // The regression pin: same parameters, different key ⇒ different
    // operation hash ⇒ different staged files. Under the old keyless
    // derivation both requests shared one prefix and the second put
    // overwrote the first's committed artifact file.
    const stagedFor = async (idempotencyKey: string) => {
      const { service, storage } = buildService();
      await service.createCrop(TENANT, 'asset-1', { ...box, idempotencyKey });
      const [key] = storage.put.mock.calls[0] as unknown as [string];
      return key;
    };
    const first = await stagedFor('op-A');
    const second = await stagedFor('op-B');
    expect(first).toMatch(stagedKeyShape());
    expect(second).not.toBe(first);
  });

  it('keeps the FINGERPRINT in the hash: the same key with changed parameters stages under a DIFFERENT prefix', async () => {
    // What the fingerprint-guard 409 relies on — the diverged attempt must
    // never touch the committed attempt's files while the 409 is decided.
    const stagedFor = async (timestampMs: number) => {
      const { service, storage } = buildService();
      await service.createCrop(TENANT, 'asset-1', {
        ...box,
        timestampMs,
        idempotencyKey: 'op-1',
      });
      const [key] = storage.put.mock.calls[0] as unknown as [string];
      return key;
    };
    expect(await stagedFor(1000)).not.toBe(await stagedFor(2000));
  });

  it('a same-key REPLAY short-circuits before any put: the committed artifact file is never rewritten', async () => {
    const replayResult = {
      asset: assetRow({ status: VideoAssetStatus.READY }),
      artifacts: [artifactRow()],
      replayed: true as const,
      requestFingerprint: cropFingerprint(box),
    };
    const { service, storage, extractor, repository } = buildService({
      repository: {
        findExtractionReplay: jest.fn(async () => replayResult),
      },
    });
    const result = await service.createCrop(TENANT, 'asset-1', {
      ...box,
      idempotencyKey: 'op-1',
    });
    expect(result.replayed).toBe(true);
    expect(result.artifact).toEqual(replayResult.artifacts[0]);
    // The short-circuit is what protects the file: no decode, no put, no
    // second publish attempt.
    expect(extractor.extractCrop).not.toHaveBeenCalled();
    expect(storage.put).not.toHaveBeenCalled();
    expect(repository.createArtifactsBatch).not.toHaveBeenCalled();
  });

  it('409s the same key with CHANGED parameters (frames and crops alike)', async () => {
    const { service } = buildService({
      repository: {
        findExtractionReplay: jest.fn(async () => ({
          asset: assetRow({ status: VideoAssetStatus.READY }),
          artifacts: [artifactRow()],
          replayed: true as const,
          requestFingerprint: cropFingerprint(box),
        })),
      },
    });
    await expect(
      service.createCrop(TENANT, 'asset-1', {
        ...box,
        timestampMs: 2000, // changed
        idempotencyKey: 'op-1',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    const { service: frames } = buildService({
      repository: {
        findExtractionReplay: jest.fn(async () => ({
          asset: assetRow({ status: VideoAssetStatus.READY }),
          artifacts: [
            artifactRow({ artifactType: VideoArtifactType.FRAME, cropX: null }),
          ],
          replayed: true as const,
          requestFingerprint: framesFingerprint({ maxFrames: 5 }),
        })),
      },
    });
    await expect(
      frames.extractFrames(TENANT, 'asset-1', {
        maxFrames: 3, // changed
        idempotencyKey: 'op-1',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
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
          priority: DEFAULT_PRIORITY,
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
            priority: DEFAULT_PRIORITY,
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
          priority: DEFAULT_PRIORITY,
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
          priority: DEFAULT_PRIORITY,
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
          priority: DEFAULT_PRIORITY,
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
          // Defaulted priority — the retry below omits `priority`, which
          // resolves to exactly this value.
          priority: DEFAULT_PRIORITY,
        })),
      },
    });
    const result = await service.createInferenceJobFromCrop(TENANT, 'artifact-1', {
      jobType: InferenceJobType.PRODUCT_RECOGNITION,
    });
    expect(result.replayed).toBe(true);
    expect(inference.create).not.toHaveBeenCalled();
  });

  it('409s an already-linked replay that asks for a DIFFERENT priority', async () => {
    // Codex P2: the linked job was queued at the module default; a retry
    // asking for priority 1000 wants DIFFERENT queue behaviour and must
    // not be reported as a successful replay of the original job.
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
          priority: DEFAULT_PRIORITY,
        })),
      },
    });
    await expect(
      service.createInferenceJobFromCrop(TENANT, 'artifact-1', {
        priority: 1000,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(inference.create).not.toHaveBeenCalled();
    expect(repository.linkArtifactToInferenceJob).not.toHaveBeenCalled();
  });

  it('replays an already-linked crop when the retry resolves to the SAME priority (explicit or defaulted)', async () => {
    const build = () =>
      buildService({
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
            priority: DEFAULT_PRIORITY,
          })),
        },
      });
    // Explicitly asking for the value the job already carries...
    const explicit = build();
    await expect(
      explicit.service.createInferenceJobFromCrop(TENANT, 'artifact-1', {
        priority: DEFAULT_PRIORITY,
      }),
    ).resolves.toMatchObject({ replayed: true });
    // ...and omitting it (the request resolves to the same default).
    const defaulted = build();
    await expect(
      defaulted.service.createInferenceJobFromCrop(TENANT, 'artifact-1', {}),
    ).resolves.toMatchObject({ replayed: true });
  });

  it('never links a preclaimed job whose priority differs from the request', async () => {
    // Mirror of the already-linked guard inside jobMatchesCrop: a squatted
    // `video-crop:<id>` job matching everything EXCEPT priority does not
    // answer this request, so the one-shot link is never stamped.
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
            sourceType: EvidenceSourceType.VISION,
            sourceId: dto.sourceId ?? null,
            priority: DEFAULT_PRIORITY + 1, // the ONLY mismatch
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

  it('passes the RESOLVED priority to the inference create (the same value the replay matchers compare)', async () => {
    const { service, inference } = buildService();
    await service.createInferenceJobFromCrop(TENANT, 'artifact-1', {});
    const [, dto] = inference.create.mock.calls[0] as unknown as [
      string,
      { priority: number },
    ];
    expect(dto.priority).toBe(DEFAULT_PRIORITY);
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

  // Codex P1: the job used to commit QUEUED before the artifact link was
  // written in a SEPARATE transaction. A crash in between left claimable
  // work that no later asset DELETE could discover (it enumerates only jobs
  // reachable via VideoArtifact.inferenceJobId — the link that never
  // committed) and no retry could repair (the artifact 404s once its asset
  // is deleted). Two-phase creation closes it: PENDING_LINK → link →
  // publish.
  it('creates the job PENDING_LINK, links it, and only THEN publishes it QUEUED (strict ordering)', async () => {
    const { service, inference, repository } = buildService();
    const result = await service.createInferenceJobFromCrop(
      TENANT,
      'artifact-1',
      {},
      { id: 'u1', email: 'u@x.io' },
    );
    // Phase 1: the internal, service-only opt-in — no HTTP client can mint
    // a non-claimable job, and the queue claim (pinned to QUEUED) can never
    // hand a PENDING_LINK row to a worker.
    const [, , actorArg, options] = inference.create.mock
      .calls[0] as unknown as [
      string,
      unknown,
      unknown,
      { createPendingLink?: boolean },
    ];
    expect(options).toEqual({ createPendingLink: true });
    expect(actorArg).toEqual({ id: 'u1', email: 'u@x.io' });
    // Phase 2: published only AFTER the link transaction committed.
    expect(inference.publishPendingLinkJob).toHaveBeenCalledWith(
      TENANT,
      'job-1',
      { id: 'u1', email: 'u@x.io' },
    );
    const createOrder = (inference.create as jest.Mock).mock
      .invocationCallOrder[0];
    const linkOrder = (repository.linkArtifactToInferenceJob as jest.Mock).mock
      .invocationCallOrder[0];
    const publishOrder = (inference.publishPendingLinkJob as jest.Mock).mock
      .invocationCallOrder[0];
    expect(createOrder).toBeLessThan(linkOrder);
    expect(linkOrder).toBeLessThan(publishOrder);
    // The caller is handed the PUBLISHED row, never the PENDING_LINK one.
    expect(result.replayed).toBe(false);
    expect(result.job.status).toBe(InferenceJobStatus.QUEUED);
  });

  it("handles a 'not-pending' publish WITHOUT throwing, reporting the job's TRUE state", async () => {
    // 'not-pending' means already published (a replayed publish) or
    // cancelled by a concurrent asset delete — a controlled no-op, never an
    // error. The stale in-memory PENDING_LINK row must not be reported, so
    // the job is re-read.
    const { service, inference } = buildService({
      inference: {
        publishPendingLinkJob: jest.fn(async () => 'not-pending' as const),
        findById: jest.fn(async () => ({
          id: 'job-1',
          jobType: InferenceJobType.PRODUCT_RECOGNITION,
          sourceType: EvidenceSourceType.VISION,
          priority: DEFAULT_PRIORITY,
          status: InferenceJobStatus.CANCELLED,
        })),
      },
    });
    const result = await service.createInferenceJobFromCrop(
      TENANT,
      'artifact-1',
      {},
    );
    expect(inference.publishPendingLinkJob).toHaveBeenCalledTimes(1);
    expect(result.job.status).toBe(InferenceJobStatus.CANCELLED);
  });

  it('CANCELS instead of publishing when the crop artifact changed concurrently (linked to nothing)', async () => {
    const { service, inference } = buildService({
      repository: {
        linkArtifactToInferenceJob: jest.fn(async () => 'already-linked' as const),
        // Post-link re-read: still visible, but carrying NO link.
        findArtifactById: jest.fn(async () => artifactRow()),
      },
    });
    await expect(
      service.createInferenceJobFromCrop(TENANT, 'artifact-1', {}),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(inference.publishPendingLinkJob).not.toHaveBeenCalled();
    expect(inference.cancelOrphanedJob).toHaveBeenCalledWith(
      TENANT,
      'job-1',
      expect.any(String),
      undefined,
    );
  });

  it('CANCELS instead of publishing when the crop is linked to a DIFFERENT job', async () => {
    const { service, inference } = buildService({
      repository: {
        linkArtifactToInferenceJob: jest.fn(async () => 'already-linked' as const),
        findArtifactById: jest
          .fn()
          .mockResolvedValueOnce(artifactRow()) // initial resolve: unlinked
          .mockResolvedValueOnce(artifactRow({ inferenceJobId: 'job-other' })),
      },
      inference: {
        findById: jest.fn(async () => ({
          id: 'job-other',
          jobType: InferenceJobType.PRODUCT_RECOGNITION,
          sourceType: EvidenceSourceType.VISION,
          priority: DEFAULT_PRIORITY,
          status: InferenceJobStatus.QUEUED,
        })),
      },
    });
    const result = await service.createInferenceJobFromCrop(
      TENANT,
      'artifact-1',
      {},
    );
    expect(result.replayed).toBe(true);
    expect(result.job.id).toBe('job-other');
    // Our own PENDING_LINK row can never link now — it is retired, and the
    // winner's already-QUEUED job is not re-published.
    expect(inference.cancelOrphanedJob).toHaveBeenCalledWith(
      TENANT,
      'job-1',
      expect.any(String),
      undefined,
    );
    expect(inference.publishPendingLinkJob).not.toHaveBeenCalled();
  });

  it('never cancels a SQUATTED job on the crop-mismatch 409 (it is live work we do not own)', async () => {
    // create() replayed a pre-existing squatted job, so it is not
    // PENDING_LINK and is not ours to withdraw — the 409 stands and nothing
    // is published or cancelled.
    const { service, inference } = buildService({
      inference: {
        create: jest.fn(async () => ({
          id: 'job-foreign',
          jobType: InferenceJobType.PRODUCT_RECOGNITION,
          sourceType: EvidenceSourceType.VISION,
          priority: DEFAULT_PRIORITY,
          status: InferenceJobStatus.QUEUED,
          inputDescriptor: { cropArtifactId: 'someone-elses-crop' },
        })),
      },
    });
    await expect(
      service.createInferenceJobFromCrop(TENANT, 'artifact-1', {}),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(inference.publishPendingLinkJob).not.toHaveBeenCalled();
    expect(inference.cancelOrphanedJob).not.toHaveBeenCalled();
  });

  it('PUBLISHES-THEN-RETURNS an already-linked retry whose job never got published', async () => {
    // The ordinary retry path (the crop was linked before this call even
    // started): the first attempt committed its link and then died before
    // the publish CAS, so the link is correct but the job is still
    // unclaimable. The retry finishes the interrupted second phase rather
    // than reporting a PENDING_LINK job as successfully linked work — and
    // never creates a duplicate.
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
          sourceType: EvidenceSourceType.VISION,
          priority: DEFAULT_PRIORITY,
          status: InferenceJobStatus.PENDING_LINK,
        })),
      },
    });
    const result = await service.createInferenceJobFromCrop(
      TENANT,
      'artifact-1',
      {},
    );
    expect(result.replayed).toBe(true);
    expect(inference.create).not.toHaveBeenCalled();
    expect(inference.publishPendingLinkJob).toHaveBeenCalledWith(
      TENANT,
      'job-9',
      undefined,
    );
    expect(result.job.status).toBe(InferenceJobStatus.QUEUED);
  });

  it('does NOT re-publish an already-published linked job on a replay', async () => {
    // The seam is a no-op for anything that is not PENDING_LINK, so an
    // ordinary replay costs no extra queue-lifecycle write.
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
          sourceType: EvidenceSourceType.VISION,
          priority: DEFAULT_PRIORITY,
          status: InferenceJobStatus.QUEUED,
        })),
      },
    });
    await expect(
      service.createInferenceJobFromCrop(TENANT, 'artifact-1', {}),
    ).resolves.toMatchObject({ replayed: true });
    expect(inference.publishPendingLinkJob).not.toHaveBeenCalled();
  });

  it('PUBLISHES-THEN-RETURNS a replay whose winner linked but crashed before publishing', async () => {
    // The chosen behaviour for "a replayed crop whose job is still
    // PENDING_LINK": never report it as successfully linked work while it
    // is unclaimable — finish the winner's second phase instead (the CAS is
    // idempotent). Consistent with the module's other "a retry completes an
    // interrupted flow" idioms.
    const { service, inference } = buildService({
      repository: {
        linkArtifactToInferenceJob: jest.fn(async () => 'already-linked' as const),
        findArtifactById: jest
          .fn()
          .mockResolvedValueOnce(artifactRow())
          .mockResolvedValueOnce(artifactRow({ inferenceJobId: 'job-1' })),
      },
      inference: {
        findById: jest.fn(async () => ({
          id: 'job-1',
          jobType: InferenceJobType.PRODUCT_RECOGNITION,
          sourceType: EvidenceSourceType.VISION,
          priority: DEFAULT_PRIORITY,
          status: InferenceJobStatus.PENDING_LINK,
        })),
      },
    });
    const result = await service.createInferenceJobFromCrop(
      TENANT,
      'artifact-1',
      {},
    );
    expect(result.replayed).toBe(true);
    expect(inference.publishPendingLinkJob).toHaveBeenCalledWith(
      TENANT,
      'job-1',
      undefined,
    );
    expect(result.job.status).toBe(InferenceJobStatus.QUEUED);
    expect(inference.cancelOrphanedJob).not.toHaveBeenCalled();
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

  it('DISCOVERS the crop→job crash window by idempotency key and cancels the unpublished PENDING_LINK job', async () => {
    // Codex P1 regression pin. The job committed but the artifact link
    // never did, so `listLinkedInferenceJobs` cannot see it — its only
    // handle is the DETERMINISTIC `video-crop:<artifactId>` key. Two-phase
    // creation guarantees such a job is PENDING_LINK, i.e. NOT claimable,
    // and this sweep is what finally retires it.
    const findByIdempotencyKey = jest.fn(async () => ({
      id: 'job-orphan',
      status: InferenceJobStatus.PENDING_LINK,
    }));
    const { service, inference, repository, storage } = buildService({
      repository: {
        // No committed link exists — the crash window by construction.
        listLinkedInferenceJobs: jest.fn(async () => []),
        listCropArtifactIds: jest.fn(async () => ['artifact-1']),
      },
      inference: { findByIdempotencyKey },
    });
    await service.delete(TENANT, 'asset-1', { id: 'u1', email: 'u@x.io' });
    expect(repository.listCropArtifactIds).toHaveBeenCalledWith(
      TENANT,
      'asset-1',
    );
    expect(findByIdempotencyKey).toHaveBeenCalledWith(
      TENANT,
      'video-crop:artifact-1',
    );
    expect(inference.cancelOrphanedJob).toHaveBeenCalledWith(
      TENANT,
      'job-orphan',
      expect.stringContaining('deleted'),
      { id: 'u1', email: 'u@x.io' },
    );
    // Retirement still precedes the media removal.
    expect(
      (inference.cancelOrphanedJob as jest.Mock).mock.invocationCallOrder[0],
    ).toBeLessThan(
      (storage.deletePrefix as jest.Mock).mock.invocationCallOrder[0],
    );
  });

  it('cancels a linked job that is still PENDING_LINK (link committed, publish crashed)', async () => {
    // The other half of the two-phase crash window: the link committed but
    // the publish did not. PENDING_LINK is in the inference module's
    // CANCELLABLE set, so it retires exactly like a QUEUED job — never
    // merely audited as an unreachable orphan.
    const { service, inference, auditLog } = buildService({
      repository: {
        listLinkedInferenceJobs: jest.fn(async () => [
          { id: 'job-1', status: InferenceJobStatus.PENDING_LINK },
        ]),
      },
    });
    await service.delete(TENANT, 'asset-1');
    expect(inference.cancelOrphanedJob).toHaveBeenCalledWith(
      TENANT,
      'job-1',
      expect.stringContaining('deleted'),
      undefined,
    );
    expect(auditLog.record).not.toHaveBeenCalled();
  });

  it('visits a job found by BOTH discovery sources exactly once', async () => {
    // A crop whose link committed is reachable both ways; the sweep dedupes
    // by job id so a replay never double-cancels or double-audits.
    const { service, inference } = buildService({
      repository: {
        listLinkedInferenceJobs: jest.fn(async () => [
          { id: 'job-1', status: InferenceJobStatus.QUEUED },
        ]),
        listCropArtifactIds: jest.fn(async () => ['artifact-1']),
      },
      inference: {
        findByIdempotencyKey: jest.fn(async () => ({
          id: 'job-1',
          status: InferenceJobStatus.QUEUED,
        })),
      },
    });
    await service.delete(TENANT, 'asset-1');
    expect(inference.cancelOrphanedJob).toHaveBeenCalledTimes(1);
  });

  it('stays quiet when the key-discovered job is already TERMINAL (delete replay)', async () => {
    // An earlier delete attempt already cancelled the crash-window job —
    // replays must neither re-cancel it nor spam the orphan audit.
    const { service, inference, auditLog } = buildService({
      repository: {
        findByIdInternalIncludingDeleted: jest.fn(async () =>
          assetRow({ deletedAt: new Date() }),
        ),
        listLinkedInferenceJobs: jest.fn(async () => []),
        listCropArtifactIds: jest.fn(async () => ['artifact-1']),
      },
      inference: {
        findByIdempotencyKey: jest.fn(async () => ({
          id: 'job-orphan',
          status: InferenceJobStatus.CANCELLED,
        })),
      },
    });
    await expect(service.delete(TENANT, 'asset-1')).resolves.toEqual({
      deleted: true,
    });
    expect(inference.cancelOrphanedJob).not.toHaveBeenCalled();
    expect(auditLog.record).not.toHaveBeenCalled();
  });

  it('a delete that LOSES the soft-delete CAS re-reads the row: a stale NULL pre-read never stamps a completion over a PENDING write', async () => {
    // Codex P1. Two DELETEs overlap an upload: DELETE-A pre-reads
    // mediaWriteState = NULL, the upload then CLAIMS its put (PENDING),
    // DELETE-B wins the CAS and — reading inside its locked transaction —
    // correctly observes the pending write and withholds its completion
    // marker. DELETE-A gets null back from softDelete, and carrying its
    // STALE "decided" pre-read from there drained the (still empty) prefix
    // and RECORDED the exactly-once completion while the put was in
    // flight: a crash after those bytes landed left media behind a
    // completion marker with no discoverable obligation. The lost-CAS path
    // now re-reads the (already soft-deleted) row and recomputes from the
    // FRESH state.
    const findByIdInternalIncludingDeleted = jest
      .fn()
      // The PRE-READ: still live, no media write claimed yet.
      .mockResolvedValueOnce(
        assetRow({
          status: VideoAssetStatus.PENDING_MEDIA,
          mediaWriteState: null,
        }),
      )
      // The AUTHORITATIVE re-read after losing the CAS: the upload claimed
      // its put in between, and the winning delete is already committed.
      .mockResolvedValueOnce(
        assetRow({
          status: VideoAssetStatus.PENDING_MEDIA,
          deletedAt: new Date(),
          mediaRemovedAt: null,
          mediaWriteState: VideoMediaWriteState.PENDING,
        }),
      );
    const { service, storage, repository } = buildService({
      repository: {
        findByIdInternalIncludingDeleted,
        // Lost the CAS to the concurrent delete.
        softDelete: jest.fn(async () => null),
      },
    });
    await expect(service.delete(TENANT, 'asset-1')).resolves.toEqual({
      deleted: true,
    });
    expect(findByIdInternalIncludingDeleted).toHaveBeenCalledTimes(2);
    // The drain still runs (idempotent), the completion does NOT: the
    // obligation stays open and re-drainable, and the WINNER's own delete
    // audit already names it.
    expect(storage.deletePrefix).toHaveBeenCalledWith(`${TENANT}/uuid-1`);
    expect(repository.recordMediaRemovalCompleted).not.toHaveBeenCalled();
  });

  it('a lost-CAS delete whose FRESH row says the write RESOLVED records the completion exactly as before', async () => {
    // The re-read must not make the loser paranoid: SUCCEEDED/FAILED
    // provably means no bytes are in flight, so the completion is owed.
    for (const mediaWriteState of [
      VideoMediaWriteState.SUCCEEDED,
      VideoMediaWriteState.FAILED,
    ]) {
      const { service, repository } = buildService({
        repository: {
          findByIdInternalIncludingDeleted: jest
            .fn()
            .mockResolvedValueOnce(assetRow({ mediaWriteState: null }))
            .mockResolvedValueOnce(
              assetRow({
                deletedAt: new Date(),
                mediaRemovedAt: null,
                mediaWriteState,
              }),
            ),
          softDelete: jest.fn(async () => null),
        },
      });
      await service.delete(TENANT, 'asset-1');
      expect(repository.recordMediaRemovalCompleted).toHaveBeenCalledTimes(1);
    }
  });

  it('a lost-CAS re-read that finds NO row (or throws) FAILS CLOSED to undecided: no completion is recorded', async () => {
    // Unreadable state is never treated as "decided". Withholding a
    // completion is repairable (DELETE is idempotent and a later replay
    // records it once); recording one wrongly never is.
    for (const reReadable of [false, true]) {
      const { service, repository } = buildService({
        repository: {
          findByIdInternalIncludingDeleted: jest
            .fn()
            .mockResolvedValueOnce(assetRow({ mediaWriteState: null }))
            .mockImplementationOnce(async () => {
              if (reReadable) {
                throw new Error('db unreachable');
              }
              return null;
            }),
          softDelete: jest.fn(async () => null),
        },
      });
      await expect(service.delete(TENANT, 'asset-1')).resolves.toEqual({
        deleted: true,
      });
      expect(repository.recordMediaRemovalCompleted).not.toHaveBeenCalled();
    }
  });

  it('a fresh delete whose media write is UNDECIDED (PENDING) audits the cleanup as pending and records NO completion', async () => {
    // Codex P1: while the durable media-write state is PENDING an upload
    // has CLAIMED its put (under the same asset lock, before the put ran)
    // and has not resolved it — so bytes can still land just after this
    // cleanup. Stamping the exactly-once completion marker here would
    // record a cleanup as complete over a prefix the bytes had not even
    // reached, and (because the CAS is exactly-once) no later replay could
    // ever record the real one.
    let softDeleteEntry: { reason?: string } | undefined;
    const softDelete = jest.fn(
      async (
        _t: string,
        _id: string,
        build: (
          b: unknown,
          mediaAlreadyRemoved: boolean,
          mediaWriteUndecided: boolean,
        ) => unknown,
      ) => {
        const before = assetRow({
          status: VideoAssetStatus.PENDING_MEDIA,
          mediaWriteState: VideoMediaWriteState.PENDING,
        });
        softDeleteEntry = build(before, false, true) as { reason?: string };
        return {
          asset: before,
          mediaAlreadyRemoved: false,
          mediaWriteUndecided: true,
        };
      },
    );
    const { service, storage, repository } = buildService({
      repository: {
        findByIdInternalIncludingDeleted: jest.fn(async () =>
          assetRow({
            status: VideoAssetStatus.PENDING_MEDIA,
            mediaWriteState: VideoMediaWriteState.PENDING,
          }),
        ),
        softDelete,
      },
    });
    await expect(service.delete(TENANT, 'asset-1')).resolves.toEqual({
      deleted: true,
    });
    // The removal RUNS — only the completion evidence is withheld.
    expect(storage.deletePrefix).toHaveBeenCalledWith(`${TENANT}/uuid-1`);
    expect(repository.recordMediaRemovalCompleted).not.toHaveBeenCalled();
    // ...and the audit names the undecided write and the drain path.
    expect(softDeleteEntry?.reason).toContain('PENDING');
    expect(softDeleteEntry?.reason).toContain('UNDECIDED');
    expect(softDeleteEntry?.reason).toContain('mediaWriteState');
    expect(softDeleteEntry?.reason).toContain('replaying DELETE');
  });

  it('a DELETE REPLAY while the media write is still PENDING records NO completion either (the fix: durable observation, not deletedAt inference)', async () => {
    // THE Codex P1. The row is already soft-deleted, so the old rule
    // inferred "the staged write must have drained" and stamped the
    // completion immediately — but a put that claimed liveness BEFORE the
    // original soft-delete is still in flight, so the replay removed an
    // empty prefix, recorded completion, and only THEN did the bytes land.
    // Reading the durable state instead keeps the obligation open.
    const { service, storage, repository } = buildService({
      repository: {
        findByIdInternalIncludingDeleted: jest.fn(async () =>
          assetRow({
            status: VideoAssetStatus.PENDING_MEDIA,
            deletedAt: new Date(),
            mediaRemovedAt: null,
            mediaWriteState: VideoMediaWriteState.PENDING,
          }),
        ),
      },
    });
    await expect(service.delete(TENANT, 'asset-1')).resolves.toEqual({
      deleted: true,
    });
    // No second soft-delete, the drain still runs, no completion recorded.
    expect(repository.softDelete).not.toHaveBeenCalled();
    expect(storage.deletePrefix).toHaveBeenCalledWith(`${TENANT}/uuid-1`);
    expect(repository.recordMediaRemovalCompleted).not.toHaveBeenCalled();
  });

  it('a put that lands AFTER the delete leaves the obligation discoverable: the replay that sees the write RESOLVED drains and records completion exactly once', async () => {
    // The obligation is discharged by the idempotent DELETE replay once
    // the staged write resolved (here: SUCCEEDED — the bytes landed after
    // the first cleanup). Exactly one completion, and only after the drain.
    const { service, storage, repository } = buildService({
      repository: {
        findByIdInternalIncludingDeleted: jest.fn(async () =>
          assetRow({
            status: VideoAssetStatus.PENDING_MEDIA,
            deletedAt: new Date(),
            mediaRemovedAt: null,
            mediaWriteState: VideoMediaWriteState.SUCCEEDED,
          }),
        ),
      },
    });
    await expect(service.delete(TENANT, 'asset-1')).resolves.toEqual({
      deleted: true,
    });
    expect(repository.softDelete).not.toHaveBeenCalled();
    expect(storage.deletePrefix).toHaveBeenCalledWith(`${TENANT}/uuid-1`);
    expect(repository.recordMediaRemovalCompleted).toHaveBeenCalledTimes(1);
    expect(
      (repository.recordMediaRemovalCompleted as jest.Mock).mock
        .invocationCallOrder[0],
    ).toBeGreaterThan(
      (storage.deletePrefix as jest.Mock).mock.invocationCallOrder[0],
    );
  });

  it('a FAILED staged write is resolved too: the replay drains and records the completion', async () => {
    // The put threw, so nothing more can land — the obligation is
    // dischargeable exactly like a SUCCEEDED one.
    const { service, repository } = buildService({
      repository: {
        findByIdInternalIncludingDeleted: jest.fn(async () =>
          assetRow({
            status: VideoAssetStatus.FAILED,
            deletedAt: new Date(),
            mediaRemovedAt: null,
            mediaWriteState: VideoMediaWriteState.FAILED,
          }),
        ),
      },
    });
    await service.delete(TENANT, 'asset-1');
    expect(repository.recordMediaRemovalCompleted).toHaveBeenCalledTimes(1);
  });

  it('a row that never claimed a media write (state NULL) is decided: completion is recorded', async () => {
    // Rejected by the pre-storage screen before any put, or a pre-existing
    // row — either way no put was ever attempted, so nothing is in flight.
    let softDeleteEntry: { reason?: string } | undefined;
    const { service, repository } = buildService({
      repository: {
        findByIdInternalIncludingDeleted: jest.fn(async () =>
          assetRow({
            status: VideoAssetStatus.REJECTED,
            mediaWriteState: null,
          }),
        ),
        softDelete: jest.fn(
          async (
            _t: string,
            _id: string,
            build: (
              b: unknown,
              mediaAlreadyRemoved: boolean,
              mediaWriteUndecided: boolean,
            ) => unknown,
          ) => {
            const before = assetRow({
              status: VideoAssetStatus.REJECTED,
              mediaWriteState: null,
            });
            softDeleteEntry = build(before, false, false) as { reason?: string };
            return {
              asset: before,
              mediaAlreadyRemoved: false,
              mediaWriteUndecided: false,
            };
          },
        ),
      },
    });
    await service.delete(TENANT, 'asset-1');
    expect(softDeleteEntry?.reason).toContain('media cleanup pending');
    expect(softDeleteEntry?.reason).not.toContain('UNDECIDED');
    expect(repository.recordMediaRemovalCompleted).toHaveBeenCalledTimes(1);
  });

  it('a replayed DELETE records NOTHING a second time once the completion marker is claimed', async () => {
    // The marker CAS is the exactly-once authority: a further replay of
    // the drained staged upload finds it claimed and stays quiet.
    const { service, repository } = buildService({
      repository: {
        findByIdInternalIncludingDeleted: jest.fn(async () =>
          assetRow({
            status: VideoAssetStatus.PENDING_MEDIA,
            deletedAt: new Date(),
            mediaRemovedAt: new Date(),
            mediaWriteState: VideoMediaWriteState.SUCCEEDED,
          }),
        ),
      },
    });
    await service.delete(TENANT, 'asset-1');
    expect(repository.recordMediaRemovalCompleted).not.toHaveBeenCalled();
  });

  it('deleting a PUBLISHED (QUARANTINED) asset keeps the pending → completed behaviour unchanged', async () => {
    // The media write is RESOLVED (SUCCEEDED): no in-flight put can
    // follow, so the first delete both promises and records completion.
    let softDeleteEntry: { reason?: string } | undefined;
    const softDelete = jest.fn(
      async (
        _t: string,
        _id: string,
        build: (
          b: unknown,
          mediaAlreadyRemoved: boolean,
          mediaWriteUndecided: boolean,
        ) => unknown,
      ) => {
        const before = assetRow({ status: VideoAssetStatus.QUARANTINED });
        softDeleteEntry = build(before, false, false) as { reason?: string };
        return {
          asset: before,
          mediaAlreadyRemoved: false,
          mediaWriteUndecided: false,
        };
      },
    );
    const { service, repository } = buildService({
      repository: {
        findByIdInternalIncludingDeleted: jest.fn(async () =>
          assetRow({ status: VideoAssetStatus.QUARANTINED }),
        ),
        softDelete,
      },
    });
    await service.delete(TENANT, 'asset-1');
    expect(softDeleteEntry?.reason).toContain('media cleanup pending');
    expect(softDeleteEntry?.reason).not.toContain('STAGED upload');
    expect(repository.recordMediaRemovalCompleted).toHaveBeenCalledTimes(1);
  });

  it('a failed compensating cleanup still surfaces honestly: 503, no completion, and the replay can retry', async () => {
    // The soft-delete is durable but the prefix removal failed — the
    // completion stays unrecorded so the pending state remains true, and
    // the idempotent replay re-runs the same removal.
    const { service, repository } = buildService({
      repository: {
        findByIdInternalIncludingDeleted: jest.fn(async () =>
          assetRow({
            deletedAt: new Date(),
            mediaRemovedAt: null,
            mediaWriteState: VideoMediaWriteState.SUCCEEDED,
          }),
        ),
      },
      storage: {
        deletePrefix: jest.fn(async () => {
          throw new VideoStorageOperationError();
        }),
      },
    });
    await expect(
      service.delete(TENANT, 'asset-1'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(repository.recordMediaRemovalCompleted).not.toHaveBeenCalled();
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
