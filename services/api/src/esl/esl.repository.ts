import { Injectable } from '@nestjs/common';
import {
  EslGateway,
  EslGatewayStatus,
  EslLabel,
  EslLabelStatus,
  EslUpdateErrorCode,
  EslUpdateJob,
  EslUpdateJobStatus,
  EslUpdateTrigger,
  Prisma,
} from '@prisma/client';
import { AuditEntry, AuditLogService } from '../common/audit/audit-log.service';
import { PrismaService } from '../prisma/prisma.service';
import { TenantScopedRepository } from '../prisma/tenant-scoped.repository';
import {
  ESL_UPDATE_LEASE_SECONDS,
  ESL_UPDATE_MAX_ATTEMPTS,
} from './esl.constants';
import { attemptsExhausted, nextAttemptAt } from './esl.logic';

export const GATEWAY_DETAIL_INCLUDE = {
  location: { select: { id: true, code: true, name: true } },
  _count: { select: { labels: true } },
} satisfies Prisma.EslGatewayInclude;

export type EslGatewayDetail = Prisma.EslGatewayGetPayload<{
  include: typeof GATEWAY_DETAIL_INCLUDE;
}>;

export const LABEL_DETAIL_INCLUDE = {
  gateway: { select: { id: true, code: true, vendorCode: true, status: true } },
  product: { select: { id: true, sku: true, name: true } },
  cellAssignment: { select: { id: true, cellCode: true, rackId: true } },
} satisfies Prisma.EslLabelInclude;

export type EslLabelDetail = Prisma.EslLabelGetPayload<{
  include: typeof LABEL_DETAIL_INCLUDE;
}>;

export const JOB_DETAIL_INCLUDE = {
  label: { select: { id: true, vendorLabelId: true, productId: true } },
  gateway: { select: { id: true, code: true, vendorCode: true } },
} satisfies Prisma.EslUpdateJobInclude;

export type EslUpdateJobDetail = Prisma.EslUpdateJobGetPayload<{
  include: typeof JOB_DETAIL_INCLUDE;
}>;

/**
 * Claim order: oldest request first, id as the tie-break, so two workers
 * racing over the same queue see the same sequence and a test can reproduce
 * it. Same shape as the inference queue's.
 */
const CLAIM_ORDER: Prisma.EslUpdateJobOrderByWithRelationInput[] = [
  { requestedAt: 'asc' },
  { id: 'asc' },
];

/** Statuses a job can never leave. */
const TERMINAL: EslUpdateJobStatus[] = [
  EslUpdateJobStatus.SUCCEEDED,
  EslUpdateJobStatus.FAILED,
  EslUpdateJobStatus.CANCELLED,
];

export type GatewayRejection =
  | 'code-taken'
  | 'location-not-found'
  | 'gateway-not-found';

export type LabelRejection =
  | 'gateway-not-found'
  | 'label-not-found'
  | 'label-retired'
  | 'product-not-found'
  | 'cell-not-found';

export type JobTransitionRejection =
  | 'not-running'
  | 'terminal'
  | 'lease-superseded'
  | 'job-not-found';

export interface EnqueueJobInput {
  labelId: string;
  gatewayId: string;
  trigger: EslUpdateTrigger;
  priceBookVersionId: string | null;
  contentHash: string;
  idempotencyKey: string;
  createdById?: string | null;
}

export interface RenderOutcome {
  contentHash: string;
  batteryPercent: number | null;
  signalPercent: number | null;
  priceBookVersionId: string | null;
}

/**
 * Data access for electronic shelf labels. Every method takes `tenantId`
 * first and scopes every query with it (AGENTS.md tenancy invariant), and
 * every audited mutation commits its audit row in the same transaction as the
 * change, exactly as the inventory ledger and pricing repositories do.
 */
@Injectable()
export class EslRepository extends TenantScopedRepository {
  /** Attempt budget, exposed so the service can explain itself in errors. */
  readonly maxAttempts = ESL_UPDATE_MAX_ATTEMPTS;

