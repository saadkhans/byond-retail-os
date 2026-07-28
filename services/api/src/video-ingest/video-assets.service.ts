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
  EvidenceSourceType,
  InferenceJobStatus,
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
  BufferInspectionSession,
  ExtractionFailedError,
  ExtractionInfrastructureError,
  ExtractorUnavailableError,
  FrameExceedsBudgetError,
  FrameUnavailableError,
  VideoFrameExtractorPort,
  VideoProbeResult,
} from './extraction/video-frame-extractor.port';
import {
  FrameTextRecognitionFailedError,
  FrameTextRecognitionInfrastructureError,
  FrameTextRecognizerPort,
  FrameTextRecognizerUnavailableError,
} from './recognition/frame-text-recognizer.port';
import {
  bufferCarriesSensitiveText,
  carriesLikelyPan,
  containsSensitiveFreeText,
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

/**
 * Hard cap on quarantine screening-preview frames per request: enough to
 * inspect a 10–30 s test clip end to end, small enough that the in-memory
 * extraction and base64 response stay bounded.
 */
export const SCREENING_PREVIEW_MAX_FRAMES = 6;

/**
 * Total decoded-byte budget for ONE screening-preview response — a
 * preview-specific cap MUCH tighter than MAX_TOTAL_ARTIFACT_BYTES because
 * these bytes come straight back base64-encoded inside a single JSON body
 * (×4/3 inflation plus JSON overhead): 16 MiB of decoded frames keeps the
 * inflated response at or under ~22 MiB. The remaining allowance is
 * enforced BEFORE each decode by handing it to the extractor as a
 * per-frame byte cap, so a near-exhausted budget can never trigger
 * another full-size decode.
 */
export const SCREENING_PREVIEW_TOTAL_BYTES = 16 * 1024 * 1024;

/**
 * Floor under the remaining preview budget: no decodable frame fits in
 * fewer bytes than this, so once the remainder drops below it the sampling
 * loop stops (remaining positions are reported as skipped) instead of
 * issuing extractor calls that are guaranteed to overflow.
 */
export const SCREENING_PREVIEW_MIN_FRAME_BYTES = 1024;

/**
 * Freshness window for screening inspection evidence: an APPROVE decision
 * requires a real-media preview inspection recorded within this window.
 * 30 minutes — the evidence must reflect a RECENT human look at the actual
 * frames (one screening sitting), not a preview loaded hours or days ago
 * whose content the approver no longer has in front of them. Stale
 * evidence forces a fresh preview, never a blind approval.
 */
export const SCREENING_INSPECTION_MAX_AGE_MS = 30 * 60 * 1000;

/**
 * Default ceiling on the probed duration eligible for the mandatory
 * PRE-STORAGE frame screen (VIDEO_MAX_SCREENING_DURATION_MS, boot-validated
 * to 1000..300000 ms): the screen inspects EVERY started second of the
 * clip at 1 fps — no sparse sampling — so this cap is what bounds the
 * synchronous upload request. A longer clip is a controlled, audited 400
 * BEFORE any byte reaches durable storage.
 */
export const DEFAULT_MAX_SCREENING_DURATION_MS = 30_000;

/**
 * Per-frame decoded-byte cap handed to the pre-storage screening pass —
 * the same 16 MiB bound the screening preview enforces on its WHOLE
 * response: no legitimate test-clip frame approaches it. A frame that
 * cannot fit cannot be OCR-inspected, so overrunning it FAILS THE UPLOAD
 * CLOSED (a frame that cannot be inspected cannot be stored) instead of
 * skipping the frame or ballooning memory.
 */
export const PRESTORE_SCREENING_MAX_FRAME_BYTES = SCREENING_PREVIEW_TOTAL_BYTES;

/** One in-memory preview frame — NEVER persisted, base64 in the response. */
export interface ScreeningPreviewFrame {
  timestampMs: number;
  width: number;
  height: number;
  mimeType: string;
  imageBase64: string;
}

/** Screening-preview response: sample frames + what was skipped and why. */
export interface ScreeningPreviewResult {
  assetId: string;
  status: VideoAssetStatus;
  durationMs: number;
  frames: ScreeningPreviewFrame[];
  /** Frames dropped because they would exceed the decoded-byte budget. */
  skippedOverBudget: number;
}

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

/**
 * Idempotency keys are PERSISTED verbatim — opaque AND secret-free. The
 * single fused free-text predicate screens them (key=value credentials,
 * known secret tokens, fused labels like "cvv123", and grouping-aware
 * Luhn-wins PAN windows): "4111_1111_1111_1111" (any single separator)
 * must never land in VideoExtractionRequest.idempotencyKey.
 */
function assertOpaqueKey(field: string, value: string | undefined): void {
  assertPlainId(field, value);
  if (value !== undefined && containsSensitiveFreeText(value)) {
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
 * and stay readable. The SAME policy applies to caller-supplied values
 * reflected into error messages (reference-rejection 400s, unresolved-id
 * 404s): error responses land in logs and telemetry, so a PAN-valued
 * locationId/deviceId/sessionId/route id must echo back as [REDACTED].
 */
function safeAuditEntityId(id: string): string {
  return containsSensitiveValue(id) || carriesLikelyPan(id)
    ? '[REDACTED]'
    : id;
}

/**
 * safeAuditEntityId for OPTIONAL caller-supplied references interpolated
 * into error messages: undefined passes through unchanged so message
 * templates render exactly as before the redaction sweep.
 */
function safeReference(value: string | undefined): string | undefined {
  return value === undefined ? value : safeAuditEntityId(value);
}

/**
 * 503 escalation for a screening rejection whose media removal failed
 * AFTER the terminal claim committed: the asset is already REJECTED
 * (unprocessable and never served), so the message names the orphaned
 * media and the recovery path — replaying the rejection re-attempts the
 * removal.
 */
const SCREENING_MEDIA_ORPHAN_MESSAGE =
  'The screening rejection is recorded (the asset is REJECTED and can ' +
  'never be processed or served) but the stored media could not be ' +
  'removed and remains orphaned under the local storage root; retry the ' +
  'rejection to complete the removal';

/**
 * 503 escalation for an upload whose publish CAS lost to a concurrent
 * DELETE and whose COMPENSATING media removal then failed (retry
 * included): the just-written media survived a delete whose caller was
 * already told cleanup completed, so the failure must surface as a
 * retryable error naming the recovery path — the idempotent DELETE
 * replay re-runs the same prefix removal and discharges the obligation.
 */
const UPLOAD_RACE_MEDIA_ORPHAN_MESSAGE =
  'The video asset was deleted while its media was being stored, and the ' +
  'just-written media could not be removed — it remains orphaned under ' +
  'the deleted asset\'s storage prefix; replay DELETE /video-assets/:id ' +
  'to complete the cleanup';

/**
 * Controlled outcome when a concurrent DELETE wins against an in-flight
 * upload (observed either by the locked pre-put liveness check or by the
 * lost publish CAS): the upload is NOT published and the caller re-uploads.
 */
const UPLOAD_DELETED_CONFLICT_MESSAGE =
  'The video asset was deleted while its media was being stored; ' +
  'the upload was not published';

/**
 * SERVER-DERIVED provenance for every inference job created from a video
 * crop: the Phase 9 contract records crop-originated jobs as VISION
 * evidence (the InferenceJob schema default), and the crop→job creation
 * passes it EXPLICITLY so the persisted provenance never rides on a schema
 * default. The replay matchers require it too: a same-tenant caller who
 * pre-created the derived `video-crop:<id>` key with the right descriptor
 * and context but sourceType ADMIN/MANUAL must never be replayed into the
 * link — the job's VisionEvent would inherit false provenance.
 */
const CROP_JOB_SOURCE_TYPE = EvidenceSourceType.VISION;

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
  // timestampMs wins over interval sampling for EXTRACTION (mirroring the
  // extraction branch below) — but request IDENTITY covers EVERY supplied
  // field: in single-frame mode a supplied interval/limit is ignored by
  // the extractor yet still part of what the caller asked for, so it is
  // fingerprinted RAW (explicit null = not supplied) and a same-key retry
  // that changes any supplied value is a controlled 409, never a silent
  // replay. Sampling mode keeps normalized defaults: there the values ARE
  // consumed, so an omitted parameter and its explicit default are the
  // same request.
  return dto.timestampMs !== undefined
    ? JSON.stringify({
        op: 'FRAMES',
        timestampMs: dto.timestampMs,
        intervalMs: dto.intervalMs ?? null,
        maxFrames: dto.maxFrames ?? null,
      })
    : JSON.stringify({
        op: 'FRAMES',
        intervalMs: dto.intervalMs ?? DEFAULT_FRAME_INTERVAL_MS,
        maxFrames: dto.maxFrames ?? DEFAULT_MAX_FRAMES,
      });
}

/**
 * Sample positions for the SCREENING PREVIEW (the pre-storage upload
 * screen no longer samples — it consumes the complete 1 fps frame stream):
 * one frame per STARTED second — Math.ceil, because a 1.9 s clip
 * has TWO started seconds and Math.floor would leave its entire second
 * second unpreviewable — capped at maxFrames. While the cap is not hit,
 * sample i lands at the START of second i: exactly one sample inside every
 * started second, and the last one strictly below durationMs (for every
 * durationMs > 0, (ceil(durationMs/1000) - 1) * 1000 < durationMs — the
 * exclusive endpoint holds because no frame exists AT durationMs). When
 * the cap bites, the capped count is instead spread evenly across the
 * duration with the same exclusive endpoint. A very short (or zero-probed)
 * clip yields a single sample at 0.
 */
function screeningSampleTimestampsMs(
  durationMs: number,
  maxFrames: number,
): number[] {
  const startedSeconds = Math.ceil(durationMs / 1000);
  const count = Math.max(1, Math.min(maxFrames, startedSeconds));
  return Array.from({ length: count }, (_, index) =>
    count === startedSeconds
      ? index * 1000
      : Math.floor((durationMs * index) / count),
  );
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

  /**
   * Ceiling on the probed duration eligible for the pre-storage frame
   * screen (VIDEO_MAX_SCREENING_DURATION_MS, boot-validated to
   * 1000..300000 ms). NOTE: there is NO unscreened-upload bypass — the
   * former VIDEO_UNSAFE_ALLOW_UNSCREENED_UPLOADS flag is unsupported in
   * every environment (validateEnv fails startup when it is true) and is
   * never read here: raw media is never persisted before screening.
   */
  private readonly maxScreeningDurationMs: number;

  constructor(
    private readonly repository: VideoAssetsRepository,
    private readonly storage: VideoStoragePort,
    private readonly extractor: VideoFrameExtractorPort,
    private readonly recognizer: FrameTextRecognizerPort,
    private readonly inferenceJobsService: InferenceJobsService,
    private readonly platformModulesService: PlatformModulesService,
    private readonly auditLog: AuditLogService,
    config: ConfigService,
  ) {
    const configured = config.get<string>('VIDEO_MAX_UPLOAD_BYTES');
    const parsed = Number(configured);
    this.maxUploadBytes =
      Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_UPLOAD_BYTES;
    // Boot validation already enforces the 1000..300000 bounds; the
    // re-check here keeps the invariant local (same idiom as
    // maxUploadBytes) so a value that somehow skipped validateEnv can
    // never zero out or balloon the screening window.
    const configuredScreeningMs = Number(
      config.get<string>('VIDEO_MAX_SCREENING_DURATION_MS'),
    );
    this.maxScreeningDurationMs =
      Number.isInteger(configuredScreeningMs) &&
      configuredScreeningMs >= 1000 &&
      configuredScreeningMs <= 300_000
        ? configuredScreeningMs
        : DEFAULT_MAX_SCREENING_DURATION_MS;
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
    // FAIL CLOSED, FIRST — before any row or byte is accepted: filename and
    // container-text checks cannot see a PAN shown IN THE PIXELS, so an
    // upload may reach durable storage only after REAL frame screening
    // (extract real frames, recognize their text, run the fused sensitive-
    // text predicate). When the configured extractor does not read real
    // bytes or the recognizer does not read real pixels that screen cannot
    // run — refuse the upload with a controlled 503 naming the required
    // configuration. There is NO exception and NO environment carve-out:
    // an upload is never persisted unscreened, in development, test, or
    // production alike (the former unscreened-upload override is
    // unsupported and rejected at startup).
    if (!this.extractor.readsRealBytes || !this.recognizer.readsRealPixels) {
      throw new ServiceUnavailableException(
        'Uploads are refused: pre-storage frame screening cannot run ' +
          'because the configured extractor and/or frame-text recognizer ' +
          'do not read the real media — configure VIDEO_FFMPEG_ENABLED=true ' +
          'and VIDEO_OCR_ENABLED=true (uploads are never stored unscreened ' +
          'in any environment)',
      );
    }
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
    // DB-FIRST STAGING: the asset row (PENDING_MEDIA, with the storage key,
    // size, and checksum — all known from the in-memory buffer) commits
    // BEFORE any byte reaches storage. The old put-then-create ordering had
    // an unrecoverable orphan class: a crash between the two stranded
    // quarantined media that no row referenced, so nothing could ever find
    // or clean it. The row lands in the NON-SCREENABLE PENDING_MEDIA state,
    // not QUARANTINED: a row that was already screenable before its media
    // landed opened a race where a concurrent screener APPROVEd it inside
    // the staging window, the put then failed, and the FAILED compensation
    // lost its CAS to that approval — leaving an UPLOADED asset with no
    // media. PENDING_MEDIA closes the window (screening decisions, the
    // screening preview, validate, and extraction all 409 on it); the
    // asset is PUBLISHED for screening (PENDING_MEDIA → QUARANTINED, an
    // audited CAS) only after the put succeeds. A crash between the row
    // commit and the publish leaves a PENDING_MEDIA row — THE ROW IS THE
    // RECOVERY RECORD: DELETE /video-assets/:id cleans it (screening
    // REJECT is not applicable — the asset never became screenable). A
    // side benefit: hierarchy-validation rejections happen before any
    // bytes are written, so those paths need no cleanup at all.
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
            // the asset stays PENDING_MEDIA (not screenable, not
            // processable) until the media write succeeds and publishes it
            // QUARANTINED for the screening decision.
            reason:
              'Test video staged PENDING_MEDIA: the metadata row committed ' +
              'before the media write; the asset becomes screenable ' +
              '(QUARANTINED) only after its media is stored (operator ' +
              'attested: no payment-card or credential content in frames)',
          }),
      );
    } catch (error) {
      if (prismaErrorCode(error) === 'P2003') {
        // No bytes were written yet — a broken reference is a clean 400
        // with nothing to clean up.
        throw new BadRequestException(
          'A referenced store, unit, device, or session does not exist in this tenant',
        );
      }
      throw error;
    }
    if (typeof result === 'string') {
      // Hierarchy rejection (same vocabulary as inference enqueue) — the
      // row never committed and no bytes were written: nothing to clean up.
      throw new BadRequestException(this.referenceRejectionMessage(result, dto));
    }
    const created = result;
    // PRE-STORAGE FRAME SCREEN — between the staging-row commit and the
    // durable media write, and ENTIRELY IN MEMORY: the unscreened buffer
    // never touches the durable storage root (the extractor port's
    // buffer-inspection session is in-memory only — a crash mid-screen
    // leaves nothing under VIDEO_STORAGE_ROOT, only the PENDING_MEDIA
    // row, which DELETE cleans). The COMPLETE 1 fps frame stream — one
    // real frame for EVERY started second, after the duration cap gate —
    // is OCR-screened with the same fused sensitive-text predicate as
    // every other surface, and only a clean, COMPLETE pass reaches
    // storage.put below. A hit, an over-cap duration, incomplete frame
    // coverage, or a frame over the screening byte budget rejects the row
    // (PRESTORE_SCREENING_REJECTED) with the media NEVER having reached
    // durable storage; tooling trouble fails the row (UPLOAD_INCOMPLETE)
    // exactly like a failed media write. UNCONDITIONAL — the availability
    // gate above already guaranteed the screen can run.
    await this.screenFramesBeforeStorage(
      tenantId,
      created.id,
      file.buffer,
      actor,
    );
    // SHRINK the delete/put race window: a DELETE that completed during
    // the in-memory screen has already run its prefix cleanup — writing
    // the media NOW would recreate bytes under a prefix whose delete
    // caller was told cleanup completed. The advisory-lock-guarded read
    // serializes with softDelete (same per-asset lock), so a 'live'
    // answer means no delete had committed at the moment of the read;
    // anything else skips the write with the same controlled 409 the
    // publish CAS produces. This is a WINDOW-SHRINKING pre-check only —
    // the lock is not held across the file write, so the publish CAS
    // below (plus its escalating compensation) remains the authority.
    const liveness = await this.repository.assetLivenessUnderLock(
      tenantId,
      created.id,
    );
    if (liveness !== 'live') {
      throw new ConflictException(UPLOAD_DELETED_CONFLICT_MESSAGE);
    }
    try {
      await this.storage.put(storageKey, file.buffer);
    } catch (error) {
      if (error instanceof VideoStorageOperationError) {
        // Environmental (disk full, permissions) — the committed row now
        // references media that never landed. Best-effort removal of the
        // media directory first (put publishes atomically, but the parent
        // directory may exist; a persistent removal failure is swallowed
        // here — the FAILED row below is the durable evidence an operator
        // acts on, and prefix removal is idempotent), then the audited CAS
        // transition PENDING_MEDIA → FAILED with a stable UPLOAD_INCOMPLETE
        // code (error codes exist exactly on REJECTED/FAILED — the DB
        // error_only_terminal_check constraint). The CAS cannot lose to a
        // screening decision (PENDING_MEDIA is not screenable) — only to a
        // concurrent DELETE, which already cleans the row. The row is KEPT
        // as durable evidence referencing the key; the caller sees the
        // storage failure as the existing controlled 503.
        try {
          await this.removeAssetMediaDir(
            storageKey,
            'The upload media could not be stored and its partial media ' +
              'directory could not be removed; local video storage needs ' +
              'attention',
          );
        } catch {
          // Best-effort: the FAILED transition below must still record the
          // incomplete upload even when the removal escalates.
        }
        await this.repository.transitionStatus(
          tenantId,
          created.id,
          [VideoAssetStatus.PENDING_MEDIA],
          {
            status: VideoAssetStatus.FAILED,
            errorCode: VIDEO_ERROR_CODES.UPLOAD_INCOMPLETE,
            errorMessage:
              'The upload was recorded but its media could not be stored',
          },
          (before, after) =>
            this.auditEntry(tenantId, actor, {
              action: AuditAction.UPDATE,
              entityType: 'VideoAsset',
              entityId: created.id,
              before,
              after,
              reason:
                'Upload staging incomplete: the asset row committed but the ' +
                'media write failed; the row is kept as the recovery record',
            }),
        );
        throw new ServiceUnavailableException(error.message);
      }
      throw error;
    }
    // PUBLISH for screening: only now that the media is durably stored does
    // the asset become screenable (PENDING_MEDIA → QUARANTINED, audited
    // CAS). Screening decisions 409 on PENDING_MEDIA, so no screener can
    // have touched the asset inside the staging window.
    const published = await this.repository.transitionStatus(
      tenantId,
      created.id,
      [VideoAssetStatus.PENDING_MEDIA],
      { status: VideoAssetStatus.QUARANTINED },
      (before, after) =>
        this.auditEntry(tenantId, actor, {
          action: AuditAction.UPDATE,
          entityType: 'VideoAsset',
          entityId: created.id,
          before,
          after,
          reason:
            'Upload media stored: staged asset published QUARANTINED ' +
            'pending frame-content screening',
        }),
    );
    if (!published) {
      // The publish CAS can lose only to a concurrent DELETE (nothing else
      // touches PENDING_MEDIA). The soft-deleted row is durable and its
      // delete flow removes the media dir — but that removal may have run
      // BEFORE our put landed (the delete's caller was then told cleanup
      // completed), so re-run the idempotent removal. When it succeeds,
      // the controlled 409 below is the truthful outcome. When it fails
      // twice, the failure is NEVER swallowed: the just-written media
      // would survive indefinitely under a prefix whose removal the
      // delete already reported complete, with no honest retry signal —
      // so the durable cleanup obligation is recorded in the audit trail
      // and surfaced as a retryable 503 naming the recovery path (the
      // idempotent DELETE replay re-runs the same prefix removal).
      try {
        await this.removeAssetMediaDir(
          storageKey,
          UPLOAD_RACE_MEDIA_ORPHAN_MESSAGE,
        );
      } catch (error) {
        await this.auditLog.record(
          this.auditEntry(tenantId, actor, {
            action: AuditAction.UPDATE,
            entityType: 'VideoAsset',
            entityId: created.id,
            reason:
              'Upload publish lost to a concurrent delete and the ' +
              'compensating media removal failed: the just-stored media ' +
              'remains orphaned under the deleted asset\'s storage prefix ' +
              '— a durable cleanup obligation, discharged by replaying ' +
              'the idempotent DELETE /video-assets/:id prefix removal',
          }),
        );
        throw error;
      }
      throw new ConflictException(UPLOAD_DELETED_CONFLICT_MESSAGE);
    }
    return published;
  }

  /**
   * Shared retry/escalate removal of an asset's media directory (the
   * original plus any extracted artifacts): one retry for transient errors,
   * then a controlled 503 with the caller's condition-specific message —
   * a removal failure is never silently swallowed. Propagates the storage
   * port's "did anything exist" report as INFORMATION ONLY: the exactly-
   * once media-removal COMPLETION evidence is decided by the repository's
   * `mediaRemovedAt` marker CAS, never by this boolean (which two
   * concurrent removals can both observe as true, and which a replay
   * observes as false even when the earlier completion audit never
   * committed).
   */
  private async removeAssetMediaDir(
    storageKey: string,
    escalationMessage: string,
  ): Promise<boolean> {
    const dir = storageKey.slice(0, storageKey.lastIndexOf('/'));
    try {
      return await this.storage.deletePrefix(dir);
    } catch {
      try {
        return await this.storage.deletePrefix(dir);
      } catch {
        throw new ServiceUnavailableException(escalationMessage);
      }
    }
  }

  /**
   * The PRE-STORAGE frame screen: the enforced control against a PAN (or
   * credential) that is visible IN THE PIXELS of an upload — which no
   * filename or container-text check can see, and which the attestation
   * proves nothing about. Runs BETWEEN the PENDING_MEDIA row commit and the
   * durable storage.put, and consumes the IN-MEMORY buffer — the
   * unscreened bytes never touch the durable storage root:
   *
   * 1. The buffer is opened through the extractor port's buffer-inspection
   *    session (IN-MEMORY ONLY — no implementation may write the
   *    unscreened bytes to any disk; opening runs no tooling).
   * 2. The probed duration is gated by the configured screening ceiling
   *    (VIDEO_MAX_SCREENING_DURATION_MS): a longer clip cannot be fully
   *    screened inside the synchronous request, so it is REJECTED (audited
   *    CAS PENDING_MEDIA → REJECTED, PRESTORE_SCREENING_REJECTED,
   *    controlled 400) BEFORE any frame extraction or storage write —
   *    fail closed, never a partial screen.
   * 3. The COMPLETE 1 fps frame stream is decoded in ONE pass
   *    (session.extractFramesPerSecond — frame i is second i of the clip,
   *    timestamp i*1000 ms) under a per-frame byte budget, and EVERY
   *    returned frame's recognized text (requires a pixel-reading
   *    recognizer — enforced by the caller's availability gate) runs
   *    through the SAME fused sensitive-text predicate as every persisted
   *    surface (Luhn-wins PAN windows, credentials, fused labels).
   * 4. A hit → audited CAS PENDING_MEDIA → REJECTED with the stable
   *    PRESTORE_SCREENING_REJECTED code, controlled 400. The recognized
   *    text is CARD DATA and is never echoed, stored, or audited — only
   *    the tripping frame's index (= second) is recorded. The media never
   *    reaches durable storage.
   * 5. INCOMPLETE COVERAGE — fewer decoded frames than started seconds
   *    (ceil(durationMs/1000)), ZERO frames included: every started
   *    second must have been screened, so partial coverage FAILS CLOSED —
   *    the same audited rejection path as a hit with a distinct
   *    "incomplete frame coverage" reason, controlled 400, nothing
   *    durably stored.
   * 6. A frame over the per-frame screening byte budget
   *    (FrameExceedsBudgetError) → a frame that cannot be inspected
   *    cannot be stored: same audited rejection path, distinct reason,
   *    controlled 400.
   * 7. Tooling trouble (extractor/recognizer infrastructure — or a frame
   *    the recognizer could not process: an unreadable frame is an
   *    INCOMPLETE screen, never a pass, so it fails closed too) → CAS
   *    PENDING_MEDIA → FAILED (UPLOAD_INCOMPLETE), 503 — the same
   *    recovery contract as a failed media write (fresh upload retries;
   *    the row is the record).
   * 8. Unreadable content (the bytes cannot be probed as a video — an
   *    unstreamable container layout included) → CAS PENDING_MEDIA →
   *    REJECTED (PROBE_FAILED), 400 with a fixed, controlled message.
   *
   * The inspection session is closed in EVERY path (finally). A close
   * failure means the adapter could not remove its ephemeral scratch bytes
   * — that fails closed too (it replaces a pending pass/hit verdict and
   * maps through the infrastructure branch below to FAILED +
   * UPLOAD_INCOMPLETE, 503) so unscreened bytes are never silently left
   * behind while the upload "succeeds".
   */
  private async screenFramesBeforeStorage(
    tenantId: string,
    assetId: string,
    buffer: Buffer,
    actor: AuditActor | undefined,
  ): Promise<void> {
    let hitFrameIndex: number | null = null;
    let overCapDurationMs: number | null = null;
    let frameOverBudget = false;
    let coverage: { screened: number; required: number } | null = null;
    let failure: unknown = null;
    let session: BufferInspectionSession | null = null;
    try {
      session = await this.extractor.inspectBuffer(buffer);
      const probe = await session.probe();
      if (probe.durationMs > this.maxScreeningDurationMs) {
        // Gate BEFORE any frame extraction: a clip longer than the
        // screening ceiling cannot have EVERY started second screened
        // inside the synchronous request — fail closed, decode nothing.
        overCapDurationMs = probe.durationMs;
      } else {
        // COMPLETE coverage is the contract: one frame per STARTED second
        // (ceil — a 1.9 s clip has TWO started seconds; a zero-probed
        // duration still requires one screenable frame, or nothing was
        // actually screened). Frame i is second i (timestamp i*1000 ms).
        const requiredFrames = Math.max(1, Math.ceil(probe.durationMs / 1000));
        let frames: Buffer[] = [];
        try {
          frames = await session.extractFramesPerSecond({
            maxBytesPerFrame: PRESTORE_SCREENING_MAX_FRAME_BYTES,
          });
        } catch (error) {
          if (error instanceof FrameUnavailableError) {
            // The decode succeeded but yielded no frame at all — handled
            // below as zero-of-required coverage, never a pass.
            frames = [];
          } else if (error instanceof FrameExceedsBudgetError) {
            // A frame that cannot fit the screening budget cannot be
            // inspected — and an uninspected frame is never stored.
            frameOverBudget = true;
          } else {
            throw error;
          }
        }
        if (!frameOverBudget) {
          if (frames.length < requiredFrames) {
            // PARTIAL coverage is NOT enough: every started second must
            // have been screened before the bytes may persist.
            coverage = { screened: frames.length, required: requiredFrames };
          } else {
            for (
              let index = 0;
              index < frames.length && hitFrameIndex === null;
              index += 1
            ) {
              const text = await this.recognizer.recognize(frames[index]);
              if (containsSensitiveFreeText(text)) {
                hitFrameIndex = index;
              }
            }
          }
        }
      }
    } catch (error) {
      failure = error;
    } finally {
      // The session is closed in EVERY path — pass, hit, and failure —
      // before any verdict is recorded. The adapter owns the retry; a
      // persistent scratch-cleanup failure surfaces here and REPLACES a
      // pending pass/hit verdict (fail closed — an original failure is
      // kept: it is the more specific classification and both fail
      // closed).
      if (session !== null) {
        try {
          await session.close();
        } catch (error) {
          if (failure === null) {
            failure = error;
          }
        }
      }
    }
    if (failure !== null) {
      throw await this.mapPrestoreScreeningError(
        tenantId,
        assetId,
        actor,
        failure,
      );
    }
    if (overCapDurationMs !== null) {
      // FAIL CLOSED — the clip is too long to fully screen: every started
      // second must be screened before storage, and a clip over the
      // configured ceiling cannot be. Rejected BEFORE any frame decode or
      // storage write; same audited rejection path as a hit, distinct
      // reason.
      throw await this.rejectStagedUpload(tenantId, assetId, actor, {
        errorMessage:
          'Pre-storage frame screening refused this upload: the video ' +
          'exceeds the Phase 10 screening duration limit; its media ' +
          'never reached durable storage',
        auditReason:
          'Pre-storage frame screening refused the upload: the probed ' +
          `duration (${overCapDurationMs} ms) exceeds the configured ` +
          `VIDEO_MAX_SCREENING_DURATION_MS ceiling of ` +
          `${this.maxScreeningDurationMs} ms — every started second must ` +
          'be screened before storage, so an unscreenable-length clip is ' +
          'never stored; the media never reached durable storage',
        responseMessage:
          'The video exceeds the Phase 10 screening duration limit of ' +
          `${this.maxScreeningDurationMs} ms; nothing was stored`,
      });
    }
    if (frameOverBudget) {
      // FAIL CLOSED — a decoded frame overran the per-frame screening
      // byte budget: a frame that cannot be inspected cannot be stored.
      throw await this.rejectStagedUpload(tenantId, assetId, actor, {
        errorMessage:
          'Pre-storage frame screening refused this upload: a frame ' +
          'exceeds the screening byte budget and could not be inspected; ' +
          'its media never reached durable storage',
        auditReason:
          'Pre-storage frame screening refused the upload: a decoded ' +
          'frame exceeds the per-frame screening byte budget — a frame ' +
          'that cannot be inspected cannot be stored (an unscreened ' +
          'upload is never stored); the media never reached durable storage',
        responseMessage:
          'Pre-storage frame screening refused the upload: a frame ' +
          'exceeds the screening byte budget and could not be inspected; ' +
          'nothing was stored',
      });
    }
    if (coverage !== null) {
      // FAIL CLOSED — incomplete frame coverage (zero frames included):
      // the probe accepted the container but the 1 fps pass yielded fewer
      // frames than the clip has started seconds, so at least one second
      // was NEVER screened. Partial coverage is not a pass.
      throw await this.rejectStagedUpload(tenantId, assetId, actor, {
        errorMessage:
          'Pre-storage frame screening refused this upload: incomplete ' +
          'frame coverage; its media never reached durable storage',
        auditReason:
          'Pre-storage frame screening refused the upload: incomplete ' +
          `frame coverage — ${coverage.screened} of ${coverage.required} ` +
          'started second(s) yielded a screenable frame, and EVERY ' +
          'started second must be screened (an unscreened upload is never ' +
          'stored); the media never reached durable storage',
        responseMessage:
          'Pre-storage frame screening refused the upload: incomplete ' +
          'frame coverage — not every started second of the clip could ' +
          'be screened; nothing was stored',
      });
    }
    if (hitFrameIndex !== null) {
      // The terminal claim mirrors the quarantine screening REJECT — but
      // here nothing was ever durably stored, so there is no media removal
      // to record. The CAS can lose only to a concurrent DELETE (nothing
      // else touches PENDING_MEDIA); either way the media never lands and
      // the controlled 400 below is the truthful outcome. NO recognized
      // text is recorded anywhere — it is (potential) card data; only
      // WHICH frame (= which second) tripped the screen.
      throw await this.rejectStagedUpload(tenantId, assetId, actor, {
        errorMessage:
          'Pre-storage frame screening rejected this upload; its media ' +
          'never reached durable storage',
        auditReason:
          'Pre-storage frame screening rejected the upload: frame ' +
          `${hitFrameIndex} (second ${hitFrameIndex} of the clip) carries ` +
          'credential- or payment-bearing text (the recognized text is ' +
          'never recorded); the media never reached durable storage',
        responseMessage:
          'Pre-storage frame screening rejected the upload: a screened ' +
          'frame carries credential- or payment-bearing content; nothing ' +
          'was stored',
      });
    }
  }

  /**
   * Shared audited rejection for every fail-closed PRE-STORAGE screening
   * verdict (hit, over-cap duration, incomplete coverage, over-budget
   * frame): the audited CAS PENDING_MEDIA → REJECTED with the stable
   * PRESTORE_SCREENING_REJECTED code — REJECTED (not a bare 400) because
   * that is the module's terminal "this content was refused" state, it is
   * exactly how the quarantine screening rejection records its verdict,
   * and the row's error code/message are the durable evidence an operator
   * reads. The CAS can lose only to a concurrent DELETE; either way the
   * media never reached durable storage and the returned controlled 400
   * is the truthful outcome.
   */
  private async rejectStagedUpload(
    tenantId: string,
    assetId: string,
    actor: AuditActor | undefined,
    messages: {
      errorMessage: string;
      auditReason: string;
      responseMessage: string;
    },
  ): Promise<BadRequestException> {
    await this.repository.transitionStatus(
      tenantId,
      assetId,
      [VideoAssetStatus.PENDING_MEDIA],
      {
        status: VideoAssetStatus.REJECTED,
        errorCode: VIDEO_ERROR_CODES.PRESTORE_SCREENING_REJECTED,
        errorMessage: messages.errorMessage,
      },
      (before, after) =>
        this.auditEntry(tenantId, actor, {
          action: AuditAction.UPDATE,
          entityType: 'VideoAsset',
          entityId: assetId,
          before,
          after,
          reason: messages.auditReason,
        }),
    );
    return new BadRequestException(messages.responseMessage);
  }

  /**
   * Failure mapping for the pre-storage frame screen. Infrastructure
   * trouble — extractor or recognizer — AND a frame the recognizer could
   * not process both fail CLOSED into the existing staged-upload failure
   * contract: audited CAS PENDING_MEDIA → FAILED (UPLOAD_INCOMPLETE) and a
   * retryable 503 (a fresh upload retries; the row is the record) —
   * consistent with the put-failure path. Content that cannot even be
   * probed as a video is an audited CAS PENDING_MEDIA → REJECTED
   * (PROBE_FAILED) and a controlled 400. In every branch the media never
   * reached durable storage.
   */
  private async mapPrestoreScreeningError(
    tenantId: string,
    assetId: string,
    actor: AuditActor | undefined,
    error: unknown,
  ): Promise<Error> {
    if (
      error instanceof ExtractorUnavailableError ||
      error instanceof ExtractionInfrastructureError ||
      error instanceof FrameTextRecognizerUnavailableError ||
      error instanceof FrameTextRecognitionInfrastructureError ||
      // The tool ran and could not process the frame: an unreadable frame
      // is an INCOMPLETE screen, never a pass — fail closed as retryable.
      error instanceof FrameTextRecognitionFailedError
    ) {
      await this.repository.transitionStatus(
        tenantId,
        assetId,
        [VideoAssetStatus.PENDING_MEDIA],
        {
          status: VideoAssetStatus.FAILED,
          errorCode: VIDEO_ERROR_CODES.UPLOAD_INCOMPLETE,
          errorMessage:
            'The upload was recorded but its pre-storage frame screening ' +
            'could not be completed',
        },
        (before, after) =>
          this.auditEntry(tenantId, actor, {
            action: AuditAction.UPDATE,
            entityType: 'VideoAsset',
            entityId: assetId,
            before,
            after,
            reason:
              'Upload staging incomplete: pre-storage frame screening ' +
              'could not be completed (tooling failure — not a property of ' +
              'the video); the row is kept as the recovery record',
          }),
      );
      return new ServiceUnavailableException(
        'Pre-storage frame screening could not be completed; the staged ' +
          'upload was marked FAILED — retry with a fresh upload',
      );
    }
    if (error instanceof ExtractionFailedError) {
      await this.repository.transitionStatus(
        tenantId,
        assetId,
        [VideoAssetStatus.PENDING_MEDIA],
        {
          status: VideoAssetStatus.REJECTED,
          errorCode: VIDEO_ERROR_CODES.PROBE_FAILED,
          errorMessage:
            'The file could not be read as a video during pre-storage ' +
            'frame screening',
        },
        (before, after) =>
          this.auditEntry(tenantId, actor, {
            action: AuditAction.UPDATE,
            entityType: 'VideoAsset',
            entityId: assetId,
            before,
            after,
            reason:
              'Pre-storage frame screening rejected the upload: the staged ' +
              'bytes could not be read as a video; the media never reached ' +
              'durable storage',
          }),
      );
      return new BadRequestException(
        'The file could not be read as a video during pre-storage frame ' +
          'screening; nothing was stored',
      );
    }
    return error instanceof Error
      ? error
      : new Error('Pre-storage frame screening failed');
  }

  /**
   * Cleanup of staged artifact files that will never get rows (the atomic
   * publish failed) or that lost a concurrent-replay race. A cleanup
   * failure is NEVER swallowed — an unreferenced staged file would strand
   * untracked media on disk. One retry per file, then a controlled 503
   * naming the orphan condition. Successfully deleted keys are consumed
   * from the list, so attempts stay bounded even if a caller re-enters
   * after escalation.
   *
   * COMMITTED keys are never deleted: staging keys are DETERMINISTIC per
   * request (asset + idempotency key + canonical fingerprint), so the keys
   * this attempt staged can be the very keys an earlier committed batch
   * recorded — a replayed identical request, the loser of a same-key
   * P2002 race, or a keyless identical retry all stage over the winner's
   * files. Deleting those would destroy media that live artifact rows
   * reference, so ownership is checked against the committed rows first;
   * when that check itself cannot run, the cleanup FAILS CLOSED (503,
   * files kept): the staged files sit at deterministic keys, an identical
   * retry overwrites them and asset deletion removes the whole prefix, so
   * keeping them is always recoverable — deleting blindly is not.
   */
  private async cleanupStagedArtifacts(
    tenantId: string,
    staged: string[],
  ): Promise<void> {
    if (staged.length === 0) {
      return;
    }
    let committed: Set<string>;
    try {
      committed = new Set(
        await this.repository.listArtifactStorageKeys(tenantId, staged),
      );
    } catch {
      throw new ServiceUnavailableException(
        'The extraction left staged artifact files whose ownership could ' +
          'not be verified; they were kept (an identical retry overwrites ' +
          'them and asset deletion removes them) — retry once the ' +
          'persistence layer recovers',
      );
    }
    while (staged.length > 0) {
      const storageKey = staged[0];
      if (!committed.has(storageKey)) {
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
      }
      staged.shift();
    }
  }

  private referenceRejectionMessage(
    rejection: AssetReferenceRejection,
    dto: UploadVideoAssetDto,
  ): string {
    // Every interpolated value is CALLER-SUPPLIED and unresolved (the
    // rejection proves it references nothing in this tenant), so it runs
    // through the same redaction as existence-blind audit entity ids: a
    // PAN smuggled as locationId/unitId/deviceId/sessionId must never be
    // reflected verbatim into the 400 message.
    const locationId = safeReference(dto.locationId);
    const unitId = safeReference(dto.unitId);
    const deviceId = safeReference(dto.deviceId);
    const sessionId = safeReference(dto.sessionId);
    switch (rejection) {
      case 'location-not-found':
        return `Store "${locationId}" not found`;
      case 'unit-not-found':
        return `Unit "${unitId}" not found`;
      case 'unit-location-mismatch':
        return `Unit "${unitId}" does not belong to store "${locationId}"`;
      case 'device-not-found':
        return `Device "${deviceId}" not found`;
      case 'device-unit-mismatch':
        return `Device "${deviceId}" is not attached to unit "${unitId}"`;
      case 'device-location-mismatch':
        return `Device "${deviceId}" is not in store "${locationId}"`;
      case 'session-not-found':
        return `Session "${sessionId}" not found`;
      case 'session-unit-mismatch':
        return `Session "${sessionId}" is not on unit "${unitId}"`;
      case 'session-location-mismatch':
        return `Session "${sessionId}" is not in the asset's store`;
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
      throw new NotFoundException(
        `Video asset "${safeAuditEntityId(id)}" not found`,
      );
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
      throw new NotFoundException(
        `Video artifact "${safeAuditEntityId(artifactId)}" not found`,
      );
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
      throw new NotFoundException(
        `Video asset "${safeAuditEntityId(id)}" not found`,
      );
    }
    if (
      internal.status === VideoAssetStatus.VALIDATED ||
      internal.status === VideoAssetStatus.READY
    ) {
      return this.findById(tenantId, id);
    }
    if (internal.status === VideoAssetStatus.PENDING_MEDIA) {
      // Staged, media write not confirmed — nothing may touch the bytes
      // (they may not even exist). A crash in the staging window leaves
      // this recovery record; DELETE cleans it.
      throw new ConflictException(
        'Video asset is PENDING_MEDIA: its media write never completed, so ' +
          'it cannot be validated; delete the asset and re-upload',
      );
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
   * for processing (QUARANTINED → UPLOADED); REJECT first CLAIMS the
   * terminal transition (QUARANTINED → REJECTED, stable error code — so a
   * racing APPROVE loses the CAS instead of releasing an asset whose bytes
   * are gone) and then removes the stored media with the same
   * retry/escalate policy as every other cleanup, parking the metadata row
   * as evidence — the claim records the removal as PENDING and a separate
   * completion audit entry lands only once the removal succeeds. A REJECT
   * retry on an asset already REJECTED with SCREENING_REJECTED replays the
   * media removal (recovery for a removal that failed post-claim); any
   * other decision on a non-QUARANTINED asset — PENDING_MEDIA included
   * (staged, never screenable) — is a controlled 409. A later phase plugs an automated CV frame
   * screener into this same step; the manual decision is the MVP.
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
      // Screened with the single fused free-text predicate so fused
      // credential labels ("cvv123", "pin1234") reject exactly like
      // key=value fragments, known secret tokens, and PAN windows — and
      // the rejection happens BEFORE any read or transition.
      assertPlainId('note', dto.note);
      if (containsSensitiveFreeText(dto.note)) {
        throw new BadRequestException(
          'note must not contain credential- or payment-bearing content',
        );
      }
    }
    const internal = await this.repository.findByIdInternal(tenantId, id);
    if (!internal) {
      throw new NotFoundException(
        `Video asset "${safeAuditEntityId(id)}" not found`,
      );
    }
    // REJECT replay — allowed for EXACTLY errorCode SCREENING_REJECTED and
    // no other REJECTED asset: the claim-first ordering below can leave a
    // REJECTED row whose media removal failed (503). Replaying the
    // rejection is the documented recovery path for that orphan condition:
    // it re-attempts the (idempotent) removal and returns success once the
    // media is gone. Assets rejected for any other reason (PROBE_FAILED)
    // never claimed their media through screening and stay 409s below.
    if (
      dto.decision === VideoScreeningDecision.REJECT &&
      internal.status === VideoAssetStatus.REJECTED &&
      internal.errorCode === VIDEO_ERROR_CODES.SCREENING_REJECTED
    ) {
      await this.removeAssetMediaDir(
        internal.storageKey,
        SCREENING_MEDIA_ORPHAN_MESSAGE,
      );
      // Completion is recorded EXACTLY ONCE by the DB marker CAS — never
      // by deletePrefix's "did anything exist" report, which two
      // concurrent removals can both observe as true, and which a replay
      // observes as false even when the earlier attempt's completion
      // audit never committed. Calling unconditionally after the bytes
      // are confirmed gone lets a replay REPAIR a missing completion
      // record; the marker guarantees no duplicate is ever written.
      await this.recordMediaRemovalCompleted(
        tenantId,
        id,
        actor,
        'screening-rejection',
      );
      return this.findById(tenantId, id);
    }
    // This gate covers PENDING_MEDIA too — an asset whose media write has
    // not succeeded (or never will) was NEVER screenable, so no decision
    // can race the upload's staging window. The interpolated status makes
    // the 409 truthful for every non-QUARANTINED state.
    if (internal.status !== VideoAssetStatus.QUARANTINED) {
      throw new ConflictException(
        `Video asset is ${internal.status}; only QUARANTINED assets accept ` +
          'a screening decision',
      );
    }
    const noteSuffix = dto.note ? `; note: ${dto.note}` : '';

    if (dto.decision === VideoScreeningDecision.APPROVE) {
      // MANDATORY INSPECTION EVIDENCE — the human backstop must have SEEN
      // the frames: APPROVE requires server-stamped evidence that a
      // real-media screening preview actually served frames to an
      // inspector, recently. The fast pre-check gives a clear 409 without
      // taking the lock; the AUTHORITATIVE re-check runs as the CAS
      // transaction's guard (same advisory lock as every decision), so the
      // evidence the approval consumes cannot be invalidated between a
      // pre-check and the transition. REJECT never requires evidence —
      // rejecting blind is safe.
      this.assertScreeningInspectionEvidence(internal);
      const approved = await this.repository.transitionStatus(
        tenantId,
        id,
        [VideoAssetStatus.QUARANTINED],
        { status: VideoAssetStatus.UPLOADED },
        (before, after) => {
          // The approval audit records the evidence it consumed: when the
          // inspection happened, how many real frames were served, and to
          // whom (an actor id is server-resolved but still passes the
          // redaction screen before interpolation).
          const inspectedAt =
            before.screeningInspectedAt?.toISOString() ?? 'unknown';
          const inspectedFrames = before.screeningInspectedFrames ?? 0;
          const inspectedBy = before.screeningInspectedBy
            ? safeAuditEntityId(before.screeningInspectedBy)
            : 'system';
          return this.auditEntry(tenantId, actor, {
            action: AuditAction.UPDATE,
            entityType: 'VideoAsset',
            entityId: id,
            before,
            after,
            reason:
              'Frame-content screening approved: quarantined upload ' +
              'released for processing (inspection evidence: ' +
              `${inspectedFrames} preview frame(s) served at ` +
              `${inspectedAt} to ${inspectedBy})${noteSuffix}`,
          });
        },
        (before) => this.assertScreeningInspectionEvidence(before),
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

    // REJECT: CLAIM FIRST — the audited terminal transition (QUARANTINED →
    // REJECTED, stable error code) commits BEFORE any media removal. The
    // old delete-first ordering had a race: a concurrent APPROVE could win
    // the CAS in the window after the bytes were gone, leaving an UPLOADED
    // asset with no media that still looked processable. Claim-first closes
    // it — an APPROVE racing after the claim simply loses the CAS and 409s.
    // The claim's durable message and audit reason state the removal is
    // PENDING, never that it happened: at claim time it has not, and the
    // removal can fail. Completion is recorded by a SEPARATE audit entry
    // written only after the removal actually succeeds (here or on a
    // replay), so the audit trail never claims media is gone while the
    // bytes are still on disk. Only once the rejection is durable does the
    // media removal run (retry once, then a controlled 503 naming the
    // orphan condition); a failure there leaves the asset REJECTED —
    // terminal, unprocessable, and never served — and the replay branch
    // above completes the removal (and its completion audit) on retry.
    const rejected = await this.repository.transitionStatus(
      tenantId,
      id,
      [VideoAssetStatus.QUARANTINED],
      {
        status: VideoAssetStatus.REJECTED,
        errorCode: VIDEO_ERROR_CODES.SCREENING_REJECTED,
        errorMessage:
          'Frame-content screening rejected this upload; media removal is ' +
          'pending (completion is recorded in the audit trail)',
      },
      (before, after) =>
        this.auditEntry(tenantId, actor, {
          action: AuditAction.UPDATE,
          entityType: 'VideoAsset',
          entityId: id,
          before,
          after,
          reason:
            'Frame-content screening rejected: media removal pending, ' +
            `metadata kept as evidence${noteSuffix}`,
        }),
    );
    if (!rejected) {
      throw new ConflictException(
        'The video asset changed concurrently; re-read it before screening ' +
          'again',
      );
    }
    await this.removeAssetMediaDir(
      internal.storageKey,
      SCREENING_MEDIA_ORPHAN_MESSAGE,
    );
    // The DB marker CAS (not deletePrefix's report) decides whether the
    // completion audit is written — exactly once under any interleaving;
    // if this record fails after the bytes were removed, the REJECT
    // replay above repairs the missing completion evidence.
    await this.recordMediaRemovalCompleted(
      tenantId,
      id,
      actor,
      'screening-rejection',
    );
    return rejected;
  }

  /**
   * The APPROVE evidence gate: server-stamped proof that a real-media
   * screening preview served at least one frame to an inspector within
   * SCREENING_INSPECTION_MAX_AGE_MS. The evidence is written ONLY by the
   * guarded preview-serve authorization (which itself runs only after the
   * readsRealBytes 503 gate and only for actually-served frames), so
   * missing/zero-frame/stale evidence means no qualifying inspection
   * happened — a controlled 409, never a blind release. Called twice per
   * approval: a fast pre-check on the initial read, then authoritatively
   * inside the decision's advisory-locked CAS transaction.
   */
  private assertScreeningInspectionEvidence(row: {
    screeningInspectedAt: Date | null;
    screeningInspectedFrames: number | null;
  }): void {
    const inspectedAt = row.screeningInspectedAt;
    const inspectedFrames = row.screeningInspectedFrames ?? 0;
    if (
      !inspectedAt ||
      inspectedFrames <= 0 ||
      Date.now() - inspectedAt.getTime() > SCREENING_INSPECTION_MAX_AGE_MS
    ) {
      throw new ConflictException(
        'Approving a quarantined upload requires a recorded real-media ' +
          'preview inspection: load the screening preview (it must serve ' +
          'at least one frame) within the last ' +
          `${SCREENING_INSPECTION_MAX_AGE_MS / 60_000} minutes, inspect ` +
          'the frames, then approve. Rejecting does not require a preview.',
      );
    }
  }

  /**
   * Durable evidence that an asset's media removal actually COMPLETED —
   * recorded only after the bytes are confirmed gone (removal succeeded or
   * the directory was already absent), never at claim time. The write goes
   * through the repository's `mediaRemovedAt` compare-and-set: the DB
   * marker — not the storage adapter's "did anything exist" report — is
   * the exactly-once authority, so concurrent removal replays can never
   * duplicate the completion entry, and a replay over already-removed
   * bytes REPAIRS a completion record whose audit write failed the first
   * time. AuditAction.DELETE on the VideoAsset: the closest existing
   * action to "the stored media bytes are gone" (the row itself is kept
   * as evidence); the reason distinguishes the screening-rejection
   * removal from the delete cleanup.
   */
  private async recordMediaRemovalCompleted(
    tenantId: string,
    id: string,
    actor: AuditActor | undefined,
    context: 'screening-rejection' | 'deletion-cleanup',
  ): Promise<void> {
    await this.repository.recordMediaRemovalCompleted(tenantId, id, () =>
      this.auditEntry(tenantId, actor, {
        action: AuditAction.DELETE,
        entityType: 'VideoAsset',
        entityId: id,
        reason:
          context === 'screening-rejection'
            ? 'Screening-rejection media removal completed: the stored ' +
              'media directory was removed; the REJECTED metadata row is ' +
              'kept as evidence'
            : 'Video asset deletion cleanup completed: linked inference ' +
              'jobs retired and the stored media directory removed; the ' +
              'soft-deleted metadata row is kept for lineage',
      }),
    );
  }

  /**
   * Quarantine-safe screening preview — the module's ONE deliberate
   * exception to "bytes are never served", so the screening decision is an
   * informed inspection instead of a second blind attestation. Serves a
   * bounded set of sample frames (evenly spaced across the probed duration,
   * capped at SCREENING_PREVIEW_MAX_FRAMES; a single frame for very short
   * clips) extracted IN MEMORY through the extractor port and returned as
   * base64 images with timestamps. NOTHING IS PERSISTED: no artifact rows,
   * no storage writes — and the response never carries the video container
   * or the original bytes (the video file itself stays non-downloadable).
   * Only QUARANTINED assets qualify (screening decisions are only pending
   * then — controlled 409 otherwise), and every served preview is recorded
   * in the audit trail (AuditAction.READ, with the frame count in the
   * reason). The preview REQUIRES a byte-reading extractor: the default
   * simulated adapter renders deterministic placeholder pixels that ignore
   * the stored media, and approving footage over placeholders would be a
   * blind attestation — so when the configured extractor does not read
   * real bytes the preview is a controlled 503 BEFORE any probe or audit,
   * and the screening decision simply stays open (REJECT never needed a
   * preview; APPROVE should wait for a real inspection path). Decoded
   * bytes are budgeted per response (SCREENING_PREVIEW_TOTAL_BYTES): the
   * remaining allowance bounds every extractor call BEFORE the decode, a
   * frame that cannot fit is skipped and reported, and the loop stops once
   * the remainder cannot hold any frame. Failure mapping mirrors
   * validate(): extractor missing or infrastructure trouble → 503;
   * unreadable content → controlled 400 WITHOUT any status transition —
   * the screening decision stays open and is never auto-rejected by a
   * preview failure. (A staged row whose media never landed is
   * PENDING_MEDIA, not QUARANTINED, so it 409s at the status gate before
   * any read.) SERVE AUTHORIZATION IS FINAL, NOT INITIAL: the extraction
   * runs outside any lock, then a guarded transaction takes the SAME
   * advisory lock as every screening-decision CAS, re-reads the status,
   * and writes the READ audit — so a decision committing mid-extraction
   * makes the preview discard its frames and 409 instead of auditing and
   * serving bytes under a stale status. That same guarded transaction is
   * the ONLY writer of the screening-inspection evidence the APPROVE
   * decision requires (stamped only when frames were actually served) —
   * which is why the readsRealBytes gate above matters twice: no preview,
   * no evidence, no approval.
   */
  async screeningPreview(
    tenantId: string,
    id: string,
    actor?: AuditActor,
  ): Promise<ScreeningPreviewResult> {
    assertPlainId('id', id);
    // Informed-inspection gate — checked FIRST, before any lookup, probe,
    // or audit: a preview served from an adapter that never reads the
    // stored bytes would show placeholder images while claiming to show
    // the quarantined footage. Controlled 503 (deployment configuration,
    // not asset state); no state changes, so the decision stays pending.
    if (!this.extractor.readsRealBytes) {
      throw new ServiceUnavailableException(
        'The screening preview requires a byte-reading extractor; ' +
          'configure VIDEO_FFMPEG_ENABLED — the configured extractor ' +
          'returns simulated placeholder frames, not the quarantined media',
      );
    }
    const internal = await this.repository.findByIdInternal(tenantId, id);
    if (!internal) {
      throw new NotFoundException(
        `Video asset "${safeAuditEntityId(id)}" not found`,
      );
    }
    // FAST-FAIL only — the AUTHORITATIVE status check is the final guarded
    // authorization below (this pre-check merely avoids pointless probes;
    // it also 409s PENDING_MEDIA rows, whose media may not even exist).
    if (internal.status !== VideoAssetStatus.QUARANTINED) {
      throw new ConflictException(
        `Video asset is ${internal.status}; the screening preview is only ` +
          'available while a screening decision is pending on a ' +
          'QUARANTINED asset',
      );
    }
    let probe: VideoProbeResult;
    try {
      probe = await this.extractor.probe(internal.storageKey);
    } catch (error) {
      throw this.mapPreviewError(error);
    }
    // Sample positions strictly inside the duration (exclusive endpoint —
    // no frame exists AT durationMs): one frame per STARTED second (ceil,
    // matching the pre-storage screen — a 1.9 s clip previews TWO frames),
    // capped. A very short clip yields a single frame at 0.
    const timestamps = screeningSampleTimestampsMs(
      probe.durationMs,
      SCREENING_PREVIEW_MAX_FRAMES,
    );
    const count = timestamps.length;
    const frames: ScreeningPreviewFrame[] = [];
    let retainedBytes = 0;
    let skippedOverBudget = 0;
    for (let index = 0; index < count; index += 1) {
      // The remaining allowance is computed BEFORE the decode and handed
      // to the extractor as this frame's byte cap — a near-exhausted
      // budget can never trigger another full-size decode, and once the
      // remainder cannot hold any frame the loop stops (the rest of the
      // sample positions are reported as skipped, never silently dropped).
      const remaining = SCREENING_PREVIEW_TOTAL_BYTES - retainedBytes;
      if (remaining < SCREENING_PREVIEW_MIN_FRAME_BYTES) {
        skippedOverBudget += count - index;
        break;
      }
      const timestampMs = timestamps[index];
      let image;
      try {
        image = await this.extractor.extractFrameAt(
          internal.storageKey,
          probe,
          timestampMs,
          { maxBytes: remaining },
        );
      } catch (error) {
        if (error instanceof FrameUnavailableError) {
          // Container durations routinely overshoot the last decodable
          // frame — a missing sample position is not a preview failure.
          continue;
        }
        if (error instanceof FrameExceedsBudgetError) {
          // The frame exceeds the REMAINING preview budget — a bounded
          // skip (reported below), never an infrastructure 503.
          skippedOverBudget += 1;
          continue;
        }
        throw this.mapPreviewError(error);
      }
      // Backstop for extractors that ignore the per-call cap: a frame that
      // would blow the budget is skipped and reported, never partially
      // returned.
      if (image.data.length > remaining) {
        skippedOverBudget += 1;
        continue;
      }
      retainedBytes += image.data.length;
      frames.push({
        timestampMs: image.timestampMs,
        width: image.width,
        height: image.height,
        mimeType: image.mimeType,
        imageBase64: image.data.toString('base64'),
      });
    }
    // FINAL GUARDED AUTHORIZATION: extraction ran outside any lock, so a
    // screening decision may have committed mid-extraction (and on POSIX
    // the extractor can keep reading an unlinked-while-open file even
    // after a rejection removed the media). One repository transaction now
    // takes the SAME advisory lock as every decision CAS, re-reads the
    // asset, and — only if it is STILL QUARANTINED — writes the audited
    // byte-exposing READ (closed-vocabulary fields; the frame counts ride
    // in the reason string) in that same transaction. Because decisions
    // and this guard serialize on the lock, a preview can never be audited
    // or served for an asset whose terminal decision committed first: any
    // other observed status discards the extracted frames and 409s, and a
    // concurrent delete 404s — with NO audit entry in either case.
    const authorized = await this.repository.authorizeScreeningPreviewServe(
      tenantId,
      id,
      // Inspection evidence for the APPROVE gate, stamped by the SAME
      // guarded transaction that authorizes and audits the serve — and
      // only when frames were ACTUALLY served: a preview whose every
      // sample position was skipped proves nothing was inspected, so it
      // must never enable an approval. This call is the only path that
      // can mint evidence, and it is only reachable past the
      // readsRealBytes 503 gate above — simulated extractors can never
      // produce approval evidence.
      { actorId: actor?.id ?? null, servedFrameCount: frames.length },
      () =>
        this.auditEntry(tenantId, actor, {
          action: AuditAction.READ,
          entityType: 'VideoAsset',
          entityId: id,
          reason:
            `Screening preview served: ${frames.length} sample frame(s) ` +
            'extracted in memory from the QUARANTINED upload for the audited ' +
            `screening decision (${skippedOverBudget} skipped over the byte ` +
            'budget; nothing persisted)',
        }),
    );
    if (authorized === null) {
      throw new NotFoundException(
        `Video asset "${safeAuditEntityId(id)}" not found`,
      );
    }
    if (authorized !== VideoAssetStatus.QUARANTINED) {
      throw new ConflictException(
        `Video asset is ${authorized}; the screening preview is only ` +
          'available while a screening decision is pending on a ' +
          'QUARANTINED asset',
      );
    }
    return {
      assetId: id,
      status: authorized,
      durationMs: probe.durationMs,
      frames,
      skippedOverBudget,
    };
  }

  /**
   * Failure mapping for the screening preview: environmental trouble is a
   * retryable 503, unreadable content is a controlled 400 — and NEITHER
   * transitions the asset (the pending screening decision stays open; a
   * preview failure never auto-rejects).
   */
  private mapPreviewError(error: unknown): Error {
    if (
      error instanceof ExtractorUnavailableError ||
      error instanceof ExtractionInfrastructureError
    ) {
      return new ServiceUnavailableException(error.message);
    }
    if (
      error instanceof ExtractionFailedError ||
      error instanceof FrameUnavailableError
    ) {
      return new BadRequestException(
        'The quarantined media could not be read for a preview; the ' +
          'screening decision remains open — inspect the clip through the ' +
          'staging process or reject it if it cannot be verified',
      );
    }
    return error instanceof Error ? error : new Error('Preview failed');
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
    // Route id validated before ANY read (incl. the replay lookup), matching
    // every other endpoint's validate-first ordering.
    assertPlainId('id', id);
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
    // Route id validated before ANY read (incl. the replay lookup), matching
    // every other endpoint's validate-first ordering.
    assertPlainId('id', id);
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
      // Same guard as jobMatchesCrop, applied to the already-linked
      // replay: a linked job whose provenance is not the server-derived
      // VISION sourceType is not a crop-created job and must never be
      // handed back as one.
      if (job.sourceType !== CROP_JOB_SOURCE_TYPE) {
        throw new ConflictException(
          `This crop is linked to a ${job.sourceType} inference job, not ` +
            `the server-derived ${CROP_JOB_SOURCE_TYPE} provenance a crop ` +
            'job carries; the link cannot be replayed',
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
        // EXPLICIT server-derived provenance (never client-tunable, never
        // a schema default): crop-created jobs are VISION evidence, and
        // the replay matchers below require exactly this value.
        sourceType: CROP_JOB_SOURCE_TYPE,
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

    // The parent asset id rides along explicitly: the repository takes the
    // asset advisory lock BEFORE its guarded read, so it cannot learn the
    // parent by reading first — and the lock is what serializes this link
    // with DELETE /video-assets/:id (no QUEUED job can slip past the
    // delete flow's linked-job enumeration).
    const linked = await this.repository.linkArtifactToInferenceJob(
      tenantId,
      artifact.videoAssetId,
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
      const current = await this.repository.findArtifactById(
        tenantId,
        artifactId,
      );
      if (!current) {
        // The parent asset was soft-deleted between the job creation
        // committing and the link write: the just-created job would sit
        // QUEUED forever referencing a crop nobody can read — orphan work
        // that might still be processed. Compensate BEFORE surfacing the
        // 404: cancel the job while it is still QUEUED; if it was already
        // claimed (not cancellable), record the orphan condition in the
        // audit trail and still 404.
        await this.retireOrphanedJob(tenantId, job.id, actor);
        throw new NotFoundException(
          `Video artifact "${safeAuditEntityId(artifactId)}" not found`,
        );
      }
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
        // Mirror of the pre-replay guard above: the concurrently stamped
        // link must carry the server-derived VISION provenance too.
        if (existing.sourceType !== CROP_JOB_SOURCE_TYPE) {
          throw new ConflictException(
            `This crop is linked to a ${existing.sourceType} inference ` +
              `job, not the server-derived ${CROP_JOB_SOURCE_TYPE} ` +
              'provenance a crop job carries; the link cannot be replayed',
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
   * retry completes the removal. The soft-delete's audit entry therefore
   * records the media cleanup as PENDING — at that point the linked-job
   * retirement and the storage removal have not run and can still fail, so
   * durable evidence claiming the media "was removed" would lie. Only
   * after the retirement AND the storage removal succeed is completion
   * recorded, through the same `mediaRemovedAt` marker CAS as the
   * screening-rejection removal (exactly-once; a failed cleanup leaves the
   * honest pending state and the idempotent replay completes and records).
   * EXCEPTION — media already removed AND recorded by an earlier screening
   * rejection: the marker is read INSIDE softDelete's locked transaction
   * (race-free — REJECT transitions hold the same asset lock, and after
   * the soft-delete screening can no longer run), and when it is already
   * claimed the delete audit states honestly that this is a METADATA-ONLY
   * deletion (the screening rejection's completion entry already exists in
   * the audit trail) instead of promising a cleanup completion whose
   * marker CAS would always lose and never write — the service then skips
   * the completion recording for that case (deletePrefix still runs
   * idempotently for stragglers).
   * Before the media is removed, inference jobs linked through the asset's
   * crop artifacts are retired (QUEUED → CANCELLED; a claimed job is
   * audited as an orphan condition) so deleted media never leaves
   * claimable queue work behind. Metadata is KEPT (audit lineage;
   * artifacts are append-only) — only the media bytes are removed. A
   * deleted asset 404s on every ordinary read.
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
      throw new NotFoundException(
        `Video asset "${safeAuditEntityId(id)}" not found`,
      );
    }
    // Whether the media-removal completion is ALREADY recorded (a
    // screening rejection removed the bytes and claimed the marker before
    // this delete, or an earlier delete fully completed): initialized from
    // the pre-delete read for the idempotent-replay path, then replaced by
    // the AUTHORITATIVE marker read from inside softDelete's locked
    // transaction for a fresh delete.
    let removalAlreadyRecorded = Boolean(internal.mediaRemovedAt);
    if (!internal.deletedAt) {
      const marked = await this.repository.softDelete(
        tenantId,
        id,
        (before, mediaAlreadyRemoved) =>
          this.auditEntry(tenantId, actor, {
            action: AuditAction.DELETE,
            entityType: 'VideoAsset',
            entityId: id,
            before,
            // HONEST wording either way: when the media is still present
            // the cleanup is PENDING — at soft-delete time the linked-job
            // retirement and the storage cleanup have not run yet and can
            // still fail, so completion gets its own audit entry (marker
            // CAS) once the cleanup actually succeeded. When an earlier
            // screening rejection already removed the media AND recorded
            // completion, promising another completion would lie forever
            // (its marker CAS always loses) — the entry states the
            // metadata-only reality instead.
            reason: mediaAlreadyRemoved
              ? 'Video asset deletion requested: the media was already ' +
                'removed by an earlier screening rejection and its removal ' +
                'completion is recorded in the audit trail — metadata-only ' +
                'deletion, nothing left to remove'
              : 'Video asset deletion requested: media cleanup pending, ' +
                'metadata kept (cleanup completion is recorded in the ' +
                'audit trail)',
          }),
      );
      if (marked) {
        removalAlreadyRecorded = marked.mediaAlreadyRemoved;
      }
      // !marked: lost a race with another delete — the row is durably
      // deleted; fall through to the idempotent file cleanup with the
      // pre-read marker deciding the completion recording.
    }
    // BEFORE the media disappears: retire inference jobs already linked
    // through this asset's crop artifacts. A QUEUED job whose crop input
    // is about to be deleted must not stay claimable orphan work; a job
    // already claimed or finished is recorded as the orphan condition (if
    // still non-terminal) exactly like the crop-link deletion race.
    // Running this on every (idempotent) delete replay is safe: terminal
    // jobs — including the ones cancelled by an earlier attempt — are
    // skipped without a cancel attempt or an audit entry.
    await this.retireJobsLinkedToDeletedAsset(tenantId, id, actor);
    // The asset directory holds the original AND every extracted artifact.
    const assetDir = internal.storageKey.slice(
      0,
      internal.storageKey.lastIndexOf('/'),
    );
    try {
      // (Pre-storage screening keeps unscreened bytes IN MEMORY — an
      // upload interrupted mid-screen leaves only the PENDING_MEDIA row
      // and nothing under the storage root, so this prefix removal is the
      // whole cleanup.)
      await this.storage.deletePrefix(assetDir);
    } catch (error) {
      if (error instanceof VideoStorageOperationError) {
        // The soft-delete is already durable; the file cleanup is
        // retryable via this same idempotent endpoint — 503, not 500. NO
        // completion is recorded: the durable state honestly stays
        // "cleanup pending" until a replay succeeds.
        throw new ServiceUnavailableException(error.message);
      }
      throw error;
    }
    // Retirement AND storage removal succeeded — record cleanup completion
    // through the exactly-once marker CAS (shared with the screening
    // removal), but ONLY when the delete audit actually promised one: when
    // an earlier screening rejection (or a fully completed earlier delete)
    // already recorded the removal, the delete was audited as
    // metadata-only, no completion is owed, and the CAS attempt is skipped
    // — consistent with the wording, and any concurrent claim still stays
    // at ONE completion entry ('already-recorded' writes nothing).
    if (!removalAlreadyRecorded) {
      await this.recordMediaRemovalCompleted(
        tenantId,
        id,
        actor,
        'deletion-cleanup',
      );
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
    // PROVENANCE is server-derived, never negotiable: crop-created jobs
    // are recorded as VISION evidence (the creation above passes exactly
    // this value). A same-tenant squatter can pre-create the derived key
    // with a matching descriptor and context but sourceType ADMIN/MANUAL
    // — linking that job would hand its VisionEvent false provenance.
    if (job.sourceType !== CROP_JOB_SOURCE_TYPE) {
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

  /**
   * Compensation for the deletion race in createInferenceJobFromCrop: the
   * inference job committed but the crop link never can (the parent asset
   * was soft-deleted), so the job must not stay QUEUED as processable
   * orphan work. QUEUED → CANCELLED through the inference module's audited
   * internal seam; a job already claimed or finished is left alone but the
   * orphan condition is recorded in the audit trail so it is never
   * invisible.
   */
  private async retireOrphanedJob(
    tenantId: string,
    jobId: string,
    actor: AuditActor | undefined,
  ): Promise<void> {
    const cancelled = await this.inferenceJobsService.cancelOrphanedJob(
      tenantId,
      jobId,
      'Inference job cancelled: the source video asset was deleted before ' +
        'its crop artifact could link to the job',
      actor,
    );
    if (cancelled === 'not-cancellable') {
      await this.auditLog.record(
        this.auditEntry(tenantId, actor, {
          action: AuditAction.UPDATE,
          entityType: 'InferenceJob',
          entityId: jobId,
          reason:
            'Orphaned inference job: the source video asset was deleted ' +
            'before its crop artifact could link to the job, and the job ' +
            'was already claimed or finished so it could not be cancelled',
        }),
      );
    }
  }

  /**
   * DELETE-flow companion to retireOrphanedJob: the asset's crop artifacts
   * may already be linked to Phase 9 inference jobs, and the delete is
   * about to remove the media those jobs would read. Every linked job
   * still QUEUED is cancelled through the existing audited internal seam
   * (QUEUED → CANCELLED CAS); a job already claimed (RUNNING) — or one
   * that gets claimed between our read and the CAS — cannot be cancelled,
   * so the orphan condition is recorded in the audit trail instead.
   * IDEMPOTENT over delete replays: terminal jobs (SUCCEEDED / FAILED /
   * CANCELLED — including jobs cancelled by an earlier delete attempt) are
   * skipped entirely, so a replay neither re-cancels nor re-audits them.
   */
  private async retireJobsLinkedToDeletedAsset(
    tenantId: string,
    assetId: string,
    actor: AuditActor | undefined,
  ): Promise<void> {
    const terminal: ReadonlySet<InferenceJobStatus> = new Set([
      InferenceJobStatus.SUCCEEDED,
      InferenceJobStatus.FAILED,
      InferenceJobStatus.CANCELLED,
    ]);
    const linked = await this.repository.listLinkedInferenceJobs(
      tenantId,
      assetId,
    );
    for (const job of linked) {
      if (terminal.has(job.status)) {
        continue;
      }
      if (job.status === InferenceJobStatus.QUEUED) {
        const cancelled = await this.inferenceJobsService.cancelOrphanedJob(
          tenantId,
          job.id,
          'Inference job cancelled: its source video asset was deleted ' +
            'before the job was claimed, so its crop input no longer exists',
          actor,
        );
        if (cancelled !== 'not-cancellable') {
          continue;
        }
        // The QUEUED job raced into a claim (or a terminal state) between
        // our read and the CAS — re-read so a job that already FINISHED is
        // not falsely audited as an orphan (and a replay stays quiet).
        let current: InferenceJobStatus;
        try {
          current = (
            await this.inferenceJobsService.findById(tenantId, job.id)
          ).status;
        } catch {
          // The job is not readable (gone) — nothing to cancel or record.
          continue;
        }
        if (terminal.has(current)) {
          continue;
        }
      }
      // Non-terminal and not cancellable (claimed/RUNNING): the job will
      // fail or finish against deleted media — never invisibly.
      await this.auditLog.record(
        this.auditEntry(tenantId, actor, {
          action: AuditAction.UPDATE,
          entityType: 'InferenceJob',
          entityId: job.id,
          reason:
            'Orphaned inference job: its source video asset was deleted ' +
            'while the job was already claimed, so it could not be ' +
            'cancelled and its crop input no longer exists',
        }),
      );
    }
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
      throw new NotFoundException(
        `Video asset "${safeAuditEntityId(id)}" not found`,
      );
    }
    if (internal.status === VideoAssetStatus.PENDING_MEDIA) {
      // Staged, media write not confirmed — never screenable, never
      // processable; "validate it before extraction" would be untruthful
      // (a PENDING_MEDIA asset cannot be validated either).
      throw new ConflictException(
        'Video asset is PENDING_MEDIA: its media write never completed, so ' +
          'it cannot be processed; delete the asset and re-upload',
      );
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
   * first — under DETERMINISTIC per-request keys, so a crash between the
   * staging puts and the commit is self-healing (an identical retry
   * overwrites the same keys instead of orphaning new UUIDs) — then every
   * artifact row, artifact audit entry, and the asset's READY flip commit
   * as ONE transaction, with the rows recording the staged keys directly
   * (no promotion step). On ANY failure the staged files this attempt
   * owns are removed (keys a committed batch recorded are kept) —
   * append-only artifact rows mean a partial batch could never be cleaned
   * up, so no row may commit unless all of them do; a failed request
   * retries without duplicating committed artifacts.
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
    // DETERMINISTIC staging keys — crash recovery by construction: files
    // are staged BEFORE the batch transaction commits, so a crash in
    // between leaves files no row references. Random keys made those
    // files unfindable forever (a retry staged NEW UUIDs); deriving the
    // key from the request identity — the idempotency key when supplied,
    // else the canonical request fingerprint (already computed for every
    // request; the key is optional in both DTOs) — plus the artifact
    // index means a replayed IDENTICAL request re-puts over the SAME keys
    // (storage.put publishes atomically via temp+rename, so the overwrite
    // is safe), self-healing the crash window instead of orphaning more
    // files. Committed rows record these deterministic keys DIRECTLY (no
    // promotion/rename step — a rename would reintroduce the exact
    // put/commit crash window this design closes), leftovers from a
    // crashed or parameter-changed attempt stay discoverable under the
    // asset's `artifacts/<sha256>/` prefix (see README — reconcilable by
    // key shape; no scavenger job), and asset deletion's recursive
    // prefix removal cleans them with everything else. The hash input is
    // the request IDENTITY only — never descriptor content, filenames, or
    // free text — so no media-policy-relevant value shapes a key.
    const operationHash = createHash('sha256')
      .update(
        JSON.stringify({
          idempotencyKey: idempotencyKey ?? null,
          requestFingerprint: requestFingerprint ?? null,
        }),
      )
      .digest('hex');
    const staged: string[] = [];
    try {
      const items = [];
      for (const [index, input] of inputs.entries()) {
        const storageKey = `${assetDir}/artifacts/${operationHash}/${index}.png`;
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
        // With deterministic staging keys an IDENTICAL replay's staged
        // files ARE the recorded batch's keys — the committed-key check
        // inside the cleanup keeps those and removes only true surplus
        // (a diverged-fingerprint race's differently-prefixed files).
        await this.cleanupStagedArtifacts(tenantId, staged);
      }
      return published;
    } catch (error) {
      // Nothing was published by THIS attempt (the batch is all-or-none)
      // — remove the staged files so nothing untracked lingers, EXCEPT
      // keys an earlier committed batch recorded (deterministic keys are
      // shared across identical attempts; the cleanup checks ownership).
      // A cleanup failure ESCALATES: an unreferenced staged file would
      // otherwise sit orphaned with nothing able to find it again.
      await this.cleanupStagedArtifacts(tenantId, staged);
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
