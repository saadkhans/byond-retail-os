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
import { containsSensitiveValue } from '../common/sensitive-keys';
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
import {
  ScreenVideoAssetDto,
  VideoScreeningDecision,
} from './dto/screen-video-asset.dto';
import { UploadVideoAssetDto } from './dto/upload-video-asset.dto';
import {
  ExtractionFailedError,
  ExtractionInfrastructureError,
  ExtractorUnavailableError,
  FrameUnavailableError,
  VideoFrameExtractorPort,
  VideoProbeResult,
} from './extraction/video-frame-extractor.port';
import {
  bufferCarriesSensitiveText,
  carriesLikelyPan,
  fileExtensionOf,
  filenameCarriesSensitiveContent,
  isAllowedVideoUpload,
  isUnsafeUploadFilename,
  looksLikeVideoContent,
  sanitizeOriginalFilename,
  VIDEO_ERROR_CODES,
} from './media-safety';
import {
  VideoStorageOperationError,
  VideoStoragePort,
} from './storage/video-storage.port';
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

/**
 * EVERY externally-supplied identifier — upload references, route :id
 * params (Express percent-decodes them, so "/video-assets/%00" arrives as
 * a NUL), list filters, and idempotency keys — must be an opaque
 * single-line value: a NUL would surface as an uncontrolled Prisma 500
 * before any query could reject it, and other control characters have no
 * business in ids, reflected errors, or audit entity ids.
 */
function assertPlainId(field: string, value: string | undefined): void {
  if (value !== undefined && CONTROL_CHARACTERS.test(value)) {
    throw new BadRequestException(`${field} must not contain control characters`);
  }
}

/** Idempotency keys are PERSISTED verbatim — opaque AND secret-free. */
function assertOpaqueKey(field: string, value: string | undefined): void {
  assertPlainId(field, value);
  if (value !== undefined && containsSensitiveValue(value)) {
    throw new BadRequestException(
      `${field} must be an opaque value and must not contain credential- ` +
        `or payment-bearing content`,
    );
  }
}

/**
 * An EXISTENCE-BLIND audit entry (recorded before any lookup resolved the
 * id) persists attacker-controlled text as its entityId — a PAN or
 * credential smuggled as a URL path segment must be redacted, never stored
 * verbatim (AGENTS.md payments invariant). Resolved ids are server data
 * and stay readable.
 */
function safeAuditEntityId(id: string): string {
  return containsSensitiveValue(id) || carriesLikelyPan(id)
    ? '[REDACTED]'
    : id;
}

/** Crop reason → default Phase 9 job type (closed 1:1 where one exists). */
const REASON_TO_JOB_TYPE: Partial<Record<VideoCropReason, InferenceJobType>> = {
  [VideoCropReason.SHELF_AUDIT]: InferenceJobType.SHELF_AUDIT,
  [VideoCropReason.OCR_REVIEW]: InferenceJobType.OCR_REVIEW,
  [VideoCropReason.VLM_REVIEW]: InferenceJobType.VLM_REVIEW,
};

/**
 * Canonical fingerprint of an extraction request's parameters: fixed
 * operation tag, fixed field order, defaults applied, DTO-validated
 * integers (so String() serialization is stable). Persisted with the
 * request row in the SAME transaction as its batch and compared on EVERY
 * replay path — an idempotency key replays ONLY the identical request; the
 * same key with changed parameters is a controlled 409, never a silent
 * replay of the old batch answering a different question.
 */
function framesRequestFingerprint(dto: ExtractFramesDto): string {
  // timestampMs wins over interval sampling (mirroring the extraction
  // branch below), so a supplied-but-ignored interval/limit can never
  // change the fingerprint of a single-frame request.
  return dto.timestampMs !== undefined
    ? JSON.stringify({ op: 'FRAMES', timestampMs: dto.timestampMs })
    : JSON.stringify({
        op: 'FRAMES',
        intervalMs: dto.intervalMs ?? DEFAULT_FRAME_INTERVAL_MS,
        maxFrames: dto.maxFrames ?? DEFAULT_MAX_FRAMES,
      });
}

