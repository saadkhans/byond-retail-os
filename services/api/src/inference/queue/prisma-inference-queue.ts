import { Injectable } from '@nestjs/common';
import {
  InferenceJobStatus,
  InferenceJobType,
  Prisma,
} from '@prisma/client';
import { AuditAction } from '@prisma/client';
import {
  AuditEntry,
  AuditLogService,
  SYSTEM_ACTOR_EMAIL,
} from '../../common/audit/audit-log.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TenantScopedRepository } from '../../prisma/tenant-scoped.repository';
import { NormalizedInferenceResult } from '../adapters/inference-adapter';
import {
  INFERENCE_JOB_DETAIL_INCLUDE,
  InferenceJobDetail,
} from '../inference-jobs.repository';
import {
  EnqueueJobInput,
  EnqueueRejection,
  FailJobInput,
  INFERENCE_JOB_LEASE_SECONDS,
  INFERENCE_JOB_MAX_ATTEMPTS,
  InferenceQueuePort,
  LEASE_EXPIRED_ERROR_CODE,
  TransitionRejection,
} from './inference-queue.port';

/** Deterministic claim ordering: strongest priority first, then FIFO. */
export const QUEUE_CLAIM_ORDER = [
  { priority: 'desc' },
  { requestedAt: 'asc' },
  { id: 'asc' },
] satisfies Prisma.InferenceJobOrderByWithRelationInput[];

const TERMINAL_STATUSES: readonly InferenceJobStatus[] = [
  InferenceJobStatus.SUCCEEDED,
  InferenceJobStatus.FAILED,
  InferenceJobStatus.CANCELLED,
];

/**
 * The Phase 9 queue implementation: the InferenceJob table IS the queue.
 * Deterministic ordering (priority DESC, requestedAt ASC, id ASC), tenant-
 * scoped throughout, and race-safe transitions via guarded compare-and-set
 * updates (`updateMany` with the expected status in the WHERE; a count of 0
 * means another worker won). No broker dependency — message-queue adapters
 * can implement InferenceQueuePort in later phases.
 */
