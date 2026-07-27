import { createHash, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AuditAction,
  InferenceJobType,
  VideoArtifactType,
  VideoAssetStatus,
  VideoCropReason,
} from '@prisma/client';
import {
  AuditActor,
  AuditEntry,
  AuditLogService,
  SYSTEM_ACTOR_EMAIL,
} from '../common/audit/audit-log.service';
import { InferenceJobsService } from '../inference/inference-jobs.service';
import { InferenceJobDetail } from '../inference/inference-jobs.repository';
import { PlatformModulesService } from '../platform-modules/platform-modules.service';
import { CreateInferenceJobFromCropDto } from './dto/create-inference-job-from-crop.dto';
import { CreateVideoCropDto } from './dto/create-video-crop.dto';
import {
  DEFAULT_FRAME_INTERVAL_MS,
  DEFAULT_MAX_FRAMES,
  ExtractFramesDto,
} from './dto/extract-frames.dto';
import { QueryVideoAssetsDto } from './dto/query-video-assets.dto';
import { UploadVideoAssetDto } from './dto/upload-video-asset.dto';
import {
  ExtractionFailedError,
  ExtractorUnavailableError,
  VideoFrameExtractorPort,
  VideoProbeResult,
} from './extraction/video-frame-extractor.port';
import {
  fileExtensionOf,
  filenameCarriesSensitiveContent,
  isAllowedVideoUpload,
  isUnsafeUploadFilename,
  looksLikeVideoContent,
  sanitizeOriginalFilename,
  VIDEO_ERROR_CODES,
} from './media-safety';
import { VideoStoragePort } from './storage/video-storage.port';
import {
  AssetReferenceRejection,
  VideoArtifactView,
  VideoAssetsRepository,
  VideoAssetView,
} from './video-assets.repository';

export const DEFAULT_MAX_UPLOAD_BYTES = 52_428_800; // 50 MiB — test clips only.

/**
 * Request-wide ceiling on decoded artifact bytes retained before the batch
 * persists — adapter-independent defense (the optional binary adapter also
 * enforces its own budget while looping).
 */
export const MAX_TOTAL_ARTIFACT_BYTES = 128 * 1024 * 1024;

/** Uploaded file shape (multer memory mode) — declared locally so the
 * service depends on the CONTRACT, not on multer types. */
export interface UploadedVideoFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

function prismaErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null
    ? String((error as { code?: unknown }).code ?? '')
    : undefined;
}

// eslint-disable-next-line no-control-regex -- matching control chars IS the guard
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/;

/** Reference ids must be opaque single-line values: a NUL would surface as
 * an uncontrolled Prisma 500 before the FK could reject it. */
function assertPlainId(field: string, value: string | undefined): void {
  if (value !== undefined && CONTROL_CHARACTERS.test(value)) {
    throw new BadRequestException(`${field} must not contain control characters`);
  }
}

/** Crop reason → default Phase 9 job type (closed 1:1 where one exists). */
const REASON_TO_JOB_TYPE: Partial<Record<VideoCropReason, InferenceJobType>> = {
  [VideoCropReason.SHELF_AUDIT]: InferenceJobType.SHELF_AUDIT,
  [VideoCropReason.OCR_REVIEW]: InferenceJobType.OCR_REVIEW,
  [VideoCropReason.VLM_REVIEW]: InferenceJobType.VLM_REVIEW,
};

@Injectable()
export class VideoAssetsService {
  private readonly maxUploadBytes: number;

  constructor(
    private readonly repository: VideoAssetsRepository,
    private readonly storage: VideoStoragePort,
    private readonly extractor: VideoFrameExtractorPort,
    private readonly inferenceJobsService: InferenceJobsService,
    private readonly platformModulesService: PlatformModulesService,
    private readonly auditLog: AuditLogService,
    config: ConfigService,
  ) {
    const configured = config.get<string>('VIDEO_MAX_UPLOAD_BYTES');
    const parsed = Number(configured);
    this.maxUploadBytes =
      Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_UPLOAD_BYTES;
  }

  private auditEntry(
    tenantId: string,
    actor: AuditActor | undefined,
    partial: Pick<
      AuditEntry,
      'action' | 'entityType' | 'entityId' | 'before' | 'after' | 'reason'
    >,
  ): AuditEntry {
    return {
      tenantId,
      actorId: actor?.id ?? null,
      actorEmail: actor?.email ?? SYSTEM_ACTOR_EMAIL,
      ...partial,
    };
  }