function cropRequestFingerprint(dto: CreateVideoCropDto): string {
  return JSON.stringify({
    op: 'CROP',
    timestampMs: dto.timestampMs,
    x: dto.x,
    y: dto.y,
    width: dto.width,
    height: dto.height,
    reason: dto.reason ?? null,
  });
}

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
    // Defense-in-depth re-check of the DTO-validated attestation. The
    // attestation proves nothing about the BYTES — the enforced control is
    // that the asset lands QUARANTINED (set at the persistence layer) and
    // stays non-processable until an audited screening decision releases
    // it; the declaration is kept as an explicit, audited statement of
    // intent on top of that gate.
    if (dto.attestNoSensitiveContent !== 'true') {
      throw new BadRequestException(
        'attestNoSensitiveContent must be "true": uploads are stored only ' +
          'with an explicit attestation that the staged test clip contains ' +
          'no payment-card or credential content in its frames',
      );
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
    // Payload-level screen: text embedded in the container (metadata atoms,
    // subtitle tracks, XMP/ID3) must not smuggle a PAN or credential into
    // durable storage. Frame-VISIBLE content is not decodable without real
    // CV (explicitly out of Phase 10 scope) — the operational control there
    // is staged, controlled TEST clips only (README guidance) plus
    // local-only, never-served storage; later CV phases add frame review.
    if (bufferCarriesSensitiveText(file.buffer)) {
      throw new BadRequestException(
        'Video content carries credential- or payment-bearing text and was rejected',
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
    try {
      await this.storage.put(storageKey, file.buffer);
    } catch (error) {
      if (error instanceof VideoStorageOperationError) {
        // Environmental (disk full, permissions) — 503, not a caller error.
        throw new ServiceUnavailableException(error.message);
      }
      throw error;
    }
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
            // The frame-content attestation is part of the audited record:
            // storing happened only under this explicit declaration — and
            // the asset is QUARANTINED until a screening decision releases it.
            reason:
              'Test video uploaded and QUARANTINED pending frame-content ' +
              'screening (operator attested: no payment-card or credential ' +
              'content in frames)',
          }),
      );
    } catch (error) {
      // The DB row failed — never leave an orphaned file behind.
      await this.cleanupUploadDir(storageKey);
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
      await this.cleanupUploadDir(storageKey);
      throw new BadRequestException(this.referenceRejectionMessage(result, dto));
    }
    return result;
  }

  /**
   * Cleanup of a stored upload whose row never landed. A cleanup failure is
   * NEVER swallowed: no row references the generated key, so an ignored
   * failure would strand untracked media on disk with nothing able to find
   * it again. One retry for transient errors, then a controlled 503 that
   * names the condition (media left behind under the local storage root)
   * so the operator acts on it.
   */
  private async cleanupUploadDir(storageKey: string): Promise<void> {
    await this.removeAssetMediaDir(
      storageKey,
      'The upload could not be recorded AND its media could not be ' +
        'cleaned up; local video storage needs attention before ' +
        'retrying',
    );
  }

  /**
   * Shared retry/escalate removal of an asset's media directory (the
   * original plus any extracted artifacts): one retry for transient errors,
   * then a controlled 503 with the caller's condition-specific message —
   * a removal failure is never silently swallowed.
   */
  private async removeAssetMediaDir(
    storageKey: string,
    escalationMessage: string,
  ): Promise<void> {
    const dir = storageKey.slice(0, storageKey.lastIndexOf('/'));
    try {
      await this.storage.deletePrefix(dir);
    } catch {
      try {
        await this.storage.deletePrefix(dir);
      } catch {
        throw new ServiceUnavailableException(escalationMessage);
      }
    }
  }

  /**
   * Cleanup of staged artifact files that will never get rows (the atomic
   * publish failed) or that lost a concurrent-replay race. Same policy as
   * cleanupUploadDir: a cleanup failure is NEVER swallowed — no artifact
   * row references these keys, so an ignored failure would strand untracked
   * media on disk. One retry per file, then a controlled 503 naming the
   * orphan condition. Successfully deleted keys are consumed from the list,
   * so attempts stay bounded even if a caller re-enters after escalation.
   */
  private async cleanupStagedArtifacts(staged: string[]): Promise<void> {
    while (staged.length > 0) {
      const storageKey = staged[0];
      try {
        await this.storage.delete(storageKey);
      } catch {
        try {
          await this.storage.delete(storageKey);
        } catch {
          throw new ServiceUnavailableException(
            'The extraction left staged artifact files that could not be ' +
              'cleaned up; local video storage needs attention before ' +
              'retrying',
          );
        }
      }
      staged.shift();
    }
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
      case 'device-location-mismatch':
        return `Device "${dto.deviceId}" is not in store "${dto.locationId}"`;
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
    assertPlainId('sessionId', query.sessionId);
    assertPlainId('locationId', query.locationId);
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
    assertPlainId('id', id);
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
    assertPlainId('id', artifactId);
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
    assertPlainId('id', id);
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
    if (internal.status === VideoAssetStatus.QUARANTINED) {
      // Quarantine is the ENFORCED frame-content control (the upload
      // attestation is defense-in-depth only): no processing entry point —
      // validate included — may touch the bytes before an audited
      // screening decision releases the asset.
      throw new ConflictException(
        'Video asset is QUARANTINED pending frame-content screening; an ' +
          'audited screening decision must APPROVE it before validation',
      );
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
      if (error instanceof ExtractionInfrastructureError) {
        // The probe TOOLING could not run to completion (killed, refused,
        // or over-buffered) — that says nothing about the video, so the
        // asset stays UPLOADED for a retry: no REJECTED transition, no
        // audit entry, just a controlled 503.
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
   * The audited frame-content screening decision for a QUARANTINED upload —
   * the ENFORCED control the upload attestation only complements (an
   * attestation proves nothing about the bytes). APPROVE releases the asset
   * for processing (QUARANTINED → UPLOADED); REJECT removes the stored
   * media with the same retry/escalate policy as every other cleanup and
   * parks the metadata row as evidence (QUARANTINED → REJECTED, stable
   * error code). Any decision on a non-QUARANTINED asset is a controlled
   * 409. A later phase plugs an automated CV frame screener into this same
   * step; the manual decision is the MVP.
   */
  async screen(
    tenantId: string,
    id: string,
    dto: ScreenVideoAssetDto,
    actor?: AuditActor,
  ): Promise<VideoAssetView> {
    assertPlainId('id', id);
    if (dto.note !== undefined) {
      // The note lands verbatim in the audit trail (same policy as Phase 7
      // review reasons): opaque, single-line, and secret-/payment-free.
      assertPlainId('note', dto.note);
      if (containsSensitiveValue(dto.note) || carriesLikelyPan(dto.note)) {
        throw new BadRequestException(
          'note must not contain credential- or payment-bearing content',
        );
      }
    }
    const internal = await this.repository.findByIdInternal(tenantId, id);
    if (!internal) {
      throw new NotFoundException(`Video asset "${id}" not found`);
    }
    if (internal.status !== VideoAssetStatus.QUARANTINED) {
      throw new ConflictException(
        `Video asset is ${internal.status}; only QUARANTINED assets accept ` +
          'a screening decision',
      );
    }
    const noteSuffix = dto.note ? `; note: ${dto.note}` : '';

    if (dto.decision === VideoScreeningDecision.APPROVE) {
      const approved = await this.repository.transitionStatus(
        tenantId,
        id,
        [VideoAssetStatus.QUARANTINED],
        { status: VideoAssetStatus.UPLOADED },
        (before, after) =>
          this.auditEntry(tenantId, actor, {
            action: AuditAction.UPDATE,
            entityType: 'VideoAsset',
            entityId: id,
            before,
            after,
            reason:
              'Frame-content screening approved: quarantined upload ' +
              `released for processing${noteSuffix}`,
          }),
      );
      if (!approved) {
        // CAS lost — a concurrent decision (or delete) resolved first.
        throw new ConflictException(
          'The video asset changed concurrently; re-read it before ' +
            'screening again',
        );
      }
      return approved;
    }

    // REJECT: the stored media goes FIRST (retry once, then a controlled
    // 503 that leaves the asset QUARANTINED so the rejection is retryable),
    // then the audited terminal transition. A crash between the two leaves
    // a QUARANTINED row whose retried REJECT re-runs the (idempotent)
    // removal and completes the transition — bytes can never outlive a
    // recorded rejection.
    await this.removeAssetMediaDir(
      internal.storageKey,
      'The screening rejection could not remove the stored media; local ' +
        'video storage needs attention before retrying',
    );
    const rejected = await this.repository.transitionStatus(
      tenantId,
      id,
      [VideoAssetStatus.QUARANTINED],
      {
        status: VideoAssetStatus.REJECTED,
        errorCode: VIDEO_ERROR_CODES.SCREENING_REJECTED,
        errorMessage:
          'Frame-content screening rejected this upload; the stored media ' +
          'was removed',
      },
      (before, after) =>
        this.auditEntry(tenantId, actor, {
          action: AuditAction.UPDATE,
          entityType: 'VideoAsset',
          entityId: id,
          before,
          after,
          reason:
            'Frame-content screening rejected: media removed, metadata ' +
            `kept as evidence${noteSuffix}`,
        }),
    );
    if (!rejected) {
      throw new ConflictException(
        'The video asset changed concurrently; re-read it before screening ' +
          'again',
      );
    }
    return rejected;
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
  ): Promise<{
    asset: VideoAssetView;
    artifacts: VideoArtifactView[];
    replayed: boolean;
  }> {
    assertOpaqueKey('idempotencyKey', dto.idempotencyKey);
    const requestFingerprint = framesRequestFingerprint(dto);
    // Replay BEFORE extracting: a committed batch whose response was lost
    // must return its recorded artifacts without re-running extraction or
    // staging new files.
    if (dto.idempotencyKey) {
      const replay = await this.replayExtraction(tenantId, id, dto.idempotencyKey);
      if (replay) {
        // A key from a CROP request must not replay into the frames
        // endpoint — the recorded batch is a different operation.
        if (
          replay.artifacts.some(
            (artifact) => artifact.artifactType !== VideoArtifactType.FRAME,
          )
        ) {
          throw new ConflictException(
            'This idempotency key was used for a different operation type',
          );
        }
        // Same key, same asset — but the replay is honored ONLY when the
        // request is IDENTICAL (timestamp/interval/limit unchanged).
        this.assertReplayMatchesRequest(
          replay.requestFingerprint,
          requestFingerprint,
        );
        return replay;
      }
    }
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

    const published = await this.persistArtifactsBatch(
      tenantId,
      internal.storageKey,
      id,
      actor,
      images.map((image) => ({ artifactType: VideoArtifactType.FRAME, image })),
      'Frames extracted',
      dto.idempotencyKey,
      requestFingerprint,
    );
    // The in-transaction replay path can surface a batch too — same
    // operation-type and identical-parameters guards as the pre-check.
    if (published.replayed) {
      if (
        published.artifacts.some(
          (artifact) => artifact.artifactType !== VideoArtifactType.FRAME,
        )
      ) {
        throw new ConflictException(
          'This idempotency key was used for a different operation type',
        );
      }
      this.assertReplayMatchesRequest(
        published.requestFingerprint,
        requestFingerprint,
      );
    }
    return published;
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
  ): Promise<{
    asset: VideoAssetView;
    artifact: VideoArtifactView;
    replayed: boolean;
  }> {
    assertOpaqueKey('idempotencyKey', dto.idempotencyKey);
    const requestFingerprint = cropRequestFingerprint(dto);
    if (dto.idempotencyKey) {
      const replay = await this.replayExtraction(tenantId, id, dto.idempotencyKey);
      if (replay) {
        // A key from an extract-frames request must not replay into the
        // crop endpoint (wrong operation → wrong artifact shape).
        if (
          replay.artifacts.length !== 1 ||
          replay.artifacts[0].artifactType !== VideoArtifactType.CROP
        ) {
          throw new ConflictException(
            'This idempotency key was used for a different operation type',
          );
        }
        // Same key, same asset — but the replay is honored ONLY when the
        // request is IDENTICAL (timestamp/box/reason unchanged).
        this.assertReplayMatchesRequest(
          replay.requestFingerprint,
          requestFingerprint,
        );
        return {
          asset: replay.asset,
          artifact: replay.artifacts[0],
          replayed: true,
        };
      }
    }
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

    const published = await this.persistArtifactsBatch(
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
      dto.idempotencyKey,
      requestFingerprint,
    );
    const { asset, artifacts, replayed } = published;
    if (replayed) {
      if (
        artifacts.length !== 1 ||
        artifacts[0].artifactType !== VideoArtifactType.CROP
      ) {
        throw new ConflictException(
          'This idempotency key was used for a different operation type',
        );
      }
      this.assertReplayMatchesRequest(
        published.requestFingerprint,
        requestFingerprint,
      );
    }
    return { asset, artifact: artifacts[0], replayed };
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
    // Before ANY read or audit write: the id lands in queries and in the
    // denial audit's entityId, so control characters are rejected first.
    assertPlainId('id', artifactId);
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
          // Existence-blind: the id was never resolved, so a sensitive
          // value in the path segment is redacted before persistence.
          entityId: safeAuditEntityId(artifactId),
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
    // Resolve the requested job type BEFORE any replay of an existing link:
    // a retry that (explicitly or via its resolved default) asks for a
    // DIFFERENT jobType than the linked job must be a 409, never silently
    // handed the existing job as if it answered the new request.
    const jobType =
      dto.jobType ??
      (artifact.reason ? REASON_TO_JOB_TYPE[artifact.reason] : undefined) ??
      InferenceJobType.PRODUCT_RECOGNITION;
    if (artifact.inferenceJobId) {
      const job = await this.inferenceJobsService.findById(
        tenantId,
        artifact.inferenceJobId,
      );
      if (job.jobType !== jobType) {
        throw new ConflictException(
          `This crop is already linked to a ${job.jobType} inference job; ` +
            'a retry must resolve to the same job type',
        );
      }
      return { artifact, job, replayed: true };
    }
    const asset = await this.repository.findById(tenantId, artifact.videoAssetId);
    if (!asset) {
      throw new ConflictException(
        'The source video asset was deleted; this crop cannot create a job',
      );
    }

    // The COMPLETE server-derived descriptor — also the comparison baseline
    // for any replayed job below.
    const expectedDescriptor: Record<string, unknown> = {
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
    };

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
        inputDescriptor: expectedDescriptor,
        // ALWAYS the derived key (never client-tunable): at-least-once
        // retries replay THIS crop's job and can never collide with another
        // crop's key.
        idempotencyKey: `video-crop:${artifact.id}`,
      },
      actor,
    );
    // Idempotency keys are tenant-scoped and first-writer-wins: a caller
    // holding inference:manage could have squatted `video-crop:<id>` with a
    // direct Phase 9 create carrying the right ids but a fabricated
    // timestamp, crop box, artifact type, or context — and our create would
    // REPLAY that job. The COMPLETE server-derived descriptor AND the job's
    // source/context bindings must match before the one-shot link is
    // stamped; lineage integrity beats availability here.
    if (!this.jobMatchesCrop(job, expectedDescriptor, asset, jobType)) {
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
      // Concurrent creation stamped first — replay ITS link, but only when
      // it resolves to the SAME job type this request asked for.
      const current = await this.findArtifactById(tenantId, artifactId);
      if (current.inferenceJobId) {
        const existing = await this.inferenceJobsService.findById(
          tenantId,
          current.inferenceJobId,
        );
        if (existing.jobType !== jobType) {
          throw new ConflictException(
            `This crop is already linked to a ${existing.jobType} inference ` +
              'job; a retry must resolve to the same job type',
          );
        }
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
    assertPlainId('id', id);
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
    try {
      await this.storage.deletePrefix(assetDir);
    } catch (error) {
      if (error instanceof VideoStorageOperationError) {
        // The soft-delete is already durable; the file cleanup is
        // retryable via this same idempotent endpoint — 503, not 500.
        throw new ServiceUnavailableException(error.message);
      }
      throw error;
    }
    return { deleted: true };
  }

  // -------------------------------------------------------------------------

  /**
   * A job may link to a crop ONLY when its persisted descriptor deep-equals
   * the complete server-derived descriptor AND its source/context bindings
   * are the ones this crop's asset would have produced. Field-by-field —
   * a squatter controlling any single field is rejected.
   */
  private jobMatchesCrop(
    job: InferenceJobDetail,
    expectedDescriptor: Record<string, unknown>,
    asset: VideoAssetView,
    expectedJobType: InferenceJobType,
  ): boolean {
    // A preclaimed job with the right descriptor but a DIFFERENT job type
    // would permanently link the crop to the wrong operation (an OCR crop
    // to product recognition). Retries must therefore request the same
    // jobType the original creation resolved to.
    if (job.jobType !== expectedJobType) {
      return false;
    }
    const descriptor = job.inputDescriptor as Record<string, unknown> | null;
    if (!descriptor) {
      return false;
    }
    const expectedBox = expectedDescriptor.cropBox as Record<string, unknown>;
    const box = descriptor.cropBox as Record<string, unknown> | undefined;
    const descriptorKeys = Object.keys(descriptor).sort();
    const expectedKeys = Object.keys(expectedDescriptor).sort();
    return (
      descriptorKeys.length === expectedKeys.length &&
      descriptorKeys.every((key, index) => key === expectedKeys[index]) &&
      descriptor.artifactType === expectedDescriptor.artifactType &&
      descriptor.videoAssetId === expectedDescriptor.videoAssetId &&
      descriptor.cropArtifactId === expectedDescriptor.cropArtifactId &&
      descriptor.timestampMs === expectedDescriptor.timestampMs &&
      Boolean(box) &&
      box?.x === expectedBox.x &&
      box?.y === expectedBox.y &&
      box?.width === expectedBox.width &&
      box?.height === expectedBox.height &&
      (descriptor.sourceDeviceId ?? null) ===
        (expectedDescriptor.sourceDeviceId ?? null) &&
      (descriptor.locationRef ?? null) ===
        (expectedDescriptor.locationRef ?? null) &&
      (descriptor.unitRef ?? null) === (expectedDescriptor.unitRef ?? null) &&
      job.sourceId === `video-crop:${expectedDescriptor.cropArtifactId as string}` &&
      (job.locationId ?? null) === (asset.locationId ?? null) &&
      (job.unitId ?? null) === (asset.unitId ?? null) &&
      (job.deviceId ?? null) === (asset.deviceId ?? null) &&
      (job.sessionId ?? null) === (asset.sessionId ?? null)
    );
  }

  /** Replay a committed extraction request, or map a cross-asset key. */
  private async replayExtraction(
    tenantId: string,
    videoAssetId: string,
    idempotencyKey: string,
  ): Promise<{
    asset: VideoAssetView;
    artifacts: VideoArtifactView[];
    replayed: true;
    requestFingerprint?: string | null;
  } | null> {
    const replay = await this.repository.findExtractionReplay(
      tenantId,
      videoAssetId,
      idempotencyKey,
    );
    if (replay === 'key-conflict') {
      throw new ConflictException(
        'This idempotency key was already used for a different video asset',
      );
    }
    return replay;
  }

  /**
   * A recorded batch answers ONLY the identical request: the stored
   * canonical fingerprint must equal the incoming one. FAIL CLOSED — a
   * missing recorded fingerprint (rows from before it was persisted) cannot
   * prove the retried request is the same one, so it is rejected the same
   * way as a changed request rather than replaying unverifiably.
   */
  private assertReplayMatchesRequest(
    stored: string | null | undefined,
    requested: string,
  ): void {
    if ((stored ?? null) !== requested) {
      throw new ConflictException(
        'This idempotency key was already used for a request with different ' +
          'parameters',
      );
    }
  }

  private async requireProcessable(tenantId: string, id: string) {
    assertPlainId('id', id);
    const internal = await this.repository.findByIdInternal(tenantId, id);
    if (!internal) {
      throw new NotFoundException(`Video asset "${id}" not found`);
    }
    if (internal.status === VideoAssetStatus.QUARANTINED) {
      // Quarantined bytes are NOT processable — the audited screening
      // decision (not the upload attestation) is what stands between a
      // stored clip and any frame/crop extraction.
      throw new ConflictException(
        'Video asset is QUARANTINED pending frame-content screening; an ' +
          'audited screening decision must APPROVE it before extraction',
      );
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
    idempotencyKey?: string,
    requestFingerprint?: string,
  ): Promise<{
    asset: VideoAssetView;
    artifacts: VideoArtifactView[];
    replayed: boolean;
    requestFingerprint?: string | null;
  }> {
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
        idempotencyKey,
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
        requestFingerprint,
      );
      if (published === 'key-conflict') {
        throw new ConflictException(
          'This idempotency key was already used for a different video asset',
        );
      }
      if (!published) {
        // CAS lost (concurrent transition or delete) — nothing committed.
        throw new ConflictException(
          'The video asset changed concurrently; retry the extraction',
        );
      }
      if (published.replayed) {
        // A concurrent request committed first inside the tx window — its
        // batch is the result (the caller still verifies it answers THIS
        // request); our staged files are surplus and must not linger.
        await this.cleanupStagedArtifacts(staged);
      }
      return published;
    } catch (error) {
      // Nothing was published (the batch is all-or-none) — remove every
      // staged file so a retry starts clean. A cleanup failure ESCALATES
      // (same policy as cleanupUploadDir): no row references these keys,
      // so silently keeping only the original error would strand orphaned
      // media on disk with nothing able to find it again.
      await this.cleanupStagedArtifacts(staged);
      // Two concurrent firsts racing the same key: the loser's request-row
      // insert hits the (tenantId, idempotencyKey) unique and its whole
      // batch rolls back — replay the winner's committed batch. If the
      // replay finds nothing (winner's asset deleted in the same window),
      // surface a CONTROLLED conflict, never the raw Prisma error.
      if (prismaErrorCode(error) === 'P2002' && idempotencyKey) {
        const replay = await this.replayExtraction(
          tenantId,
          videoAssetId,
          idempotencyKey,
        );
        if (replay) {
          return replay;
        }
        throw new ConflictException(
          'The video asset changed concurrently; retry the extraction',
        );
      }
      // Storage failures are environmental, not caller errors.
      if (error instanceof VideoStorageOperationError) {
        throw new ServiceUnavailableException(error.message);
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
    if (error instanceof FrameUnavailableError) {
      // The VIDEO is fine — the requested position is past the last
      // decodable frame (container durations routinely overshoot). A
      // controlled 400, and the asset does NOT flip to FAILED.
      return new BadRequestException(
        'No frame is decodable at the requested timestamp; try an earlier position',
      );
    }
    if (error instanceof ExtractionInfrastructureError) {
      // The extraction TOOLING was killed or refused mid-run — transient
      // and NOT a property of the video: no FAILED transition, no audit,
      // a controlled 503 so the caller retries.
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
