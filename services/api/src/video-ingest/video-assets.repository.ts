import { Injectable } from '@nestjs/common';
import {
  InferenceJobStatus,
  Prisma,
  VideoArtifactType,
  VideoAssetStatus,
  VideoCropReason,
  VideoMediaWriteState,
} from '@prisma/client';
import {
  AuditEntry,
  AuditLogService,
} from '../common/audit/audit-log.service';
import {
  deviceAdvisoryLockKey,
  unitAdvisoryLockKey,
  videoAssetAdvisoryLockKey,
} from '../common/locks';
import { PrismaService } from '../prisma/prisma.service';
import { TenantScopedRepository } from '../prisma/tenant-scoped.repository';

/**
 * SAFE read shape for video assets: every scalar EXCEPT storageKey. The
 * internal storage key never leaves the persistence layer through this
 * select — API responses AND audit snapshots are built from it, so neither
 * can leak a storage location. Internal flows that genuinely need the key
 * use the *Internal methods below and must never surface it.
 */
export const VIDEO_ASSET_SELECT = {
  id: true,
  tenantId: true,
  locationId: true,
  unitId: true,
  deviceId: true,
  sessionId: true,
  originalFilename: true,
  mimeType: true,
  sizeBytes: true,
  durationMs: true,
  width: true,
  height: true,
  fps: true,
  status: true,
  checksumSha256: true,
  errorCode: true,
  errorMessage: true,
  // Screening inspection evidence — server-stamped (never caller-supplied)
  // and not sensitive: the timestamp/actor/frame-count of the audited
  // real-media preview that the APPROVE decision requires.
  screeningInspectedAt: true,
  screeningInspectedBy: true,
  screeningInspectedFrames: true,
  uploadedById: true,
  deletedAt: true,
  createdAt: true,
  updatedAt: true,
  location: { select: { id: true, name: true, code: true } },
  unit: { select: { id: true, name: true, code: true } },
  session: { select: { id: true, status: true } },
} satisfies Prisma.VideoAssetSelect;

/** SAFE artifact shape — same rule: no storageKey, ever. */
export const VIDEO_ARTIFACT_SELECT = {
  id: true,
  tenantId: true,
  videoAssetId: true,
  artifactType: true,
  reason: true,
  timestampMs: true,
  cropX: true,
  cropY: true,
  cropWidth: true,
  cropHeight: true,
  width: true,
  height: true,
  mimeType: true,
  sizeBytes: true,
  checksumSha256: true,
  inferenceJobId: true,
  createdById: true,
  createdAt: true,
} satisfies Prisma.VideoArtifactSelect;

export type VideoAssetView = Prisma.VideoAssetGetPayload<{
  select: typeof VIDEO_ASSET_SELECT;
}>;

export type VideoArtifactView = Prisma.VideoArtifactGetPayload<{
  select: typeof VIDEO_ARTIFACT_SELECT;
}>;

export type LinkArtifactRejection = 'already-linked';

/**
 * Advisory-lock key for ONE extraction/crop OPERATION — the (tenant, asset,
 * operation-hash) triple whose hash also derives the DETERMINISTIC artifact
 * staging keys. Two attempts that stage to the same keys are, by
 * construction, the same operation, so this key is exactly the granularity
 * that must serialize the batch PUBLICATION. Taken as the FIRST statement
 * of `createArtifactsBatch`'s own transaction (see there): the publication
 * decision and the committed-owner verdict the caller's staged-file cleanup
 * acts on are then produced ATOMICALLY inside one lock-ordered
 * transaction. Without that ordering, a FAILING attempt could run its
 * committed-owner lookup while the WINNING attempt's artifact transaction
 * was still uncommitted, observe no owner, delete the SHARED deterministic
 * key, and leave the winner's append-only artifact rows pointing at a file
 * that no longer exists.
 *
 * Lives here rather than in `common/locks` on purpose: it is derived from
 * an operation hash that only this module computes (the staging-key hash),
 * and both derivations must stay in one place or the lock stops covering
 * the keys it exists to protect.
 */
export function videoExtractionOperationLockKey(
  tenantId: string,
  videoAssetId: string,
  operationHash: string,
): string {
  return `video-extraction-op:${tenantId}:${videoAssetId}:${operationHash}`;
}

/**
 * How long the operation lock may be WAITED for and HELD. The lock is now
 * taken INSIDE the publication transaction, which does DB work only (no
 * storage I/O, no extractor work, no second connection), so the hold is a
 * handful of statements and these ceilings are pathological-case guards,
 * not expected waits.
 */
export const EXTRACTION_OPERATION_LOCK_MAX_WAIT_MS = 10_000;
export const EXTRACTION_OPERATION_LOCK_TIMEOUT_MS = 60_000;

/**
 * Upload reference-consistency rejections — the SAME vocabulary (and the
 * same rules) as PrismaInferenceQueue.enqueue(): an asset whose context the
 * queue would later reject must fail AT UPLOAD, not when its crops try to
 * connect to Phase 9.
 */
export type AssetReferenceRejection =
  | 'location-not-found'
  | 'unit-not-found'
  | 'unit-location-mismatch'
  | 'device-not-found'
  | 'device-unit-mismatch'
  | 'device-location-mismatch'
  | 'session-not-found'
  | 'session-unit-mismatch'
  | 'session-location-mismatch';