  async upload(
    tenantId: string,
    file: UploadedVideoFile | undefined,
    dto: UploadVideoAssetDto,
    actor?: AuditActor,
  ): Promise<VideoAssetView> {
    if (!file || !file.buffer || file.size === 0) {
      throw new BadRequestException('A video file part named "file" is required');
    }
    assertPlainId('locationId', dto.locationId);
    assertPlainId('unitId', dto.unitId);
    assertPlainId('deviceId', dto.deviceId);
    assertPlainId('sessionId', dto.sessionId);

    // Traversal-shaped names are REJECTED, not repaired (see media-safety).
    if (isUnsafeUploadFilename(file.originalname)) {
      throw new BadRequestException(
        'Filename is not accepted: path separators, traversal sequences, ' +
          'control characters, and hidden-file names are rejected',
      );
    }
    const sanitized = sanitizeOriginalFilename(file.originalname);
    // A filename is persisted verbatim-ish metadata: credential- or
    // payment-bearing names must never reach a database row. The RAW name
    // is screened with the filename-specific policy (separators normalized
    // away first), so "4111_1111_1111_1111.mp4" or "password_hunter2.mp4"
    // cannot smuggle a PAN or credential past the space/dash detectors.
    if (
      filenameCarriesSensitiveContent(file.originalname) ||
      filenameCarriesSensitiveContent(sanitized)
    ) {
      throw new BadRequestException(
        'Filename must not contain credential- or payment-bearing content',
      );
    }
    const extension = fileExtensionOf(sanitized);
    if (!extension || !isAllowedVideoUpload(extension, file.mimetype)) {
      throw new BadRequestException(
        'Unsupported upload type: only mp4, m4v, mov, webm, mkv, avi, and ' +
          'mpeg/mpg test videos are accepted',
      );
    }
    if (!looksLikeVideoContent(file.buffer, extension)) {
      throw new BadRequestException(
        'File content does not match the declared video container',
      );
    }
    // The multipart layer already enforces this limit; re-checking keeps the
    // invariant local (and covers any future non-multipart ingest path).
    if (file.size > this.maxUploadBytes || file.buffer.length > this.maxUploadBytes) {
      throw new PayloadTooLargeException(
        `Upload exceeds the configured limit of ${this.maxUploadBytes} bytes`,
      );
    }

    const checksumSha256 = createHash('sha256').update(file.buffer).digest('hex');
    // Server-generated key: tenant / random UUID / fixed name. The client's
    // filename NEVER participates (only its allowlisted extension).
    const storageKey = `${tenantId}/${randomUUID()}/original${extension}`;
    await this.storage.put(storageKey, file.buffer);
    let result: VideoAssetView | AssetReferenceRejection;
    try {
      result = await this.repository.createAsset(
        tenantId,
        {
          locationId: dto.locationId,
          unitId: dto.unitId,
          deviceId: dto.deviceId,
          sessionId: dto.sessionId,
          originalFilename: sanitized,
          mimeType: file.mimetype.toLowerCase(),
          sizeBytes: file.size,
          storageKey,
          checksumSha256,
          uploadedById: actor?.id,
        },
        (asset) =>
          this.auditEntry(tenantId, actor, {
            action: AuditAction.CREATE,
            entityType: 'VideoAsset',
            entityId: asset.id,
            after: asset,
            reason: 'Test video uploaded',
          }),
      );
    } catch (error) {
      // The DB row failed — never leave an orphaned file behind.
      await this.storage
        .deletePrefix(storageKey.slice(0, storageKey.lastIndexOf('/')))
        .catch(() => undefined);
      if (prismaErrorCode(error) === 'P2003') {
        throw new BadRequestException(
          'A referenced store, unit, device, or session does not exist in this tenant',
        );
      }
      throw error;
    }
    if (typeof result === 'string') {
      // Hierarchy rejection (same vocabulary as inference enqueue) — the
      // stored file must not outlive the rejected row.
      await this.storage
        .deletePrefix(storageKey.slice(0, storageKey.lastIndexOf('/')))
        .catch(() => undefined);
      throw new BadRequestException(this.referenceRejectionMessage(result, dto));
    }
    return result;
  }