  constructor(
    prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {
    super(prisma);
  }

  // ------------------------------------------------------------- gateways

  createGateway(
    tenantId: string,
    data: {
      code: string;
      name: string;
      vendorCode: string;
      locationId: string;
      credentialRef: string | null;
      metadata?: Prisma.InputJsonValue;
      createdById?: string | null;
    },
    buildAudit: (gateway: EslGateway) => AuditEntry,
  ): Promise<EslGatewayDetail | GatewayRejection> {
    const scoped = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      const location = await tx.location.findFirst({
        where: { id: data.locationId, tenantId: scoped },
        select: { id: true },
      });
      if (!location) {
        return 'location-not-found' as const;
      }
      const clash = await tx.eslGateway.findFirst({
        where: { tenantId: scoped, code: data.code },
        select: { id: true },
      });
      if (clash) {
        return 'code-taken' as const;
      }
      const created = await tx.eslGateway.create({
        data: {
          tenantId: scoped,
          code: data.code,
          name: data.name,
          vendorCode: data.vendorCode,
          locationId: data.locationId,
          credentialRef: data.credentialRef,
          ...(data.metadata === undefined ? {} : { metadata: data.metadata }),
          createdById: data.createdById ?? null,
        },
      });
      await this.auditLog.record(buildAudit(created), tx);
      return tx.eslGateway.findFirstOrThrow({
        where: { id: created.id, tenantId: scoped },
        include: GATEWAY_DETAIL_INCLUDE,
      });
    });
  }

  async findGateways(
    tenantId: string,
    filter: { status?: EslGatewayStatus; locationId?: string },
    page: { skip: number; take: number },
  ): Promise<{ items: EslGatewayDetail[]; total: number }> {
    const where = this.scope(tenantId, {
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.locationId ? { locationId: filter.locationId } : {}),
    });
    const [items, total] = await Promise.all([
      this.prisma.eslGateway.findMany({
        where,
        include: GATEWAY_DETAIL_INCLUDE,
        orderBy: [{ code: 'asc' }],
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.eslGateway.count({ where }),
    ]);
    return { items, total };
  }

  findGatewayById(
    tenantId: string,
    id: string,
  ): Promise<EslGatewayDetail | null> {
    return this.prisma.eslGateway.findFirst({
      where: this.scope(tenantId, { id }),
      include: GATEWAY_DETAIL_INCLUDE,
    });
  }

  updateGateway(
    tenantId: string,
    id: string,
    data: {
      name?: string;
      status?: EslGatewayStatus;
      credentialRef?: string | null;
      metadata?: Prisma.InputJsonValue | null;
    },
    buildAudit: (before: EslGateway, after: EslGateway) => AuditEntry,
  ): Promise<EslGatewayDetail | GatewayRejection> {
    const scoped = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.eslGateway.findFirst({
        where: { id, tenantId: scoped },
      });
      if (!before) {
        return 'gateway-not-found' as const;
      }
      const after = await tx.eslGateway.update({
        where: { id_tenantId: { id: before.id, tenantId: scoped } },
        data: {
          ...(data.name === undefined ? {} : { name: data.name }),
          ...(data.status === undefined ? {} : { status: data.status }),
          ...(data.credentialRef === undefined
            ? {}
            : { credentialRef: data.credentialRef }),
          ...(data.metadata === undefined
            ? {}
            : {
                metadata:
                  data.metadata === null ? Prisma.DbNull : data.metadata,
              }),
        },
      });
      await this.auditLog.record(buildAudit(before, after), tx);
      // Disabling a gateway retires the work queued for it: those jobs can
      // never succeed, and leaving them QUEUED would make every processing
      // pass burn attempts on hardware an operator deliberately switched off.
      if (
        data.status === EslGatewayStatus.DISABLED &&
        before.status !== EslGatewayStatus.DISABLED
      ) {
        await tx.eslUpdateJob.updateMany({
          where: {
            tenantId: scoped,
            gatewayId: id,
            status: {
              in: [EslUpdateJobStatus.QUEUED, EslUpdateJobStatus.RUNNING],
            },
          },
          data: {
            status: EslUpdateJobStatus.CANCELLED,
            lastErrorCode: EslUpdateErrorCode.GATEWAY_DISABLED,
            claimedAttempt: null,
            leaseExpiresAt: null,
            finishedAt: new Date(),
          },
        });
      }
      return tx.eslGateway.findFirstOrThrow({
        where: { id, tenantId: scoped },
        include: GATEWAY_DETAIL_INCLUDE,
      });
    });
  }

  /** Records that the vendor answered (or did not), without an audit row. */
  async touchGatewaySeen(
    tenantId: string,
    id: string,
    status: EslGatewayStatus,
    now: Date = new Date(),
  ): Promise<void> {
    await this.prisma.eslGateway.updateMany({
      where: this.scope(tenantId, { id }),
      data: { status, lastSeenAt: now },
    });
  }

  // --------------------------------------------------------------- labels

  /**
   * Registers a label, or refreshes the health of one already known. Used by
   * both manual registration and gateway discovery, so a re-discovery never
   * duplicates hardware and never clears a product binding.
   */
  upsertLabel(
    tenantId: string,
    gatewayId: string,
    data: {
      vendorLabelId: string;
      batteryPercent: number | null;
      signalPercent: number | null;
      createdById?: string | null;
    },
    buildAudit: (label: EslLabel, created: boolean) => AuditEntry,
  ): Promise<EslLabelDetail | LabelRejection> {
    const scoped = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      const gateway = await tx.eslGateway.findFirst({
        where: { id: gatewayId, tenantId: scoped },
        select: { id: true },
      });
      if (!gateway) {
        return 'gateway-not-found' as const;
      }
      const existing = await tx.eslLabel.findFirst({
        where: { tenantId: scoped, gatewayId, vendorLabelId: data.vendorLabelId },
      });
      const label = existing
        ? await tx.eslLabel.update({
            where: {
              id_tenantId: { id: existing.id, tenantId: scoped },
            },
            data: {
              batteryPercent: data.batteryPercent,
              signalPercent: data.signalPercent,
            },
          })
        : await tx.eslLabel.create({
            data: {
              tenantId: scoped,
              gatewayId,
              vendorLabelId: data.vendorLabelId,
              batteryPercent: data.batteryPercent,
              signalPercent: data.signalPercent,
              createdById: data.createdById ?? null,
            },
          });
      await this.auditLog.record(buildAudit(label, !existing), tx);
      return tx.eslLabel.findFirstOrThrow({
        where: { id: label.id, tenantId: scoped },
        include: LABEL_DETAIL_INCLUDE,
      });
    });
  }

  async findLabels(
    tenantId: string,
    filter: { gatewayId?: string; status?: EslLabelStatus; productId?: string },
    page: { skip: number; take: number },
  ): Promise<{ items: EslLabelDetail[]; total: number }> {
    const where = this.scope(tenantId, {
      ...(filter.gatewayId ? { gatewayId: filter.gatewayId } : {}),
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.productId ? { productId: filter.productId } : {}),
    });
    const [items, total] = await Promise.all([
      this.prisma.eslLabel.findMany({
        where,
        include: LABEL_DETAIL_INCLUDE,
        orderBy: [{ vendorLabelId: 'asc' }],
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.eslLabel.count({ where }),
    ]);
    return { items, total };
  }

  findLabelById(tenantId: string, id: string): Promise<EslLabelDetail | null> {
    return this.prisma.eslLabel.findFirst({
      where: this.scope(tenantId, { id }),
      include: LABEL_DETAIL_INCLUDE,
    });
  }

  /**
   * Binds a label to a product, moves it to another shelf cell, or retires
   * it. Binding is what makes a label eligible for price propagation, so it
   * is audited as a configuration change rather than a device reading.
   */
  updateLabel(
    tenantId: string,
    id: string,
    data: {
      productId?: string | null;
      cellAssignmentId?: string | null;
      status?: EslLabelStatus;
    },
    buildAudit: (before: EslLabel, after: EslLabel) => AuditEntry,
  ): Promise<EslLabelDetail | LabelRejection> {
    const scoped = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.eslLabel.findFirst({
        where: { id, tenantId: scoped },
      });
      if (!before) {
        return 'label-not-found' as const;
      }
      // Retirement is one-way: a retired label is hardware that left the
      // shelf. Re-registering it is a discovery, not an edit.
      if (before.status === EslLabelStatus.RETIRED) {
        return 'label-retired' as const;
      }
      if (data.productId) {
        const product = await tx.product.findFirst({
          where: { id: data.productId, tenantId: scoped },
          select: { id: true },
        });
        if (!product) {
          return 'product-not-found' as const;
        }
      }
      if (data.cellAssignmentId) {
        const cell = await tx.planogramCellAssignment.findFirst({
          where: { id: data.cellAssignmentId, tenantId: scoped },
          select: { id: true },
        });
        if (!cell) {
          return 'cell-not-found' as const;
        }
      }
      const nextProductId =
        data.productId === undefined ? before.productId : data.productId;
      const after = await tx.eslLabel.update({
        where: { id_tenantId: { id: before.id, tenantId: scoped } },
        data: {
          ...(data.productId === undefined
            ? {}
            : { productId: data.productId }),
          ...(data.cellAssignmentId === undefined
            ? {}
            : { cellAssignmentId: data.cellAssignmentId }),
          status:
            data.status ??
            (nextProductId ? EslLabelStatus.BOUND : EslLabelStatus.UNBOUND),
        },
      });
      await this.auditLog.record(buildAudit(before, after), tx);
      if (after.status === EslLabelStatus.RETIRED) {
        await tx.eslUpdateJob.updateMany({
          where: {
            tenantId: scoped,
            labelId: id,
            status: {
              in: [EslUpdateJobStatus.QUEUED, EslUpdateJobStatus.RUNNING],
            },
          },
          data: {
            status: EslUpdateJobStatus.CANCELLED,
            lastErrorCode: EslUpdateErrorCode.LABEL_RETIRED,
            claimedAttempt: null,
            leaseExpiresAt: null,
            finishedAt: new Date(),
          },
        });
      }
      return tx.eslLabel.findFirstOrThrow({
        where: { id, tenantId: scoped },
        include: LABEL_DETAIL_INCLUDE,
      });
    });
  }

  /**
   * Bound labels for these products, restricted to a location when the price
   * book was location-scoped. A DISABLED gateway is excluded: an operator
   * switched it off, and queueing for it would only manufacture failures.
   */
  findBoundLabelsForProducts(
    tenantId: string,
    productIds: readonly string[],
    locationId: string | null,
  ): Promise<
    Array<{ id: string; gatewayId: string; productId: string | null }>
  > {
    if (productIds.length === 0) {
      return Promise.resolve([]);
    }
    return this.prisma.eslLabel.findMany({
      where: this.scope(tenantId, {
        status: EslLabelStatus.BOUND,
        productId: { in: [...productIds] },
        gateway: {
          status: { not: EslGatewayStatus.DISABLED },
          ...(locationId ? { locationId } : {}),
        },
      }),
      select: { id: true, gatewayId: true, productId: true },
      orderBy: { id: 'asc' },
    });
  }

  /** Every bound label, for the reconciliation sweep. */
  findAllBoundLabels(tenantId: string): Promise<EslLabelDetail[]> {
    return this.prisma.eslLabel.findMany({
      where: this.scope(tenantId, {
        status: EslLabelStatus.BOUND,
        gateway: { status: { not: EslGatewayStatus.DISABLED } },
      }),
      include: LABEL_DETAIL_INCLUDE,
      orderBy: { id: 'asc' },
    });
  }

  /** The location a label sits in, needed to resolve a location-scoped price. */
  async findLabelLocations(
    tenantId: string,
    labelIds: readonly string[],
  ): Promise<Map<string, string>> {
    if (labelIds.length === 0) {
      return new Map();
    }
    const rows = await this.prisma.eslLabel.findMany({
      where: this.scope(tenantId, { id: { in: [...labelIds] } }),
      select: { id: true, gateway: { select: { locationId: true } } },
    });
    return new Map(rows.map((row) => [row.id, row.gateway.locationId]));
  }

  // ----------------------------------------------------------------- jobs

  /**
   * Enqueues work, skipping anything already queued under the same key. The
   * unique (tenantId, idempotencyKey) index is what makes a replayed price
   * activation — a retried publish, a reconnecting listener, a second sweep —
   * a no-op rather than a duplicate push.
   */
  async enqueueJobs(
    tenantId: string,
    inputs: readonly EnqueueJobInput[],
  ): Promise<number> {
    if (inputs.length === 0) {
      return 0;
    }
    const scoped = this.requireTenantId(tenantId);
    const result = await this.prisma.eslUpdateJob.createMany({
      data: inputs.map((input) => ({
        tenantId: scoped,
        labelId: input.labelId,
        gatewayId: input.gatewayId,
        trigger: input.trigger,
        priceBookVersionId: input.priceBookVersionId,
        contentHash: input.contentHash,
        idempotencyKey: input.idempotencyKey,
        createdById: input.createdById ?? null,
      })),
      skipDuplicates: true,
    });
    return result.count;
  }

  async findJobs(
    tenantId: string,
    filter: {
      status?: EslUpdateJobStatus;
      labelId?: string;
      gatewayId?: string;
    },
    page: { skip: number; take: number },
  ): Promise<{ items: EslUpdateJobDetail[]; total: number }> {
    const where = this.scope(tenantId, {
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.labelId ? { labelId: filter.labelId } : {}),
      ...(filter.gatewayId ? { gatewayId: filter.gatewayId } : {}),
    });
    const [items, total] = await Promise.all([
      this.prisma.eslUpdateJob.findMany({
        where,
        include: JOB_DETAIL_INCLUDE,
        orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.eslUpdateJob.count({ where }),
    ]);
    return { items, total };
  }

  findJobById(
    tenantId: string,
    id: string,
  ): Promise<EslUpdateJobDetail | null> {
    return this.prisma.eslUpdateJob.findFirst({
      where: this.scope(tenantId, { id }),
      include: JOB_DETAIL_INCLUDE,
    });
  }

  /**
   * Returns RUNNING jobs whose lease expired to QUEUED while attempts remain,
   * and FAILS them with LEASE_EXPIRED once the budget is spent. Without this a
   * crashed worker's job would be invisible to every future claim — the same
   * guarantee the inference queue makes.
   */
  async reclaimExpired(
    tenantId: string,
    now: Date = new Date(),
  ): Promise<{ requeued: number; failed: number }> {
    const scoped = this.requireTenantId(tenantId);
    const expired = await this.prisma.eslUpdateJob.findMany({
      where: {
        tenantId: scoped,
        status: EslUpdateJobStatus.RUNNING,
        leaseExpiresAt: { lt: now },
      },
      select: { id: true, attempts: true },
      orderBy: { id: 'asc' },
    });
    let requeued = 0;
    let failed = 0;
    for (const job of expired) {
      const exhausted = attemptsExhausted(job.attempts);
      const updated = await this.prisma.eslUpdateJob.updateMany({
        where: {
          id: job.id,
          tenantId: scoped,
          status: EslUpdateJobStatus.RUNNING,
          attempts: job.attempts,
        },
        data: exhausted
          ? {
              status: EslUpdateJobStatus.FAILED,
              lastErrorCode: EslUpdateErrorCode.LEASE_EXPIRED,
              claimedAttempt: null,
              leaseExpiresAt: null,
              finishedAt: now,
            }
          : {
              status: EslUpdateJobStatus.QUEUED,
              claimedAttempt: null,
              leaseExpiresAt: null,
              nextAttemptAt: nextAttemptAt(job.attempts, now),
            },
      });
      if (updated.count > 0) {
        if (exhausted) {
          failed += 1;
        } else {
          requeued += 1;
        }
      }
    }
    return { requeued, failed };
  }

  /**
   * Claims up to `limit` claimable jobs. Each claim is its own compare-and-set
   * on (status, attempts), so two workers racing over one row produce a single
   * winner and a controlled miss, never a double push.
   */
  async claimBatch(
    tenantId: string,
    limit: number,
    now: Date = new Date(),
  ): Promise<EslUpdateJobDetail[]> {
    const scoped = this.requireTenantId(tenantId);
    const claimed: EslUpdateJobDetail[] = [];
    const skip: string[] = [];
    while (claimed.length < limit) {
      const candidate = await this.prisma.eslUpdateJob.findFirst({
        where: {
          tenantId: scoped,
          status: EslUpdateJobStatus.QUEUED,
          nextAttemptAt: { lte: now },
          ...(skip.length > 0 ? { id: { notIn: skip } } : {}),
        },
        orderBy: CLAIM_ORDER,
        select: { id: true, attempts: true },
      });
      if (!candidate) {
        break;
      }
      // Whatever happens next, this row must not be re-examined by this pass:
      // either we claimed it, or another worker did. Recording it here is what
      // makes the loop terminate.
      skip.push(candidate.id);
      const updated = await this.prisma.eslUpdateJob.updateMany({
        where: {
          id: candidate.id,
          tenantId: scoped,
          status: EslUpdateJobStatus.QUEUED,
          attempts: candidate.attempts,
        },
        data: {
          status: EslUpdateJobStatus.RUNNING,
          startedAt: now,
          attempts: { increment: 1 },
          claimedAttempt: candidate.attempts + 1,
          leaseExpiresAt: new Date(
            now.getTime() + ESL_UPDATE_LEASE_SECONDS * 1000,
          ),
        },
      });
      if (updated.count === 0) {
        continue;
      }
      const job = await this.prisma.eslUpdateJob.findFirst({
        where: { id: candidate.id, tenantId: scoped },
        include: JOB_DETAIL_INCLUDE,
      });
      if (job) {
        claimed.push(job);
      }
    }
    return claimed;
  }

  /** Marks a claimed job done, fenced by the attempt the worker observed. */
  completeJob(
    tenantId: string,
    jobId: string,
    expectedAttempt: number,
    render: RenderOutcome | null,
    buildAudit: (before: EslUpdateJob, after: EslUpdateJob) => AuditEntry,
    now: Date = new Date(),
  ): Promise<EslUpdateJobDetail | JobTransitionRejection> {
    const scoped = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.eslUpdateJob.findFirst({
        where: { id: jobId, tenantId: scoped },
      });
      if (!before) {
        return 'job-not-found' as const;
      }
      const guard = this.guardRunning(before, expectedAttempt);
      if (guard) {
        return guard;
      }
      const updated = await tx.eslUpdateJob.updateMany({
        where: {
          id: jobId,
          tenantId: scoped,
          status: EslUpdateJobStatus.RUNNING,
          claimedAttempt: expectedAttempt,
        },
        data: {
          status: EslUpdateJobStatus.SUCCEEDED,
          claimedAttempt: null,
          leaseExpiresAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
          finishedAt: now,
        },
      });
      if (updated.count === 0) {
        return 'lease-superseded' as const;
      }
      if (render) {
        // The label's rendered state is written in the SAME transaction as
        // the job's success, so "job succeeded" and "label shows this" can
        // never disagree.
        await tx.eslLabel.updateMany({
          where: { id: before.labelId, tenantId: scoped },
          data: {
            lastRenderedAt: now,
            renderedContentHash: render.contentHash,
            renderedVersionId: render.priceBookVersionId,
            ...(render.batteryPercent === null
              ? {}
              : { batteryPercent: render.batteryPercent }),
            ...(render.signalPercent === null
              ? {}
              : { signalPercent: render.signalPercent }),
          },
        });
      }
      const after = await tx.eslUpdateJob.findFirstOrThrow({
        where: { id: jobId, tenantId: scoped },
      });
      await this.auditLog.record(buildAudit(before, after), tx);
      return tx.eslUpdateJob.findFirstOrThrow({
        where: { id: jobId, tenantId: scoped },
        include: JOB_DETAIL_INCLUDE,
      });
    });
  }

  /**
   * Records a failed attempt: back to QUEUED behind a backoff while attempts
   * remain, FAILED once the budget is spent. One label's failure never touches
   * another label's job.
   */
  failJob(
    tenantId: string,
    jobId: string,
    expectedAttempt: number,
    error: { code: EslUpdateErrorCode; message: string | null },
    buildAudit: (before: EslUpdateJob, after: EslUpdateJob) => AuditEntry,
    now: Date = new Date(),
  ): Promise<EslUpdateJobDetail | JobTransitionRejection> {
    const scoped = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.eslUpdateJob.findFirst({
        where: { id: jobId, tenantId: scoped },
      });
      if (!before) {
        return 'job-not-found' as const;
      }
      const guard = this.guardRunning(before, expectedAttempt);
      if (guard) {
        return guard;
      }
      const exhausted = attemptsExhausted(before.attempts);
      const updated = await tx.eslUpdateJob.updateMany({
        where: {
          id: jobId,
          tenantId: scoped,
          status: EslUpdateJobStatus.RUNNING,
          claimedAttempt: expectedAttempt,
        },
        data: {
          status: exhausted
            ? EslUpdateJobStatus.FAILED
            : EslUpdateJobStatus.QUEUED,
          claimedAttempt: null,
          leaseExpiresAt: null,
          lastErrorCode: error.code,
          lastErrorMessage: error.message,
          ...(exhausted
            ? { finishedAt: now }
            : { nextAttemptAt: nextAttemptAt(before.attempts, now) }),
        },
      });
      if (updated.count === 0) {
        return 'lease-superseded' as const;
      }
      const after = await tx.eslUpdateJob.findFirstOrThrow({
        where: { id: jobId, tenantId: scoped },
      });
      await this.auditLog.record(buildAudit(before, after), tx);
      return tx.eslUpdateJob.findFirstOrThrow({
        where: { id: jobId, tenantId: scoped },
        include: JOB_DETAIL_INCLUDE,
      });
    });
  }

  /**
   * Attempt fencing: status alone cannot say WHICH worker owns the lease. If
   * attempt A's lease expired, the job was reclaimed and attempt B claimed it,
   * a late A still sees RUNNING — its result must not commit under B's lease.
   */
  private guardRunning(
    job: EslUpdateJob,
    expectedAttempt: number,
  ): JobTransitionRejection | null {
    if (job.status !== EslUpdateJobStatus.RUNNING) {
      return TERMINAL.includes(job.status)
        ? ('terminal' as const)
        : ('not-running' as const);
    }
    if (job.claimedAttempt !== expectedAttempt) {
      return 'lease-superseded' as const;
    }
    return null;
  }
}