@Injectable()
export class VideoAssetsRepository extends TenantScopedRepository {
  constructor(
    prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {
    super(prisma);
  }

  createAsset(
    tenantId: string,
    data: {
      locationId?: string;
      unitId?: string;
      deviceId?: string;
      sessionId?: string;
      originalFilename: string;
      mimeType: string;
      sizeBytes: number;
      storageKey: string;
      checksumSha256: string;
      uploadedById?: string;
    },
    buildAuditEntry: (asset: VideoAssetView) => AuditEntry,
  ): Promise<VideoAssetView | AssetReferenceRejection> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      // Context references must form ONE consistent hierarchy — the same
      // rules PrismaInferenceQueue.enqueue() enforces (unit in the store,
      // device on the unit, session on the unit and store), EXTENDED so
      // omitted intermediates cannot launder a mismatch: the device's unit
      // and store are resolved and compared even when unitId/locationId
      // were not supplied, and the DERIVED bindings are PERSISTED (a
      // device-only upload lands with its unit and store filled in, so
      // downstream inference-job → VisionEvent conversion — which requires
      // both — can complete). Composite same-tenant FKs only pin each
      // reference's TENANT.
      //
      // Serialization: the SAME advisory locks (unit FIRST, then device —
      // canonical order, mirroring enqueue/checkout) that
      // UnitsRepository/DevicesRepository mutations take, held through the
      // insert. When the unit is only DERIVABLE from the device or the
      // session, a preliminary UNLOCKED read learns the unit id so the
      // locks can still be taken in canonical order; the locked re-read
      // then verifies the reference did not move in between (controlled
      // rejection, caller retries).
      let lockUnitId = data.unitId ?? null;
      if (data.deviceId && !lockUnitId) {
        const preliminary = await tx.device.findFirst({
          where: { id: data.deviceId, tenantId: scopedTenantId },
          select: { unitId: true },
        });
        if (!preliminary) {
          return 'device-not-found' as const;
        }
        lockUnitId = preliminary.unitId;
      }
      // Session-only uploads derive their unit the same way: a preliminary
      // UNLOCKED session read learns the unit id so the unit advisory lock
      // can be taken in canonical order; the locked session re-read below
      // then verifies the session did not move units in between.
      if (data.sessionId && !lockUnitId) {
        const preliminary = await tx.checkoutSession.findFirst({
          where: { id: data.sessionId, tenantId: scopedTenantId },
          select: { unitId: true },
        });
        if (!preliminary) {
          return 'session-not-found' as const;
        }
        lockUnitId = preliminary.unitId;
      }
      if (lockUnitId) {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${unitAdvisoryLockKey(
          scopedTenantId,
          lockUnitId,
        )}))`;
      }
      if (data.deviceId) {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${deviceAdvisoryLockKey(
          scopedTenantId,
          data.deviceId,
        )}))`;
      }
      if (data.locationId) {
        const location = await tx.location.findFirst({
          where: { id: data.locationId, tenantId: scopedTenantId },
          select: { id: true },
        });
        if (!location) {
          return 'location-not-found' as const;
        }
      }
      let unitLocationId: string | null = null;
      if (data.unitId) {
        const unit = await tx.retailUnit.findFirst({
          where: { id: data.unitId, tenantId: scopedTenantId },
          select: { id: true, locationId: true },
        });
        if (!unit) {
          return 'unit-not-found' as const;
        }
        if (data.locationId && unit.locationId !== data.locationId) {
          return 'unit-location-mismatch' as const;
        }
        unitLocationId = unit.locationId;
      }
      // Effective bindings accumulate as references resolve; every later
      // reference must agree with them, and they are what gets PERSISTED.
      let effectiveUnitId: string | null = data.unitId ?? null;
      let effectiveLocationId: string | null =
        data.locationId ?? unitLocationId;
      if (data.deviceId) {
        const device = await tx.device.findFirst({
          where: { id: data.deviceId, tenantId: scopedTenantId },
          select: {
            id: true,
            unitId: true,
            unit: { select: { locationId: true } },
          },
        });
        if (!device) {
          return 'device-not-found' as const;
        }
        // Covers both the explicit-unit mismatch AND a device that moved
        // between the preliminary read and the locked re-read.
        if (lockUnitId && device.unitId !== lockUnitId) {
          return 'device-unit-mismatch' as const;
        }
        if (
          effectiveLocationId &&
          device.unit.locationId !== effectiveLocationId
        ) {
          return 'device-location-mismatch' as const;
        }
        effectiveUnitId = effectiveUnitId ?? device.unitId;
        effectiveLocationId = effectiveLocationId ?? device.unit.locationId;
      }
      if (data.sessionId) {
        const session = await tx.checkoutSession.findFirst({
          where: { id: data.sessionId, tenantId: scopedTenantId },
          select: { id: true, unitId: true, locationId: true },
        });
        if (!session) {
          return 'session-not-found' as const;
        }
        // lockUnitId covers the explicit/derived-unit mismatch AND a
        // session that moved units between the preliminary read and this
        // locked re-read (mirroring the device re-read check above).
        if (lockUnitId && session.unitId !== lockUnitId) {
          return 'session-unit-mismatch' as const;
        }
        if (effectiveUnitId && session.unitId !== effectiveUnitId) {
          return 'session-unit-mismatch' as const;
        }
        if (effectiveLocationId && session.locationId !== effectiveLocationId) {
          return 'session-location-mismatch' as const;
        }
        if (!effectiveUnitId) {
          // Session-only derivation: the session's unitId/locationId pair
          // is a HISTORICAL copy taken when the session opened — the unit
          // may have been re-homed to another store since. The unit
          // advisory lock is already held (preliminary read above), so
          // read the CURRENT unit and require the session's recorded store
          // to still match it; persisting the stale pair would strand the
          // asset (PrismaInferenceQueue.enqueue() rejects its crops with
          // unit-location-mismatch).
          const sessionUnit = await tx.retailUnit.findFirst({
            where: { id: session.unitId, tenantId: scopedTenantId },
            select: { id: true, locationId: true },
          });
          if (!sessionUnit) {
            return 'unit-not-found' as const;
          }
          if (sessionUnit.locationId !== session.locationId) {
            return 'session-location-mismatch' as const;
          }
        }
        // A session-only upload still yields a complete persisted context.
        effectiveUnitId = effectiveUnitId ?? session.unitId;
        effectiveLocationId = effectiveLocationId ?? session.locationId;
      }
      const created = await tx.videoAsset.create({
        data: {
          ...data,
          unitId: effectiveUnitId ?? undefined,
          locationId: effectiveLocationId ?? undefined,
          tenantId: scopedTenantId,
          // NON-NEGOTIABLE at the persistence layer (not caller-supplied):
          // every new upload lands PENDING_MEDIA — staged, NOT screenable,
          // NOT processable. The row commits BEFORE the media write, so a
          // screenable status here would let a concurrent screener APPROVE
          // an asset whose bytes then fail to land. The service publishes
          // PENDING_MEDIA → QUARANTINED only after the media write
          // succeeds; only then does the audited screening decision apply.
          status: VideoAssetStatus.PENDING_MEDIA,
        },
        select: VIDEO_ASSET_SELECT,
      });
      await this.auditLog.record(buildAuditEntry(created), tx);
      return created;
    });
  }

  /** Soft-deleted assets are invisible to every read (404 downstream). */
  findById(tenantId: string, id: string): Promise<VideoAssetView | null> {
    return this.prisma.videoAsset.findFirst({
      where: this.scope(tenantId, { id, deletedAt: null }),
      select: VIDEO_ASSET_SELECT,
    });
  }

  /** Internal: full row INCLUDING storageKey — never surfaced. */
  findByIdInternal(tenantId: string, id: string) {
    return this.prisma.videoAsset.findFirst({
      where: this.scope(tenantId, { id, deletedAt: null }),
    });
  }

  /**
   * Internal, INCLUDING soft-deleted rows — the delete flow only: a delete
   * whose file cleanup failed AFTER the durable soft-delete must be
   * retryable, and the retry needs the (already-deleted) row's storage key.
   */
  findByIdInternalIncludingDeleted(tenantId: string, id: string) {
    return this.prisma.videoAsset.findFirst({
      where: this.scope(tenantId, { id }),
    });
  }

  /**
   * CLAIMS the upload's single durable media write, under the SAME per-asset
   * advisory lock as softDelete/transitionStatus: one short transaction that
   * (1) reads the row's deletedAt and (2) — only when the asset is still
   * live — stamps `mediaWriteState = PENDING`.
   *
   * The two halves MUST be atomic, and that is the whole point of this
   * method. The claim is what a later DELETE observes to decide whether a
   * put can still be in flight, so it may not be written after a concurrent
   * soft-delete already read the state: sharing the asset lock forces one of
   * exactly two orders — the claim commits first (a soft-delete then reads
   * PENDING and withholds its completion marker), or the soft-delete commits
   * first (this read answers 'deleted', the caller skips the put entirely,
   * and the state stays NULL, i.e. "no media write was ever attempted").
   * There is no interleaving in which bytes can land under a prefix whose
   * delete recorded completion.
   *
   * Doubles as the pre-put liveness pre-check it replaces (the publish CAS
   * remains the authority for the delete race). The lock is never held
   * across any file I/O: this transaction is the locked read + one update,
   * and the put runs after it commits.
   */
  beginMediaWriteUnderLock(
    tenantId: string,
    id: string,
  ): Promise<'live' | 'deleted' | 'missing'> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${videoAssetAdvisoryLockKey(
        scopedTenantId,
        id,
      )}))`;
      const row = await tx.videoAsset.findFirst({
        where: { id, tenantId: scopedTenantId },
        select: { deletedAt: true },
      });
      if (!row) {
        return 'missing' as const;
      }
      if (row.deletedAt) {
        return 'deleted' as const;
      }
      await tx.videoAsset.updateMany({
        // Re-asserted in the write itself, not just the read: the claim must
        // never land on a row a delete claimed inside this transaction.
        where: { id, tenantId: scopedTenantId, deletedAt: null },
        data: { mediaWriteState: VideoMediaWriteState.PENDING },
      });
      return 'live' as const;
    });
  }

  /**
   * RESOLVES the claimed media write: SUCCEEDED the moment `storage.put`
   * returned, FAILED when it threw. A single connection-cheap update (no
   * transaction wrapper, no advisory lock — nothing else writes this
   * column), guarded by a compare-and-set on the PENDING claim so a stale
   * resolution can never overwrite a decided state or resurrect a state on
   * a row that never claimed one. Once resolved, a DELETE (fresh or
   * replayed) may record its media-removal completion: no put can still be
   * in flight.
   */
  async resolveMediaWrite(
    tenantId: string,
    id: string,
    state: 'SUCCEEDED' | 'FAILED',
  ): Promise<void> {
    const scopedTenantId = this.requireTenantId(tenantId);
    await this.prisma.videoAsset.updateMany({
      where: {
        id,
        tenantId: scopedTenantId,
        mediaWriteState: VideoMediaWriteState.PENDING,
      },
      data: {
        mediaWriteState:
          state === 'SUCCEEDED'
            ? VideoMediaWriteState.SUCCEEDED
            : VideoMediaWriteState.FAILED,
      },
    });
  }

  async list(
    tenantId: string,
    filters: {
      status?: VideoAssetStatus;
      sessionId?: string;
      locationId?: string;
      skip?: number;
      take?: number;
    },
  ): Promise<{ items: VideoAssetView[]; total: number }> {
    const where: Prisma.VideoAssetWhereInput = this.scope(tenantId, {
      deletedAt: null,
    });
    if (filters.status) {
      where.status = filters.status;
    }
    if (filters.sessionId) {
      where.sessionId = filters.sessionId;
    }
    if (filters.locationId) {
      where.locationId = filters.locationId;
    }
    const [items, total] = await Promise.all([
      this.prisma.videoAsset.findMany({
        where,
        select: VIDEO_ASSET_SELECT,
        // id is the deterministic tie-breaker: createdAt is millisecond
        // precision, so burst uploads could otherwise reorder across pages.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: filters.skip ?? 0,
        take: filters.take ?? 25,
      }),
      this.prisma.videoAsset.count({ where }),
    ]);
    return { items, total };
  }

  /**
   * Status transition as a guarded compare-and-set: the update matches the
   * EXPECTED current status, so two concurrent transitions cannot both win
   * (the loser sees count 0 and returns null for the caller to re-read).
   * Every transition runs under the asset's advisory lock so it SERIALIZES
   * with `authorizeScreeningPreviewServe()`: a screening decision and a
   * preview-serve authorization can never interleave, which is what makes
   * the preview's final status re-read authoritative (a preview is never
   * audited/served for an asset whose terminal decision committed first).
   * The optional `guard` runs INSIDE the locked transaction after the
   * status re-read passed, with the CURRENT row: a controlled throw there
   * vetoes the transition atomically (nothing written, nothing audited) —
   * the APPROVE screening decision uses it to require inspection evidence
   * that cannot go stale between a pre-check and the CAS.
   */
  transitionStatus(
    tenantId: string,
    id: string,
    expected: VideoAssetStatus[],
    data: {
      status: VideoAssetStatus;
      durationMs?: number;
      width?: number;
      height?: number;
      fps?: number;
      errorCode?: string | null;
      errorMessage?: string | null;
    },
    buildAuditEntry: (
      before: VideoAssetView,
      after: VideoAssetView,
    ) => AuditEntry,
    guard?: (before: VideoAssetView) => void,
  ): Promise<VideoAssetView | null> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${videoAssetAdvisoryLockKey(
        scopedTenantId,
        id,
      )}))`;
      const before = await tx.videoAsset.findFirst({
        where: { id, tenantId: scopedTenantId, deletedAt: null },
        select: VIDEO_ASSET_SELECT,
      });
      if (!before || !expected.includes(before.status)) {
        return null;
      }
      guard?.(before);
      const updated = await tx.videoAsset.updateMany({
        where: {
          id,
          tenantId: scopedTenantId,
          deletedAt: null,
          status: { in: expected },
        },
        data: {
          ...data,
          // Inspection evidence is SINGLE-USE and QUARANTINED-scoped:
          // EVERY transition invalidates it — APPROVE consumes it,
          // REJECT/FAILED make it moot, and a later QUARANTINED publish
          // (fresh upload lifecycle) must start with no evidence. Clearing
          // unconditionally on every transition is the simplest rule that
          // can never leave stale evidence behind for a future approval.
          screeningInspectedAt: null,
          screeningInspectedBy: null,
          screeningInspectedFrames: null,
        },
      });
      if (updated.count === 0) {
        return null;
      }
      const after = await tx.videoAsset.findFirstOrThrow({
        where: { id, tenantId: scopedTenantId },
        select: VIDEO_ASSET_SELECT,
      });
      await this.auditLog.record(buildAuditEntry(before, after), tx);
      return after;
    });
  }

  /**
   * FINAL authorization for serving a screening preview, taken AFTER the
   * frames were extracted: one transaction that (1) takes the SAME advisory
   * lock as every `transitionStatus()` decision CAS, (2) re-reads the
   * asset's CURRENT status, and (3) writes the byte-exposing READ audit
   * entry — audit and authorization commit together or not at all. Because
   * decisions and this guard serialize on the lock, a preview can never be
   * audited or served for an asset whose terminal screening decision
   * committed first (the mid-extraction race, including POSIX
   * unlink-while-open serving after a committed rejection). Returns the
   * observed status — the caller serves ONLY on QUARANTINED (no audit is
   * written otherwise) — or null when the asset is gone (deleted).
   *
   * When the serve is authorized AND at least one frame was actually
   * served, the same transaction also STAMPS the inspection evidence the
   * APPROVE screening decision requires (inspectedAt/By/Frames). This is
   * the ONLY writer of that evidence: the service calls this method only
   * from the screening preview, which 503s BEFORE any extraction when the
   * configured extractor does not read real bytes — so evidence is
   * structurally guaranteed to describe a real-media inspection. A preview
   * whose every sample position was skipped (zero served frames) audits
   * the READ but stamps NOTHING: an operator who saw no frames has
   * inspected nothing.
   */
  authorizeScreeningPreviewServe(
    tenantId: string,
    id: string,
    inspection: { actorId: string | null; servedFrameCount: number },
    buildAuditEntry: () => AuditEntry,
  ): Promise<VideoAssetStatus | null> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${videoAssetAdvisoryLockKey(
        scopedTenantId,
        id,
      )}))`;
      const current = await tx.videoAsset.findFirst({
        where: { id, tenantId: scopedTenantId, deletedAt: null },
        select: { status: true },
      });
      if (!current) {
        return null;
      }
      if (current.status !== VideoAssetStatus.QUARANTINED) {
        // Not authorized — NO audit entry: nothing is served, so recording
        // a READ would fabricate a byte exposure that never happened.
        return current.status;
      }
      if (inspection.servedFrameCount > 0) {
        await tx.videoAsset.updateMany({
          where: {
            id,
            tenantId: scopedTenantId,
            deletedAt: null,
            status: VideoAssetStatus.QUARANTINED,
          },
          data: {
            screeningInspectedAt: new Date(),
            screeningInspectedBy: inspection.actorId,
            screeningInspectedFrames: inspection.servedFrameCount,
          },
        });
      }
      await this.auditLog.record(buildAuditEntry(), tx);
      return current.status;
    });
  }

  /**
   * Inference jobs linked through THIS asset's crop artifacts (the one-shot
   * `inferenceJobId` stamp), with their CURRENT status — the delete flow
   * retires them before the media disappears. Deliberately NO
   * non-deleted-parent scoping: the delete flow (and its idempotent replay)
   * runs AFTER the soft-delete committed, so the artifacts' parent is
   * already deleted by the time this query runs. Deduped: each linked job
   * is reported once even if multiple artifacts ever referenced it.
   */
  async listLinkedInferenceJobs(
    tenantId: string,
    videoAssetId: string,
  ): Promise<{ id: string; status: InferenceJobStatus }[]> {
    const rows = await this.prisma.videoArtifact.findMany({
      where: this.scope(tenantId, {
        videoAssetId,
        inferenceJobId: { not: null },
      }),
      select: {
        inferenceJobId: true,
        inferenceJob: { select: { status: true } },
      },
    });
    const byId = new Map<string, InferenceJobStatus>();
    for (const row of rows) {
      if (row.inferenceJobId && row.inferenceJob) {
        byId.set(row.inferenceJobId, row.inferenceJob.status);
      }
    }
    return [...byId.entries()].map(([id, status]) => ({ id, status }));
  }

  /**
   * The ids of THIS asset's CROP artifacts that carry NO committed
   * inference-job link — the delete flow's crash-window sweep. Two-phase
   * crop→job creation can leave an unpublished PENDING_LINK job behind when
   * the process dies between the job's commit and the link transaction, and
   * such a job is by definition unreachable through
   * `listLinkedInferenceJobs` (the link is exactly what never committed).
   * The caller probes each id under the deterministic
   * `video-crop:<artifactId>` idempotency key instead. Deliberately NO
   * non-deleted-parent scoping, for the same reason as
   * `listLinkedInferenceJobs`: this runs AFTER the soft-delete committed.
   * Only CROP artifacts can ever create jobs, and only unlinked ones can be
   * in the crash window — linked ones already come back from
   * `listLinkedInferenceJobs`.
   */
  async listCropArtifactIds(
    tenantId: string,
    videoAssetId: string,
  ): Promise<string[]> {
    const rows = await this.prisma.videoArtifact.findMany({
      where: this.scope(tenantId, {
        videoAssetId,
        artifactType: VideoArtifactType.CROP,
        inferenceJobId: null,
      }),
      select: { id: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map((row) => row.id);
  }

  /**
   * Soft delete: stamps deletedAt (CAS on "not yet deleted") and audits.
   * The metadata row is KEPT for lineage — artifacts stay append-only and
   * their rows keep referencing the asset; only the local files go away
   * (the service removes them after this commits). Runs under the SAME
   * asset advisory lock as `transitionStatus()` and
   * `authorizeScreeningPreviewServe()`: deletion is a lifecycle exit, and
   * without the lock a preview's final guarded authorization could re-read
   * QUARANTINED, an unserialised delete could commit, and the preview
   * would still write its READ audit and serve frames for an asset that
   * is already deleted — the lock makes the preview guard cover deletion
   * exactly as it covers screening decisions.
   *
   * The `mediaRemovedAt` marker is read INSIDE the same locked transaction
   * — race-free: the screening REJECT transition (whose removal flow
   * claims the marker) serializes on the same lock, and after the
   * soft-delete commits screening can no longer run — and is BOTH handed
   * to the audit-entry builder and returned, so the delete audit can state
   * honestly whether any media cleanup is still outstanding: a marker
   * already claimed by the screening-rejection removal means this delete
   * is metadata-only and must neither promise nor later record a second
   * completion.
   *
   * The DURABLE media-write state is read in that same locked transaction
   * and reported the same way. `beginMediaWriteUnderLock` claims PENDING
   * under this very lock, so the read is authoritative: PENDING here means
   * an upload's put is still in flight (it claimed before we committed) and
   * can still land bytes just after the caller's prefix removal — the
   * caller must then leave the exactly-once completion marker unset and say
   * so in the audit. Anything else (SUCCEEDED/FAILED, or NULL for a row
   * whose put never started) means the write is DECIDED.
   */
  softDelete(
    tenantId: string,
    id: string,
    buildAuditEntry: (
      before: VideoAssetView,
      mediaAlreadyRemoved: boolean,
      mediaWriteUndecided: boolean,
    ) => AuditEntry,
  ): Promise<{
    asset: VideoAssetView;
    mediaAlreadyRemoved: boolean;
    mediaWriteUndecided: boolean;
  } | null> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${videoAssetAdvisoryLockKey(
        scopedTenantId,
        id,
      )}))`;
      const row = await tx.videoAsset.findFirst({
        where: { id, tenantId: scopedTenantId, deletedAt: null },
        // The safe select PLUS the removal marker and the durable
        // media-write state — read under the lock; both are peeled off
        // below so audit snapshots and the returned view keep the exact
        // VIDEO_ASSET_SELECT shape.
        select: {
          ...VIDEO_ASSET_SELECT,
          mediaRemovedAt: true,
          mediaWriteState: true,
        },
      });
      if (!row) {
        return null;
      }
      const { mediaRemovedAt, mediaWriteState, ...before } = row;
      const mediaAlreadyRemoved = mediaRemovedAt != null;
      const mediaWriteUndecided =
        mediaWriteState === VideoMediaWriteState.PENDING;
      const updated = await tx.videoAsset.updateMany({
        where: { id, tenantId: scopedTenantId, deletedAt: null },
        data: {
          deletedAt: new Date(),
          // Same invalidation rule as transitionStatus(): a deleted asset
          // can never be approved, so its inspection evidence is cleared —
          // no dormant evidence survives any lifecycle exit.
          screeningInspectedAt: null,
          screeningInspectedBy: null,
          screeningInspectedFrames: null,
        },
      });
      if (updated.count === 0) {
        return null;
      }
      await this.auditLog.record(
        buildAuditEntry(before, mediaAlreadyRemoved, mediaWriteUndecided),
        tx,
      );
      return { asset: before, mediaAlreadyRemoved, mediaWriteUndecided };
    });
  }

  /**
   * EXACTLY-ONCE record that an asset's media removal COMPLETED — the DB
   * marker (not the storage adapter's "did anything exist" report) is the
   * authority for the completion audit entry. One transaction: a
   * compare-and-set on `mediaRemovedAt IS NULL` claims the completion, and
   * ONLY the claiming caller writes the completion audit entry (same
   * transaction — marker and evidence commit together or not at all).
   * Every other caller — a concurrent removal replay, a retry after the
   * bytes were already gone — observes count 0 and records NOTHING
   * ('already-recorded'), so the promised exactly-once completion evidence
   * holds under any interleaving of filesystem removals. Conversely, a
   * replay whose bytes are ALREADY absent can still REPAIR a missing
   * completion record (the earlier attempt removed the bytes but crashed
   * before this transaction committed). Deliberately NO deletedAt filter:
   * the delete-cleanup completion runs AFTER the soft-delete committed.
   */
  recordMediaRemovalCompleted(
    tenantId: string,
    id: string,
    buildAuditEntry: () => AuditEntry,
  ): Promise<'recorded' | 'already-recorded'> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.videoAsset.updateMany({
        where: { id, tenantId: scopedTenantId, mediaRemovedAt: null },
        data: { mediaRemovedAt: new Date() },
      });
      if (claimed.count === 0) {
        return 'already-recorded' as const;
      }
      await this.auditLog.record(buildAuditEntry(), tx);
      return 'recorded' as const;
    });
  }

  /**
   * Replay lookup for a committed extraction request (idempotency key):
   * returns the recorded batch — current asset view + the artifacts the
   * original transaction produced — or null when no request with this key
   * exists. 'key-conflict' when the key exists but belongs to a DIFFERENT
   * asset (a reused key must never replay another asset's batch).
   */
  async findExtractionReplay(
    tenantId: string,
    videoAssetId: string,
    idempotencyKey: string,
  ): Promise<
    | {
        asset: VideoAssetView;
        artifacts: VideoArtifactView[];
        replayed: true;
        requestFingerprint: string | null;
      }
    | 'key-conflict'
    | null
  > {
    const scopedTenantId = this.requireTenantId(tenantId);
    const request = await this.prisma.videoExtractionRequest.findFirst({
      where: { tenantId: scopedTenantId, idempotencyKey },
    });
    if (!request) {
      return null;
    }
    if (request.videoAssetId !== videoAssetId) {
      return 'key-conflict' as const;
    }
    const asset = await this.findById(tenantId, videoAssetId);
    if (!asset) {
      return null;
    }
    const ids = (request.artifactIds as string[]) ?? [];
    const artifacts = await this.prisma.videoArtifact.findMany({
      where: this.scope(tenantId, { id: { in: ids } }),
      select: VIDEO_ARTIFACT_SELECT,
    });
    // Preserve the original creation order recorded on the request.
    const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
    return {
      asset,
      artifacts: ids
        .map((id) => byId.get(id))
        .filter((artifact): artifact is VideoArtifactView => Boolean(artifact)),
      replayed: true,
      // The recorded request parameters — the service honors the replay
      // ONLY when the incoming request's canonical fingerprint matches.
      requestFingerprint: request.requestFingerprint ?? null,
    };
  }

  /**
   * The WHOLE extraction result commits as ONE transaction: every artifact
   * row, every artifact audit entry, the asset's guarded status flip to
   * READY, and (when an idempotency key was supplied) the extraction-
   * request row that makes the batch REPLAYABLE — all land or none do.
   * Artifact rows are append-only, so a partially-committed batch could
   * never be cleaned up, and a retried request must replay, not re-append.
   * Returns null when the asset is gone or its status left the expected set
   * (CAS lost); a pre-existing identical key is replayed inside the same
   * transaction ('key-conflict' when the key belongs to another asset).
   * Two concurrent firsts race on the (tenantId, idempotencyKey) unique —
   * the loser's P2002 rolls its batch back and the caller replays.
   *
   * OPERATION LOCK — `pg_advisory_xact_lock(operation key)` is this
   * transaction's FIRST statement (the key is derived from the very
   * operation hash the caller's DETERMINISTIC staging keys are built from,
   * so lock granularity and file granularity are the same thing). Two
   * attempts that stage to the same files therefore publish STRICTLY one
   * after the other, and — because the lock is transaction-scoped — it is
   * released by commit, rollback, timeout, and process death alike.
   *
   * NO NESTED TRANSACTION, NO SECOND CONNECTION. The lock used to be held
   * by an OUTER interactive transaction wrapped around the caller's whole
   * stage → publish → cleanup section, so the callback's own root-client
   * calls each needed a SECOND pooled connection while the first was
   * pinned; at pool-sized concurrency every connection could be held by an
   * outer lock transaction while every callback waited for another one.
   * Taking the lock HERE, inside the one transaction that already exists,
   * costs exactly one connection per concurrent extraction — and the
   * caller's file I/O now runs with NO transaction open at all.
   *
   * COMMITTED-OWNER VERDICT — the same transaction also reports which of
   * the staged keys (the `items`' storageKeys) an ALREADY-COMMITTED
   * artifact row owns. Staging keys are deterministic, so an identical
   * attempt's staged files can BE a committed batch's files; the caller's
   * cleanup must never delete those. Computing the verdict here, before
   * this batch's own rows are written and under the same lock as every
   * competing publication, is what makes it trustworthy: it cannot observe
   * a rival batch mid-commit (MVCC-invisible but about to land), because
   * no rival publication can be open while this transaction holds the lock.
   */
  createArtifactsBatch(
    tenantId: string,
    videoAssetId: string,
    operationHash: string,
    expectedStatuses: VideoAssetStatus[],
    idempotencyKey: string | undefined,
    items: {
      artifactType: VideoArtifactType;
      reason?: VideoCropReason;
      timestampMs: number;
      cropX?: number;
      cropY?: number;
      cropWidth?: number;
      cropHeight?: number;
      width: number;
      height: number;
      mimeType: string;
      sizeBytes: number;
      checksumSha256: string;
      storageKey: string;
      createdById?: string;
    }[],
    buildArtifactAuditEntry: (artifact: VideoArtifactView) => AuditEntry,
    buildAssetAuditEntry: (
      before: VideoAssetView,
      after: VideoAssetView,
    ) => AuditEntry,
    // Canonical request fingerprint recorded WITH the batch (same
    // transaction) so replays can prove the retried request is identical.
    requestFingerprint?: string,
  ): Promise<
    | {
        asset: VideoAssetView;
        artifacts: VideoArtifactView[];
        replayed: boolean;
        requestFingerprint?: string | null;
        // Which staged keys an ALREADY-COMMITTED batch owns — decided in
        // this transaction, under the operation lock (see the doc above).
        committedStagedKeys: string[];
      }
    | 'key-conflict'
    | null
  > {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(
      async (tx) => {
        // FIRST statement: every publication for this operation — and thus
        // for these deterministic staging keys — serializes here.
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${videoExtractionOperationLockKey(
          scopedTenantId,
          videoAssetId,
          operationHash,
        )}))`;
        // Committed-owner verdict BEFORE this batch writes anything: the
        // answer is "keys some EARLIER committed batch owns", which is
        // exactly what the caller's staged-file cleanup must preserve.
        const stagedKeys = items.map((item) => item.storageKey);
        const committedStagedKeys = stagedKeys.length
          ? (
              await tx.videoArtifact.findMany({
                // Soft-deleted parents included on purpose: their artifact
                // rows still own their files until the delete flow removes
                // the whole asset prefix.
                where: {
                  tenantId: scopedTenantId,
                  storageKey: { in: stagedKeys },
                },
                select: { storageKey: true },
              })
            ).map((row) => row.storageKey)
          : [];
        if (idempotencyKey) {
          const existing = await tx.videoExtractionRequest.findFirst({
            where: { tenantId: scopedTenantId, idempotencyKey },
          });
          if (existing) {
            if (existing.videoAssetId !== videoAssetId) {
              return 'key-conflict' as const;
            }
            const asset = await tx.videoAsset.findFirst({
              where: { id: videoAssetId, tenantId: scopedTenantId, deletedAt: null },
              select: VIDEO_ASSET_SELECT,
            });
            if (!asset) {
              return null;
            }
            const ids = (existing.artifactIds as string[]) ?? [];
            const found = await tx.videoArtifact.findMany({
              where: { tenantId: scopedTenantId, id: { in: ids } },
              select: VIDEO_ARTIFACT_SELECT,
            });
            const byId = new Map(found.map((artifact) => [artifact.id, artifact]));
            return {
              asset,
              artifacts: ids
                .map((id) => byId.get(id))
                .filter((artifact): artifact is VideoArtifactView =>
                  Boolean(artifact),
                ),
              replayed: true,
              // The recorded parameters ride along so the caller can reject a
              // same-key request whose parameters changed.
              requestFingerprint: existing.requestFingerprint ?? null,
              committedStagedKeys,
            };
          }
        }
        const before = await tx.videoAsset.findFirst({
          where: { id: videoAssetId, tenantId: scopedTenantId, deletedAt: null },
          select: VIDEO_ASSET_SELECT,
        });
        if (!before || !expectedStatuses.includes(before.status)) {
          return null;
        }
        const flipped = await tx.videoAsset.updateMany({
          where: {
            id: videoAssetId,
            tenantId: scopedTenantId,
            deletedAt: null,
            status: { in: expectedStatuses },
          },
          // Clearing the error is REQUIRED when recovering from FAILED (the
          // status/error CHECK constraint ties them together).
          data: { status: VideoAssetStatus.READY, errorCode: null, errorMessage: null },
        });
        if (flipped.count === 0) {
          return null;
        }
        const artifacts: VideoArtifactView[] = [];
        for (const item of items) {
          const created = await tx.videoArtifact.create({
            data: { ...item, videoAssetId, tenantId: scopedTenantId },
            select: VIDEO_ARTIFACT_SELECT,
          });
          await this.auditLog.record(buildArtifactAuditEntry(created), tx);
          artifacts.push(created);
        }
        if (idempotencyKey) {
          // Same transaction as the batch: the request row and its artifacts
          // are indivisible, so a replay can never observe half a batch.
          await tx.videoExtractionRequest.create({
            data: {
              tenantId: scopedTenantId,
              videoAssetId,
              idempotencyKey,
              artifactIds: artifacts.map((artifact) => artifact.id),
              requestFingerprint,
            },
          });
        }
        const after = await tx.videoAsset.findFirstOrThrow({
          where: { id: videoAssetId, tenantId: scopedTenantId },
          select: VIDEO_ASSET_SELECT,
        });
        await this.auditLog.record(buildAssetAuditEntry(before, after), tx);
        return { asset: after, artifacts, replayed: false, committedStagedKeys };
      },
      {
        // The transaction now WAITS on the operation lock, so it carries
        // the same explicit wait/hold ceilings the outer lock transaction
        // used to: contention past them surfaces as a controlled 503
        // instead of an unbounded stall.
        maxWait: EXTRACTION_OPERATION_LOCK_MAX_WAIT_MS,
        timeout: EXTRACTION_OPERATION_LOCK_TIMEOUT_MS,
      },
    );
  }

  /**
   * Artifact reads are scoped through a NON-DELETED parent: after
   * `DELETE /video-assets/:id`, the documented deletion boundary applies to
   * the asset's artifacts too — no metadata exposure, no inference-job
   * replay from a deleted asset's crops.
   */
  findArtifactById(
    tenantId: string,
    id: string,
  ): Promise<VideoArtifactView | null> {
    return this.prisma.videoArtifact.findFirst({
      where: this.scope(tenantId, { id, videoAsset: { deletedAt: null } }),
      select: VIDEO_ARTIFACT_SELECT,
    });
  }

  async listArtifacts(
    tenantId: string,
    videoAssetId: string,
  ): Promise<VideoArtifactView[]> {
    return this.prisma.videoArtifact.findMany({
      where: this.scope(tenantId, {
        videoAssetId,
        videoAsset: { deletedAt: null },
      }),
      select: VIDEO_ARTIFACT_SELECT,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  /**
   * One-shot crop → inference-job link. Runs under the PARENT ASSET's
   * advisory lock (taken FIRST, before any read — the same key/idiom as
   * softDelete/transitionStatus/authorizeScreeningPreviewServe), so the
   * link SERIALIZES with asset deletion: without the lock, the
   * non-deleted-parent predicate could pass, the delete (which holds the
   * lock and ENUMERATES linked jobs to retire) could commit in between,
   * and this link would commit AFTER the enumeration ran — leaving a
   * QUEUED job the delete flow never cancels. With the lock, either the
   * link commits first (and the delete's enumeration sees and retires the
   * job) or the delete commits first (and the conditional write below
   * zeroes out). The caller therefore passes the parent `videoAssetId`
   * explicitly — the lock must precede the guarded read, so the id cannot
   * be learned by reading first; the where clauses also pin the artifact
   * to that parent, so a mismatched pair reads as not-found instead of
   * locking one asset while linking another's crop. Conditional write
   * (inferenceJobId IS NULL and the parent asset NOT soft-deleted): the
   * append-only trigger allows exactly this mutation, two concurrent
   * creations cannot both stamp — the loser reads the winner's link back
   * and replays it — and a parent DELETE racing the link zeroes the count
   * instead of linking a job to a deleted asset's crop.
   */
  linkArtifactToInferenceJob(
    tenantId: string,
    videoAssetId: string,
    artifactId: string,
    inferenceJobId: string,
    buildAuditEntry: (
      before: VideoArtifactView,
      after: VideoArtifactView,
    ) => AuditEntry,
  ): Promise<VideoArtifactView | LinkArtifactRejection | null> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      // The asset lock comes FIRST — before the guarded read — so the
      // deletion race above cannot slip between a read and the write.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${videoAssetAdvisoryLockKey(
        scopedTenantId,
        videoAssetId,
      )}))`;
      const before = await tx.videoArtifact.findFirst({
        // Deleted-parent scoping here too: a deleted asset's crop can
        // neither link nor replay a job.
        where: {
          id: artifactId,
          tenantId: scopedTenantId,
          videoAssetId,
          videoAsset: { deletedAt: null },
        },
        select: VIDEO_ARTIFACT_SELECT,
      });
      if (!before) {
        return null;
      }
      if (before.inferenceJobId) {
        return 'already-linked' as const;
      }
      const linked = await tx.videoArtifact.updateMany({
        // The non-deleted-parent condition is part of the CONDITIONAL WRITE
        // itself, not just the read above: even under the advisory lock the
        // atomic predicate stays — a job must never link to a crop whose
        // parent (and media) is already gone.
        where: {
          id: artifactId,
          tenantId: scopedTenantId,
          videoAssetId,
          inferenceJobId: null,
          videoAsset: { deletedAt: null },
        },
        data: { inferenceJobId },
      });
      if (linked.count === 0) {
        // Count 0 now has two causes: a concurrent link stamped first, or
        // the parent was deleted before the lock was acquired. Re-read
        // through the deleted-parent scope to report the honest one — null
        // (gone, 404 downstream) vs already-linked (caller replays the
        // winner's link).
        const stillVisible = await tx.videoArtifact.findFirst({
          where: {
            id: artifactId,
            tenantId: scopedTenantId,
            videoAssetId,
            videoAsset: { deletedAt: null },
          },
          select: { id: true },
        });
        return stillVisible ? ('already-linked' as const) : null;
      }
      const after = await tx.videoArtifact.findFirstOrThrow({
        where: { id: artifactId, tenantId: scopedTenantId },
        select: VIDEO_ARTIFACT_SELECT,
      });
      await this.auditLog.record(buildAuditEntry(before, after), tx);
      return after;
    });
  }
}