  private referenceRejectionMessage(
    rejection: AssetReferenceRejection,
    dto: UploadVideoAssetDto,
  ): string {
    switch (rejection) {
      case 'location-not-found':
        return `Store "${dto.locationId}" not found`;
      case 'unit-not-found':
        return `Unit "${dto.unitId}" not found`;
      case 'unit-location-mismatch':
        return `Unit "${dto.unitId}" does not belong to store "${dto.locationId}"`;
      case 'device-not-found':
        return `Device "${dto.deviceId}" not found`;
      case 'device-unit-mismatch':
        return `Device "${dto.deviceId}" is not attached to unit "${dto.unitId}"`;
      case 'session-not-found':
        return `Session "${dto.sessionId}" not found`;
      case 'session-unit-mismatch':
        return `Session "${dto.sessionId}" is not on unit "${dto.unitId}"`;
      case 'session-location-mismatch':
        return `Session "${dto.sessionId}" is not in the asset's store`;
    }
  }

  async list(
    tenantId: string,
    query: QueryVideoAssetsDto,
  ): Promise<{
    items: VideoAssetView[];
    total: number;
    skip: number;
    take: number;
  }> {
    const skip = query.skip ?? 0;
    const take = query.take ?? 25;
    const { items, total } = await this.repository.list(tenantId, {
      status: query.status,
      sessionId: query.sessionId,
      locationId: query.locationId,
      skip,
      take,
    });
    return { items, total, skip, take };
  }

  async findById(tenantId: string, id: string): Promise<VideoAssetView> {
    const asset = await this.repository.findById(tenantId, id);
    if (!asset) {
      throw new NotFoundException(`Video asset "${id}" not found`);
    }
    return asset;
  }

  async listArtifacts(
    tenantId: string,
    assetId: string,
  ): Promise<VideoArtifactView[]> {
    await this.findById(tenantId, assetId); // 404 before listing
    return this.repository.listArtifacts(tenantId, assetId);
  }

  async findArtifactById(
    tenantId: string,
    artifactId: string,
  ): Promise<VideoArtifactView> {
    const artifact = await this.repository.findArtifactById(tenantId, artifactId);
    if (!artifact) {
      throw new NotFoundException(`Video artifact "${artifactId}" not found`);
    }
    return artifact;
  }

  /**
   * Probe the uploaded container and record its real metadata:
   * UPLOADED → VALIDATED (probe ok) or UPLOADED → REJECTED (unreadable).
   * Idempotent: an already VALIDATED/READY asset is returned unchanged.
   */
  async validate(
    tenantId: string,
    id: string,
    actor?: AuditActor,
  ): Promise<VideoAssetView> {
    const internal = await this.repository.findByIdInternal(tenantId, id);
    if (!internal) {
      throw new NotFoundException(`Video asset "${id}" not found`);
    }
    if (
      internal.status === VideoAssetStatus.VALIDATED ||
      internal.status === VideoAssetStatus.READY
    ) {
      return this.findById(tenantId, id);
    }
    if (internal.status !== VideoAssetStatus.UPLOADED) {
      throw new ConflictException(
        `Video asset is ${internal.status} and cannot be validated`,
      );
    }

    let probe: VideoProbeResult;
    try {
      probe = await this.extractor.probe(internal.storageKey);
    } catch (error) {
      if (error instanceof ExtractorUnavailableError) {
        throw new ServiceUnavailableException(error.message);
      }
      const rejected = await this.repository.transitionStatus(
        tenantId,
        id,
        [VideoAssetStatus.UPLOADED],
        {
          status: VideoAssetStatus.REJECTED,
          errorCode: VIDEO_ERROR_CODES.PROBE_FAILED,
          errorMessage: 'The file could not be read as a video',
        },
        (before, after) =>
          this.auditEntry(tenantId, actor, {
            action: AuditAction.UPDATE,
            entityType: 'VideoAsset',
            entityId: id,
            before,
            after,
            reason: 'Video validation failed (probe)',
          }),
      );
      if (rejected) {
        return rejected;
      }
      return this.findById(tenantId, id);
    }

    const validated = await this.repository.transitionStatus(
      tenantId,
      id,
      [VideoAssetStatus.UPLOADED],
      {
        status: VideoAssetStatus.VALIDATED,
        durationMs: probe.durationMs,
        width: probe.width,
        height: probe.height,
        fps: probe.fps,
      },
      (before, after) =>
        this.auditEntry(tenantId, actor, {
          action: AuditAction.UPDATE,
          entityType: 'VideoAsset',
          entityId: id,
          before,
          after,
          reason: 'Video validated (probed)',
        }),
    );
    // CAS lost to a concurrent transition — return the current state.
    return validated ?? this.findById(tenantId, id);
  }

