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
      // pairwise rules PrismaInferenceQueue.enqueue() enforces (unit in the
      // store, device on the unit, session on the unit and store).
      // Composite same-tenant FKs only pin each reference's TENANT; without
      // these checks an asset could bind a unit from another store and its
      // crops would forever fail at inference-job creation.
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
      if (data.deviceId) {
        const device = await tx.device.findFirst({
          where: { id: data.deviceId, tenantId: scopedTenantId },
          select: { id: true, unitId: true },
        });
        if (!device) {
          return 'device-not-found' as const;
        }
        if (data.unitId && device.unitId !== data.unitId) {
          return 'device-unit-mismatch' as const;
        }
      }
      if (data.sessionId) {
        const session = await tx.checkoutSession.findFirst({
          where: { id: data.sessionId, tenantId: scopedTenantId },
          select: { id: true, unitId: true, locationId: true },
        });
        if (!session) {
          return 'session-not-found' as const;
        }
        if (data.unitId && session.unitId !== data.unitId) {
          return 'session-unit-mismatch' as const;
        }
        const effectiveLocationId = data.locationId ?? unitLocationId;
        if (effectiveLocationId && session.locationId !== effectiveLocationId) {
          return 'session-location-mismatch' as const;
        }
      }
      const created = await tx.videoAsset.create({
        data: { ...data, tenantId: scopedTenantId },
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
   * The WHOLE extraction result commits as ONE transaction: every artifact
   * row, every artifact audit entry, and the asset's guarded status flip to
   * READY either all land or none do. Artifact rows are append-only, so a
   * partially-committed batch could never be cleaned up — atomic publish is
   * the only shape that keeps a failed request retryable without
   * duplicating committed artifacts. Returns null when the asset is gone or
   * its status left the expected set (CAS lost) — the caller re-reads.
   */
  createArtifactsBatch(
    tenantId: string,
    videoAssetId: string,
    expectedStatuses: VideoAssetStatus[],
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
  ): Promise<{ asset: VideoAssetView; artifacts: VideoArtifactView[] } | null> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
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
      const after = await tx.videoAsset.findFirstOrThrow({
        where: { id: videoAssetId, tenantId: scopedTenantId },
        select: VIDEO_ASSET_SELECT,
      });
      await this.auditLog.record(buildAssetAuditEntry(before, after), tx);
      return { asset: after, artifacts };
    });
  }

  findArtifactById(
    tenantId: string,
    id: string,
  ): Promise<VideoArtifactView | null> {
    return this.prisma.videoArtifact.findFirst({
      where: this.scope(tenantId, { id }),
      select: VIDEO_ARTIFACT_SELECT,
    });
  }

  async listArtifacts(
    tenantId: string,
    videoAssetId: string,
  ): Promise<VideoArtifactView[]> {
    return this.prisma.videoArtifact.findMany({
      where: this.scope(tenantId, { videoAssetId }),
      select: VIDEO_ARTIFACT_SELECT,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  /** Internal: artifact storage keys for an asset (delete cleanup). */
  listArtifactStorageKeys(
    tenantId: string,
    videoAssetId: string,
  ): Promise<{ storageKey: string }[]> {
    return this.prisma.videoArtifact.findMany({
      where: this.scope(tenantId, { videoAssetId }),
      select: { storageKey: true },
    });
  }

  /**
   * One-shot crop → inference-job link. Conditional write (inferenceJobId
   * IS NULL): the append-only trigger allows exactly this mutation, and two
   * concurrent creations cannot both stamp — the loser reads the winner's
   * link back and replays it.
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
        where: { id: artifactId, tenantId: scopedTenantId },
        select: VIDEO_ARTIFACT_SELECT,
      });
      if (!before) {
        return null;
      }
      if (before.inferenceJobId) {
        return 'already-linked' as const;
      }
      const linked = await tx.videoArtifact.updateMany({
        where: {
          id: artifactId,
          tenantId: scopedTenantId,
          inferenceJobId: null,
        },
        data: { inferenceJobId },
      });
      if (linked.count === 0) {
        return 'already-linked' as const;
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
