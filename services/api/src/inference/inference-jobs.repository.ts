import { Injectable } from '@nestjs/common';
import {
  InferenceJobStatus,
  InferenceJobType,
  Prisma,
} from '@prisma/client';
import {
  AuditEntry,
  AuditLogService,
} from '../common/audit/audit-log.service';
import { PrismaService } from '../prisma/prisma.service';
import { TenantScopedRepository } from '../prisma/tenant-scoped.repository';

/** Relations included on every job read (list and detail). */
export const INFERENCE_JOB_INCLUDE = {
  location: { select: { id: true, name: true, code: true } },
  unit: { select: { id: true, name: true, code: true } },
  session: { select: { id: true, status: true } },
} satisfies Prisma.InferenceJobInclude;

/**
 * Read shape for job LIST rows: an explicit scalar select — no result
 * candidates and NO free-form `inputDescriptor` JSON, which is bounded only
 * by the HTTP body limit and could otherwise put megabytes on a single page
 * the table never renders. The descriptor is a detail-view concern.
 */
export const INFERENCE_JOB_LIST_SELECT = {
  id: true,
  tenantId: true,
  locationId: true,
  unitId: true,
  deviceId: true,
  sessionId: true,
  jobType: true,
  status: true,
  priority: true,
  requestedAt: true,
  startedAt: true,
  completedAt: true,
  attempts: true,
  leaseExpiresAt: true,
  sourceType: true,
  sourceId: true,
  adapterKey: true,
  errorCode: true,
  errorMessage: true,
  idempotencyKey: true,
  visionEventId: true,
  createdById: true,
  createdAt: true,
  updatedAt: true,
  location: { select: { id: true, name: true, code: true } },
  unit: { select: { id: true, name: true, code: true } },
  session: { select: { id: true, status: true } },
} satisfies Prisma.InferenceJobSelect;

/**
 * Read shape for job detail: the normalized result with ranked candidates,
 * the input descriptor, and minimal store/unit/device/session references.
 */
export const INFERENCE_JOB_DETAIL_INCLUDE = {
  ...INFERENCE_JOB_INCLUDE,
  device: { select: { id: true, name: true, serialNumber: true } },
  result: {
    include: {
      candidates: { orderBy: [{ rank: 'asc' }, { id: 'asc' }] },
    },
  },
} satisfies Prisma.InferenceJobInclude;

export type InferenceJobWithRefs = Prisma.InferenceJobGetPayload<{
  select: typeof INFERENCE_JOB_LIST_SELECT;
}>;

export type InferenceJobDetail = Prisma.InferenceJobGetPayload<{
  include: typeof INFERENCE_JOB_DETAIL_INCLUDE;
}>;

export type LinkVisionEventRejection = 'already-linked';

@Injectable()
export class InferenceJobsRepository extends TenantScopedRepository {
  constructor(
    prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {
    super(prisma);
  }

  findById(tenantId: string, id: string): Promise<InferenceJobDetail | null> {
    return this.prisma.inferenceJob.findFirst({
      where: this.scope(tenantId, { id }),
      include: INFERENCE_JOB_DETAIL_INCLUDE,
    });
  }

  /** Replay lookup for the enqueue P2002 race (two firsts, same key). */
  findByIdempotencyKey(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<InferenceJobDetail | null> {
    return this.prisma.inferenceJob.findFirst({
      where: this.scope(tenantId, { idempotencyKey }),
      include: INFERENCE_JOB_DETAIL_INCLUDE,
    });
  }

  async search(
    tenantId: string,
    filters: {
      status?: InferenceJobStatus;
      jobType?: InferenceJobType;
      sessionId?: string;
      locationId?: string;
      unitId?: string;
      skip?: number;
      take?: number;
    },
  ): Promise<{ items: InferenceJobWithRefs[]; total: number }> {
    const where: Prisma.InferenceJobWhereInput = this.scope(tenantId);
    if (filters.status) {
      where.status = filters.status;
    }
    if (filters.jobType) {
      where.jobType = filters.jobType;
    }
    if (filters.sessionId) {
      where.sessionId = filters.sessionId;
    }
    if (filters.locationId) {
      where.locationId = filters.locationId;
    }
    if (filters.unitId) {
      where.unitId = filters.unitId;
    }
    const [items, total] = await Promise.all([
      this.prisma.inferenceJob.findMany({
        where,
        select: INFERENCE_JOB_LIST_SELECT,
        // id is the deterministic tie-breaker: requestedAt is millisecond
        // precision, so burst jobs could otherwise reorder across pages.
        orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
        skip: filters.skip ?? 0,
        take: filters.take ?? 25,
      }),
      this.prisma.inferenceJob.count({ where }),
    ]);
    return { items, total };
  }

  /**
   * Records the one-shot job → vision-event link after a successful
   * conversion. Conditional write (visionEventId IS NULL): two concurrent
   * conversions both ingest idempotently (the vision idempotency key is
   * derived from the job id, so the second ingest replays the first's
   * event), but only ONE may stamp the link — the loser reads the winner's
   * link back and replays.
   */
  linkVisionEvent(
    tenantId: string,
    jobId: string,
    visionEventId: string,
    buildAuditEntry: (
      before: InferenceJobDetail,
      after: InferenceJobDetail,
    ) => AuditEntry,
  ): Promise<InferenceJobDetail | LinkVisionEventRejection | null> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.inferenceJob.findFirst({
        where: { id: jobId, tenantId: scopedTenantId },
        include: INFERENCE_JOB_DETAIL_INCLUDE,
      });
      if (!before) {
        return null;
      }
      if (before.visionEventId) {
        return 'already-linked' as const;
      }
      const linked = await tx.inferenceJob.updateMany({
        where: { id: jobId, tenantId: scopedTenantId, visionEventId: null },
        data: { visionEventId },
      });
      if (linked.count === 0) {
        return 'already-linked' as const;
      }
      const after = await tx.inferenceJob.findFirstOrThrow({
        where: { id: jobId, tenantId: scopedTenantId },
        include: INFERENCE_JOB_DETAIL_INCLUDE,
      });
      await this.auditLog.record(buildAuditEntry(before, after), tx);
      return after;
    });
  }
}