  /**
   * Extract full frames (single timestamp, or interval sampling with a hard
   * cap) as FRAME artifacts, then mark the asset READY. Requires a
   * VALIDATED/READY asset (probe metadata bounds every timestamp); a FAILED
   * asset may retry (clears its error per the status/error CHECK).
   */
  async extractFrames(
    tenantId: string,
    id: string,
    dto: ExtractFramesDto,
    actor?: AuditActor,
  ): Promise<{ asset: VideoAssetView; artifacts: VideoArtifactView[] }> {
    const internal = await this.requireProcessable(tenantId, id);
    const probe = this.probeFromRow(internal);

    let images;
    try {
      if (dto.timestampMs !== undefined) {
        this.assertTimestampInRange(dto.timestampMs, probe.durationMs);
        images = [
          await this.extractor.extractFrameAt(
            internal.storageKey,
            probe,
            dto.timestampMs,
          ),
        ];
      } else {
        images = await this.extractor.extractFrames(internal.storageKey, probe, {
          intervalMs: dto.intervalMs ?? DEFAULT_FRAME_INTERVAL_MS,
          maxFrames: dto.maxFrames ?? DEFAULT_MAX_FRAMES,
          startMs: 0,
        });
      }
    } catch (error) {
      throw await this.mapExtractionError(tenantId, id, actor, error);
    }

    const { asset, artifacts } = await this.persistArtifactsBatch(
      tenantId,
      internal.storageKey,
      id,
      actor,
      images.map((image) => ({ artifactType: VideoArtifactType.FRAME, image })),
      'Frames extracted',
    );
    return { asset, artifacts };
  }

  /**
   * Manual crop: timestamp inside the probed duration, box inside the
   * probed dimensions — controlled 400s otherwise — then one CROP artifact
   * with an optional closed-vocabulary reason.
   */
  async createCrop(
    tenantId: string,
    id: string,
    dto: CreateVideoCropDto,
    actor?: AuditActor,
  ): Promise<{ asset: VideoAssetView; artifact: VideoArtifactView }> {
    const internal = await this.requireProcessable(tenantId, id);
    const probe = this.probeFromRow(internal);
    this.assertTimestampInRange(dto.timestampMs, probe.durationMs);
    if (dto.x + dto.width > probe.width || dto.y + dto.height > probe.height) {
      throw new BadRequestException(
        `Crop box exceeds the video dimensions (${probe.width}x${probe.height})`,
      );
    }

    let image;
    try {
      image = await this.extractor.extractCrop(
        internal.storageKey,
        probe,
        dto.timestampMs,
        { x: dto.x, y: dto.y, width: dto.width, height: dto.height },
      );
    } catch (error) {
      throw await this.mapExtractionError(tenantId, id, actor, error);
    }

    const { asset, artifacts } = await this.persistArtifactsBatch(
      tenantId,
      internal.storageKey,
      id,
      actor,
      [
        {
          artifactType: VideoArtifactType.CROP,
          image,
          reason: dto.reason,
          crop: { x: dto.x, y: dto.y, width: dto.width, height: dto.height },
        },
      ],
      'Crop extracted',
    );
    return { asset, artifact: artifacts[0] };
  }