@Injectable()
export class PrismaInferenceQueue
  extends TenantScopedRepository
  implements InferenceQueuePort<InferenceJobDetail>
{
  constructor(
    prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {
    super(prisma);
  }

  /**
   * Creates a QUEUED job after tenant-scoped reference checks, all inside
   * the insert transaction (with the composite same-tenant FKs in migration
   * SQL as the backstop). Idempotent: at-least-once trigger delivery with
   * the same key replays the original job untouched — no duplicate, no
   * audit row.
   */
  enqueue(
    tenantId: string,
    input: EnqueueJobInput,
    buildAuditEntry: (job: InferenceJobDetail) => AuditEntry,
  ): Promise<
    { job: InferenceJobDetail; replayed: boolean } | EnqueueRejection
  > {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      if (input.idempotencyKey) {
        const existing = await tx.inferenceJob.findFirst({
          where: {
            tenantId: scopedTenantId,
            idempotencyKey: input.idempotencyKey,
          },
          include: INFERENCE_JOB_DETAIL_INCLUDE,
        });
        if (existing) {
          return { job: existing, replayed: true };
        }
      }
      if (input.locationId) {
        const location = await tx.location.findFirst({
          where: { id: input.locationId, tenantId: scopedTenantId },
          select: { id: true },
        });
        if (!location) {
          return 'location-not-found' as const;
        }
      }
      if (input.unitId) {
        const unit = await tx.retailUnit.findFirst({
          where: { id: input.unitId, tenantId: scopedTenantId },
          select: { id: true, locationId: true },
        });
        if (!unit) {
          return 'unit-not-found' as const;
        }
        if (input.locationId && unit.locationId !== input.locationId) {
          return 'unit-location-mismatch' as const;
        }
      }
      if (input.deviceId) {
        const device = await tx.device.findFirst({
          where: { id: input.deviceId, tenantId: scopedTenantId },
          select: { id: true, unitId: true },
        });
        if (!device) {
          return 'device-not-found' as const;
        }
        if (input.unitId && device.unitId !== input.unitId) {
          return 'device-unit-mismatch' as const;
        }
      }
      if (input.sessionId) {
        const session = await tx.checkoutSession.findFirst({
          where: { id: input.sessionId, tenantId: scopedTenantId },
          select: { id: true, unitId: true },
        });
        if (!session) {
          return 'session-not-found' as const;
        }
        // A job bound to a session at a DIFFERENT unit could later convert
        // into a vision event that mutates another unit's basket — same rule
        // as vision ingest.
        if (input.unitId && session.unitId !== input.unitId) {
          return 'session-unit-mismatch' as const;
        }
      }
      const job = await tx.inferenceJob.create({
        data: {
          tenantId: scopedTenantId,
          locationId: input.locationId,
          unitId: input.unitId,
          deviceId: input.deviceId,
          sessionId: input.sessionId,
          jobType: input.jobType,
          priority: input.priority,
          sourceType: input.sourceType,
          sourceId: input.sourceId,
          inputDescriptor: input.inputDescriptor,
          idempotencyKey: input.idempotencyKey,
          createdById: input.createdById,
        },
        include: INFERENCE_JOB_DETAIL_INCLUDE,
      });
      await this.auditLog.record(buildAuditEntry(job), tx);
      return { job, replayed: false };
    });
  }

  /**
   * Lease reclaim: a worker that died after markRunning committed leaves
   * its job RUNNING forever, and QUEUED-only claims would never see it
   * again. Each expired lease is reclaimed with its own guarded compare-
   * and-set transaction (re-checking status AND expiry inside the tx, so a
   * still-alive worker's complete/fail always wins the race) and audited as
   * a SYSTEM action — there is no acting user when the trigger is a crash.
   */
  async reclaimExpired(tenantId: string): Promise<InferenceJobDetail[]> {
    const scopedTenantId = this.requireTenantId(tenantId);
    const now = new Date();
    const expired = await this.prisma.inferenceJob.findMany({
      where: {
        tenantId: scopedTenantId,
        status: InferenceJobStatus.RUNNING,
        leaseExpiresAt: { lt: now },
      },
      select: { id: true },
      orderBy: [{ leaseExpiresAt: 'asc' }, { id: 'asc' }],
    });
    const reclaimed: InferenceJobDetail[] = [];
    for (const { id } of expired) {
      const job = await this.prisma.$transaction(async (tx) => {
        const before = await tx.inferenceJob.findFirst({
          where: {
            id,
            tenantId: scopedTenantId,
            status: InferenceJobStatus.RUNNING,
            leaseExpiresAt: { lt: now },
          },
          include: INFERENCE_JOB_DETAIL_INCLUDE,
        });
        if (!before) {
          return null;
        }
        const exhausted = before.attempts >= INFERENCE_JOB_MAX_ATTEMPTS;
        const updated = await tx.inferenceJob.updateMany({
          where: {
            id,
            tenantId: scopedTenantId,
            status: InferenceJobStatus.RUNNING,
            leaseExpiresAt: { lt: now },
          },
          data: exhausted
            ? {
                status: InferenceJobStatus.FAILED,
                completedAt: new Date(),
                leaseExpiresAt: null,
                errorCode: LEASE_EXPIRED_ERROR_CODE,
                errorMessage:
                  `The worker lease expired ${before.attempts} time(s); ` +
                  'the attempt budget is spent',
              }
            : {
                status: InferenceJobStatus.QUEUED,
                startedAt: null,
                leaseExpiresAt: null,
                adapterKey: null,
              },
        });
        if (updated.count === 0) {
          return null;
        }
        const after = await tx.inferenceJob.findFirstOrThrow({
          where: { id, tenantId: scopedTenantId },
          include: INFERENCE_JOB_DETAIL_INCLUDE,
        });
        await this.auditLog.record(
          {
            tenantId: scopedTenantId,
            actorId: null,
            actorEmail: SYSTEM_ACTOR_EMAIL,
            action: exhausted ? AuditAction.FAIL : AuditAction.UPDATE,
            entityType: 'InferenceJob',
            entityId: id,
            before,
            after,
            reason: exhausted
              ? `Inference job failed (${LEASE_EXPIRED_ERROR_CODE}): lease ` +
                `expired with all ${INFERENCE_JOB_MAX_ATTEMPTS} attempt(s) spent`
              : `Inference job lease expired (attempt ${before.attempts} of ` +
                `${INFERENCE_JOB_MAX_ATTEMPTS}); requeued for another worker`,
          },
          tx,
        );
        return after;
      });
      if (job) {
        reclaimed.push(job);
      }
    }
    return reclaimed;
  }

  async claimNext(
    tenantId: string,
    adapterKey: string,
    buildAuditEntry: (
      before: InferenceJobDetail,
      after: InferenceJobDetail,
    ) => AuditEntry,
    jobType?: InferenceJobType,
  ): Promise<InferenceJobDetail | null> {
    const scopedTenantId = this.requireTenantId(tenantId);
    // Stranded work first: without this, a crashed worker's RUNNING job
    // would be invisible to every future claim.
    await this.reclaimExpired(scopedTenantId);
    // Claim loop: losing a compare-and-set race to another worker moves on
    // to the next queued job instead of failing. Terminates because every
    // iteration either claims or observes the queue shrinking.
    for (;;) {
      const candidate = await this.prisma.inferenceJob.findFirst({
        where: {
          tenantId: scopedTenantId,
          status: InferenceJobStatus.QUEUED,
          ...(jobType ? { jobType } : {}),
        },
        orderBy: QUEUE_CLAIM_ORDER,
        select: { id: true },
      });
      if (!candidate) {
        return null;
      }
      const claimed = await this.markRunning(
        scopedTenantId,
        candidate.id,
        adapterKey,
        buildAuditEntry,
      );
      if (claimed !== null && typeof claimed !== 'string') {
        return claimed;
      }
    }
  }

  markRunning(
    tenantId: string,
    jobId: string,
    adapterKey: string,
    buildAuditEntry: (
      before: InferenceJobDetail,
      after: InferenceJobDetail,
    ) => AuditEntry,
  ): Promise<InferenceJobDetail | TransitionRejection | null> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.inferenceJob.findFirst({
        where: { id: jobId, tenantId: scopedTenantId },
        include: INFERENCE_JOB_DETAIL_INCLUDE,
      });
      if (!before) {
        return null;
      }
      if (before.status !== InferenceJobStatus.QUEUED) {
        return TERMINAL_STATUSES.includes(before.status)
          ? ('terminal' as const)
          : ('not-claimable' as const);
      }
      // Compare-and-set: two concurrent starters both read QUEUED, but the
      // second update re-evaluates the predicate after the first commits and
      // matches zero rows — a controlled rejection, never a double start.
      const updated = await tx.inferenceJob.updateMany({
        where: {
          id: jobId,
          tenantId: scopedTenantId,
          status: InferenceJobStatus.QUEUED,
        },
        data: {
          status: InferenceJobStatus.RUNNING,
          startedAt: new Date(),
          adapterKey,
          attempts: { increment: 1 },
          leaseExpiresAt: new Date(
            Date.now() + INFERENCE_JOB_LEASE_SECONDS * 1000,
          ),
        },
      });
      if (updated.count === 0) {
        return 'not-claimable' as const;
      }
      const after = await tx.inferenceJob.findFirstOrThrow({
        where: { id: jobId, tenantId: scopedTenantId },
        include: INFERENCE_JOB_DETAIL_INCLUDE,
      });
      await this.auditLog.record(buildAuditEntry(before, after), tx);
      return after;
    });
  }

  complete(
    tenantId: string,
    jobId: string,
    result: NormalizedInferenceResult,
    buildAuditEntry: (
      before: InferenceJobDetail,
      after: InferenceJobDetail,
    ) => AuditEntry,
  ): Promise<InferenceJobDetail | TransitionRejection | null> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.inferenceJob.findFirst({
        where: { id: jobId, tenantId: scopedTenantId },
        include: INFERENCE_JOB_DETAIL_INCLUDE,
      });
      if (!before) {
        return null;
      }
      if (before.status !== InferenceJobStatus.RUNNING) {
        return TERMINAL_STATUSES.includes(before.status)
          ? ('terminal' as const)
          : ('not-running' as const);
      }
      const updated = await tx.inferenceJob.updateMany({
        where: {
          id: jobId,
          tenantId: scopedTenantId,
          status: InferenceJobStatus.RUNNING,
        },
        data: {
          status: InferenceJobStatus.SUCCEEDED,
          completedAt: new Date(),
          leaseExpiresAt: null,
        },
      });
      if (updated.count === 0) {
        return 'terminal' as const;
      }
      // The result and its ranked candidates commit atomically WITH the
      // status flip — a SUCCEEDED job always has its result. Both tables
      // are append-only (DB triggers): what the adapter produced never
      // changes.
      await tx.inferenceResult.create({
        data: {
          tenantId: scopedTenantId,
          jobId,
          eventType: result.eventType,
          quantityDelta: result.quantityDelta,
          occurredAt: result.occurredAt,
          evidenceScore: result.evidenceScore,
          evidenceQuality: result.evidenceQuality,
          modelKey: result.modelKey,
          modelVersion: result.modelVersion,
          candidates: {
            create: result.candidates.map((candidate) => ({
              tenantId: scopedTenantId,
              rank: candidate.rank,
              sku: candidate.sku,
              label: candidate.label,
              score: candidate.score,
            })),
          },
        },
      });
      const after = await tx.inferenceJob.findFirstOrThrow({
        where: { id: jobId, tenantId: scopedTenantId },
        include: INFERENCE_JOB_DETAIL_INCLUDE,
      });
      await this.auditLog.record(buildAuditEntry(before, after), tx);
      return after;
    });
  }

  fail(
    tenantId: string,
    jobId: string,
    input: FailJobInput,
    buildAuditEntry: (
      before: InferenceJobDetail,
      after: InferenceJobDetail,
    ) => AuditEntry,
  ): Promise<InferenceJobDetail | TransitionRejection | null> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.inferenceJob.findFirst({
        where: { id: jobId, tenantId: scopedTenantId },
        include: INFERENCE_JOB_DETAIL_INCLUDE,
      });
      if (!before) {
        return null;
      }
      // Failing is allowed from QUEUED (e.g. no adapter can take the job)
      // and from RUNNING; terminal statuses never transition again.
      if (TERMINAL_STATUSES.includes(before.status)) {
        return 'terminal' as const;
      }
      const updated = await tx.inferenceJob.updateMany({
        where: {
          id: jobId,
          tenantId: scopedTenantId,
          status: {
            in: [InferenceJobStatus.QUEUED, InferenceJobStatus.RUNNING],
          },
        },
        data: {
          status: InferenceJobStatus.FAILED,
          completedAt: new Date(),
          leaseExpiresAt: null,
          errorCode: input.errorCode,
          errorMessage: input.errorMessage,
        },
      });
      if (updated.count === 0) {
        return 'terminal' as const;
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
