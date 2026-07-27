import { Injectable } from '@nestjs/common';
import {
  Prisma,
  VideoArtifactType,
  VideoAssetStatus,
  VideoCropReason,
} from '@prisma/client';
import {
  AuditEntry,
  AuditLogService,
} from '../common/audit/audit-log.service';
import {
  deviceAdvisoryLockKey,
  unitAdvisoryLockKey,
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
          // every new upload lands QUARANTINED. The operator attestation
          // proves nothing about the bytes, so the asset stays
          // non-processable until an audited screening decision releases
          // (→ UPLOADED) or rejects (media removed, → REJECTED) it.
          status: VideoAssetStatus.QUARANTINED,
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
  ): Promise<VideoAssetView | null> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.videoAsset.findFirst({
        where: { id, tenantId: scopedTenantId, deletedAt: null },
        select: VIDEO_ASSET_SELECT,
      });
      if (!before || !expected.includes(before.status)) {
        return null;
      }
      const updated = await tx.videoAsset.updateMany({
        where: {
          id,
          tenantId: scopedTenantId,
          deletedAt: null,
          status: { in: expected },
        },
        data,
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
   * Soft delete: stamps deletedAt (CAS on "not yet deleted") and audits.
   * The metadata row is KEPT for lineage — artifacts stay append-only and
   * their rows keep referencing the asset; only the local files go away
   * (the service removes them after this commits).
   */
  softDelete(
    tenantId: string,
    id: string,
    buildAuditEntry: (before: VideoAssetView) => AuditEntry,
  ): Promise<VideoAssetView | null> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.videoAsset.findFirst({
        where: { id, tenantId: scopedTenantId, deletedAt: null },
        select: VIDEO_ASSET_SELECT,
      });
      if (!before) {
        return null;
      }
      const updated = await tx.videoAsset.updateMany({
        where: { id, tenantId: scopedTenantId, deletedAt: null },
        data: { deletedAt: new Date() },
      });
      if (updated.count === 0) {
        return null;
      }
      await this.auditLog.record(buildAuditEntry(before), tx);
      return before;
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
   */
  createArtifactsBatch(
    tenantId: string,
    videoAssetId: string,
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
      }
    | 'key-conflict'
    | null
  > {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
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
      return { asset: after, artifacts, replayed: false };
    });
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
   * One-shot crop → inference-job link. Conditional write (inferenceJobId
   * IS NULL and the parent asset NOT soft-deleted): the append-only trigger
   * allows exactly this mutation, two concurrent creations cannot both
   * stamp — the loser reads the winner's link back and replays it — and a
   * parent DELETE racing the link zeroes the count instead of linking a job
   * to a deleted asset's crop.
   */
  linkArtifactToInferenceJob(
    tenantId: string,
    artifactId: string,
    inferenceJobId: string,
    buildAuditEntry: (
      before: VideoArtifactView,
      after: VideoArtifactView,
    ) => AuditEntry,
  ): Promise<VideoArtifactView | LinkArtifactRejection | null> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.videoArtifact.findFirst({
        // Deleted-parent scoping here too: a deleted asset's crop can
        // neither link nor replay a job.
        where: {
          id: artifactId,
          tenantId: scopedTenantId,
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
        // itself, not just the read above: a DELETE /video-assets/:id can
        // commit between the two, and a job must never link to a crop whose
        // parent (and media) is already gone.
        where: {
          id: artifactId,
          tenantId: scopedTenantId,
          inferenceJobId: null,
          videoAsset: { deletedAt: null },
        },
        data: { inferenceJobId },
      });
      if (linked.count === 0) {
        // Count 0 now has two causes: a concurrent link stamped first, or
        // the parent was deleted after the read above. Re-read through the
        // deleted-parent scope to report the honest one — null (gone, 404
        // downstream) vs already-linked (caller replays the winner's link).
        const stillVisible = await tx.videoArtifact.findFirst({
          where: {
            id: artifactId,
            tenantId: scopedTenantId,
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