  /**
   * Crop artifact → Phase 9 inference job. The descriptor references the
   * artifact/asset BY OPAQUE ID only (screened again by the Phase 9 media
   * policy — no storage keys, paths, or URLs can pass). One-shot: the
   * artifact link is stamped once; retries and races replay the linked job.
   */
  async createInferenceJobFromCrop(
    tenantId: string,
    artifactId: string,
    dto: CreateInferenceJobFromCropDto,
    actor?: AuditActor,
  ): Promise<{
    artifact: VideoArtifactView;
    job: InferenceJobDetail;
    replayed: boolean;
  }> {
    // This route is gated by `video-ingest` for its own callers; job
    // creation is an `inference` capability — so re-check `inference`
    // FIRST (before the already-linked replay too), or a tenant with
    // inference disabled could keep creating or reading jobs through the
    // video back door. Fails closed with the SAME auditable semantics as
    // ModuleEnabledGuard: the denial is recorded as ACCESS_DENIED before
    // the generic 403, so crossing a disabled module boundary is never
    // invisible in the authorization audit trail.
    const inferenceEnabled = await this.platformModulesService.isEnabledForTenant(
      tenantId,
      'inference',
    );
    if (!inferenceEnabled) {
      await this.auditLog.record(
        this.auditEntry(tenantId, actor, {
          action: AuditAction.ACCESS_DENIED,
          entityType: 'VideoArtifact',
          entityId: artifactId,
          reason:
            'Inference-job creation denied: module "inference" is not ' +
            'enabled for this tenant',
        }),
      );
      throw new ForbiddenException(
        'The inference module is not enabled for this tenant, so an ' +
          'inference job cannot be created from this crop',
      );
    }

    const artifact = await this.findArtifactById(tenantId, artifactId);
    if (artifact.artifactType !== VideoArtifactType.CROP) {
      throw new ConflictException(
        'Only CROP artifacts can create inference jobs',
      );
    }
    if (artifact.inferenceJobId) {
      const job = await this.inferenceJobsService.findById(
        tenantId,
        artifact.inferenceJobId,
      );
      return { artifact, job, replayed: true };
    }
    const asset = await this.repository.findById(tenantId, artifact.videoAssetId);
    if (!asset) {
      throw new ConflictException(
        'The source video asset was deleted; this crop cannot create a job',
      );
    }

    const jobType =
      dto.jobType ??
      (artifact.reason ? REASON_TO_JOB_TYPE[artifact.reason] : undefined) ??
      InferenceJobType.PRODUCT_RECOGNITION;

    const job = await this.inferenceJobsService.create(
      tenantId,
      {
        jobType,
        locationId: asset.locationId ?? undefined,
        unitId: asset.unitId ?? undefined,
        deviceId: asset.deviceId ?? undefined,
        sessionId: asset.sessionId ?? undefined,
        priority: dto.priority,
        sourceId: `video-crop:${artifact.id}`,
        // SAFE descriptor: opaque ids and integers only — never bytes,
        // storage keys, paths, or URLs (Phase 9 screens it again).
        inputDescriptor: {
          artifactType: 'VIDEO_CROP',
          videoAssetId: artifact.videoAssetId,
          cropArtifactId: artifact.id,
          timestampMs: artifact.timestampMs,
          cropBox: {
            x: artifact.cropX,
            y: artifact.cropY,
            width: artifact.cropWidth,
            height: artifact.cropHeight,
          },
          ...(asset.deviceId ? { sourceDeviceId: asset.deviceId } : {}),
          ...(asset.locationId ? { locationRef: asset.locationId } : {}),
          ...(asset.unitId ? { unitRef: asset.unitId } : {}),
        },
        // ALWAYS the derived key (never client-tunable): at-least-once
        // retries replay THIS crop's job and can never collide with another
        // crop's key.
        idempotencyKey: `video-crop:${artifact.id}`,
      },
      actor,
    );
    // Idempotency keys are tenant-scoped and first-writer-wins: a caller
    // holding inference:manage could have squatted `video-crop:<id>` with a
    // direct Phase 9 create, making our create REPLAY that unrelated job.
    // Never link a job whose descriptor does not reference exactly this
    // crop — lineage integrity beats availability here.
    const descriptor = job.inputDescriptor as Record<string, unknown> | null;
    if (
      !descriptor ||
      descriptor['cropArtifactId'] !== artifact.id ||
      descriptor['videoAssetId'] !== artifact.videoAssetId
    ) {
      throw new ConflictException(
        'The idempotency key for this crop is already used by an unrelated ' +
          'inference job; the crop was not linked',
      );
    }

    const linked = await this.repository.linkArtifactToInferenceJob(
      tenantId,
      artifactId,
      job.id,
      (before, after) =>
        this.auditEntry(tenantId, actor, {
          action: AuditAction.UPDATE,
          entityType: 'VideoArtifact',
          entityId: artifactId,
          before,
          after,
          reason: `Inference job created from crop (${jobType})`,
        }),
    );
    if (linked === 'already-linked' || linked === null) {
      // Concurrent creation stamped first — replay ITS link.
      const current = await this.findArtifactById(tenantId, artifactId);
      if (current.inferenceJobId) {
        const existing = await this.inferenceJobsService.findById(
          tenantId,
          current.inferenceJobId,
        );
        return { artifact: current, job: existing, replayed: true };
      }
      throw new ConflictException('The crop artifact changed concurrently');
    }
    return { artifact: linked, job, replayed: false };
  }

  /**
   * Delete: the DURABLE, AUDITED soft-delete commits FIRST; only then are
   * the local files removed. Filesystem removal can therefore never precede
   * the audited transition — a crash between the two leaves a soft-deleted
   * row with orphaned files, and because the endpoint is IDEMPOTENT over
   * already-deleted assets (it re-runs the file cleanup and succeeds), a
   * retry completes the removal. Metadata is KEPT (audit lineage; artifacts
   * are append-only) — only the media bytes are removed. A deleted asset
   * 404s on every ordinary read.
   */
  async delete(
    tenantId: string,
    id: string,
    actor?: AuditActor,
  ): Promise<{ deleted: true }> {
    const internal = await this.repository.findByIdInternalIncludingDeleted(
      tenantId,
      id,
    );
    if (!internal) {
      throw new NotFoundException(`Video asset "${id}" not found`);
    }
    if (!internal.deletedAt) {
      const marked = await this.repository.softDelete(
        tenantId,
        id,
        (before) =>
          this.auditEntry(tenantId, actor, {
            action: AuditAction.DELETE,
            entityType: 'VideoAsset',
            entityId: id,
            before,
            reason: 'Video asset deleted (local media removed, metadata kept)',
          }),
      );
      if (!marked) {
        // Lost a race with another delete — the row is durably deleted;
        // fall through to the idempotent file cleanup.
      }
    }
    // The asset directory holds the original AND every extracted artifact.
    const assetDir = internal.storageKey.slice(
      0,
      internal.storageKey.lastIndexOf('/'),
    );
    await this.storage.deletePrefix(assetDir);
    return { deleted: true };
  }

  // -------------------------------------------------------------------------

  private async requireProcessable(tenantId: string, id: string) {
    const internal = await this.repository.findByIdInternal(tenantId, id);
    if (!internal) {
      throw new NotFoundException(`Video asset "${id}" not found`);
    }
    if (
      internal.status !== VideoAssetStatus.VALIDATED &&
      internal.status !== VideoAssetStatus.READY &&
      internal.status !== VideoAssetStatus.FAILED
    ) {
      throw new ConflictException(
        `Video asset is ${internal.status}; validate it before extraction`,
      );
    }
    return internal;
  }

  /** Probe metadata comes from the validated row — never re-guessed. */
  private probeFromRow(row: {
    durationMs: number | null;
    width: number | null;
    height: number | null;
    fps: number | null;
  }): VideoProbeResult {
    if (!row.durationMs || !row.width || !row.height || !row.fps) {
      throw new ConflictException(
        'Video metadata is incomplete; validate the asset first',
      );
    }
    return {
      durationMs: row.durationMs,
      width: row.width,
      height: row.height,
      fps: row.fps,
    };
  }

  private assertTimestampInRange(timestampMs: number, durationMs: number): void {
    // Duration is an EXCLUSIVE endpoint: no frame exists AT durationMs, and
    // accepting it would make the same request succeed on the simulated
    // adapter and fail on a real one. Strictly-less only.
    if (timestampMs >= durationMs) {
      throw new BadRequestException(
        `timestampMs ${timestampMs} is outside the video duration (${durationMs} ms, exclusive)`,
      );
    }
  }

  /**
   * Atomic publish of an extraction batch: files are staged to storage
   * first, then every artifact row, artifact audit entry, and the asset's
   * READY flip commit as ONE transaction. On ANY failure the staged files
   * are removed — append-only artifact rows mean a partial batch could
   * never be cleaned up, so no row may commit unless all of them do; a
   * failed request retries without duplicating committed artifacts.
   */
  private async persistArtifactsBatch(
    tenantId: string,
    assetStorageKey: string,
    videoAssetId: string,
    actor: AuditActor | undefined,
    inputs: {
      artifactType: VideoArtifactType;
      image: {
        data: Buffer;
        width: number;
        height: number;
        mimeType: string;
        timestampMs: number;
      };
      reason?: VideoCropReason;
      crop?: { x: number; y: number; width: number; height: number };
    }[],
    reason: string,
  ): Promise<{ asset: VideoAssetView; artifacts: VideoArtifactView[] }> {
    // Adapter-independent memory ceiling for the retained batch.
    const totalBytes = inputs.reduce(
      (sum, input) => sum + input.image.data.length,
      0,
    );
    if (totalBytes > MAX_TOTAL_ARTIFACT_BYTES) {
      throw new ConflictException(
        'Extraction output exceeds the per-request artifact size budget',
      );
    }

    const assetDir = assetStorageKey.slice(0, assetStorageKey.lastIndexOf('/'));
    const staged: string[] = [];
    try {
      const items = [];
      for (const input of inputs) {
        const storageKey = `${assetDir}/artifacts/${randomUUID()}.png`;
        await this.storage.put(storageKey, input.image.data);
        staged.push(storageKey);
        items.push({
          artifactType: input.artifactType,
          reason: input.reason,
          timestampMs: input.image.timestampMs,
          cropX: input.crop?.x,
          cropY: input.crop?.y,
          cropWidth: input.crop?.width,
          cropHeight: input.crop?.height,
          width: input.image.width,
          height: input.image.height,
          mimeType: input.image.mimeType,
          sizeBytes: input.image.data.length,
          checksumSha256: createHash('sha256')
            .update(input.image.data)
            .digest('hex'),
          storageKey,
          createdById: actor?.id,
        });
      }
      const published = await this.repository.createArtifactsBatch(
        tenantId,
        videoAssetId,
        [
          VideoAssetStatus.VALIDATED,
          VideoAssetStatus.READY,
          VideoAssetStatus.FAILED,
        ],
        items,
        (artifact) =>
          this.auditEntry(tenantId, actor, {
            action: AuditAction.CREATE,
            entityType: 'VideoArtifact',
            entityId: artifact.id,
            after: artifact,
            reason: `${artifact.artifactType} artifact extracted`,
          }),
        (before, after) =>
          this.auditEntry(tenantId, actor, {
            action: AuditAction.UPDATE,
            entityType: 'VideoAsset',
            entityId: videoAssetId,
            before,
            after,
            reason,
          }),
      );
      if (!published) {
        // CAS lost (concurrent transition or delete) — nothing committed.
        throw new ConflictException(
          'The video asset changed concurrently; retry the extraction',
        );
      }
      return published;
    } catch (error) {
      // Nothing was published (the batch is all-or-none) — remove every
      // staged file so a retry starts clean.
      for (const storageKey of staged) {
        await this.storage.delete(storageKey).catch(() => undefined);
      }
      throw error;
    }
  }

  private async mapExtractionError(
    tenantId: string,
    id: string,
    actor: AuditActor | undefined,
    error: unknown,
  ): Promise<Error> {
    if (error instanceof ExtractorUnavailableError) {
      // Environmental, not a property of the video — no status change.
      return new ServiceUnavailableException(error.message);
    }
    if (error instanceof ExtractionFailedError) {
      await this.repository.transitionStatus(
        tenantId,
        id,
        [
          VideoAssetStatus.VALIDATED,
          VideoAssetStatus.READY,
          VideoAssetStatus.FAILED,
        ],
        {
          status: VideoAssetStatus.FAILED,
          errorCode: VIDEO_ERROR_CODES.EXTRACTION_FAILED,
          errorMessage: 'Frame/crop extraction failed',
        },
        (before, after) =>
          this.auditEntry(tenantId, actor, {
            action: AuditAction.UPDATE,
            entityType: 'VideoAsset',
            entityId: id,
            before,
            after,
            reason: 'Extraction failed',
          }),
      );
      return new ConflictException('Frame/crop extraction failed');
    }
    return error instanceof Error ? error : new Error('Extraction failed');
  }
}
