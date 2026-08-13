import {
  EvidenceSourceType,
  InferenceJobStatus,
  InferenceJobType,
  Prisma,
} from '@prisma/client';
import { AuditEntry } from '../../common/audit/audit-log.service';
import { NormalizedInferenceResult } from '../adapters/inference-adapter';

/** Job creation input, already validated/screened by the service. */
export interface EnqueueJobInput {
  locationId?: string;
  unitId?: string;
  deviceId?: string;
  sessionId?: string;
  jobType: InferenceJobType;
  priority: number;
  sourceType?: EvidenceSourceType;
  sourceId?: string;
  inputDescriptor?: Prisma.InputJsonValue;
  idempotencyKey?: string;
  createdById?: string;
  /**
   * Opt-in two-phase creation for callers that must commit a downstream
   * link before the work may be delivered: the job is created
   * PENDING_LINK (NEVER claimable) instead of QUEUED, and the caller
   * publishes it with publishPendingLink() once its link commits. Default
   * (false/absent) is the Phase 9 behaviour — a directly QUEUED job.
   */
  pendingLink?: boolean;
}

export type EnqueueRejection =
  | 'location-not-found'
  | 'unit-not-found'
  | 'unit-location-mismatch'
  | 'device-not-found'
  | 'device-unit-mismatch'
  | 'session-not-found'
  | 'session-unit-mismatch'
  | 'session-location-mismatch'
  | 'creator-not-found';

export interface FailJobInput {
  errorCode: string;
  errorMessage?: string;
}

/**
 * 'not-queued': the job had already left the CANCELLABLE set (PENDING_LINK
 * or QUEUED) — claimed or finished, before or during the cancellation
 * compare-and-set — so nothing was cancelled and nothing was written.
 */
export type CancelQueuedRejection = 'not-queued';

/**
 * 'not-pending': the job was not PENDING_LINK — before or during the
 * publish compare-and-set — so it was already published, cancelled, or
 * otherwise past the link window. Nothing was written and nothing audited.
 */
export type PublishPendingLinkRejection = 'not-pending';

/**
 * The statuses a job may be cancelled from (see cancelQueued): work that
 * no worker owns yet. PENDING_LINK is included so a crash-window job whose
 * downstream link never committed can still be retired.
 */
export const CANCELLABLE_STATUSES: readonly InferenceJobStatus[] = [
  InferenceJobStatus.PENDING_LINK,
  InferenceJobStatus.QUEUED,
];

/**
 * 'lease-superseded': the caller's view of the job predates a lease
 * reclaim + re-claim — another attempt now owns the job, so a late result
 * from the previous attempt must not commit under the new attempt's lease.
 */
export type TransitionRejection =
  | 'not-claimable'
  | 'not-running'
  | 'terminal'
  | 'lease-superseded';

/**
 * Lease ownership: every claim takes a lease of this many seconds and
 * increments the job's attempt counter; complete/fail clear the lease. A
 * RUNNING job whose lease expired belonged to a crashed/hung worker and is
 * reclaimed on the next claim pass.
 */
export const INFERENCE_JOB_LEASE_SECONDS = 300;

/**
 * A job whose lease expired with this many attempts already spent FAILS
 * with LEASE_EXPIRED instead of requeueing — at-least-once delivery, but
 * never an infinite crash loop.
 */
export const INFERENCE_JOB_MAX_ATTEMPTS = 3;

/** Stable error code stamped on jobs that exhausted their lease attempts. */
export const LEASE_EXPIRED_ERROR_CODE = 'LEASE_EXPIRED';

/**
 * The queue abstraction: enqueue, publish two-phase work
 * (publishPendingLink), claim, drive the job lifecycle, and cancel
 * unclaimed work (cancelQueued) — EVERY queue-lifecycle mutation goes
 * through this port, cancellation and publication included, so an
 * implementation always learns when work becomes deliverable or is
 * withdrawn. Phase 9 ships exactly one
 * implementation — the database-backed PrismaInferenceQueue (deterministic
 * ordering: priority DESC, requestedAt ASC, id ASC; tenant-safe
 * compare-and-set transitions). Message-broker adapters can implement this
 * same port in later phases without touching core code; no broker
 * dependency exists today.
 *
 * The generic parameter object shapes are defined by the repository module
 * (Prisma payload types); the port stays engine-neutral by treating the job
 * detail as an opaque generic.
 */
export abstract class InferenceQueuePort<TJobDetail = unknown> {
  /**
   * Create (or idempotently replay) a job — QUEUED by default, or the
   * NON-CLAIMABLE PENDING_LINK state when `input.pendingLink` is set (the
   * caller then publishes it with publishPendingLink once its downstream
   * link commits). A replay returns the EXISTING row untouched whatever
   * its status.
   */
  abstract enqueue(
    tenantId: string,
    input: EnqueueJobInput,
    buildAuditEntry: (job: TJobDetail) => AuditEntry,
  ): Promise<
    { job: TJobDetail; replayed: boolean } | EnqueueRejection
  >;

  /**
   * Reclaim RUNNING jobs whose lease expired (crashed/hung worker): back to
   * QUEUED while attempts remain, FAILED with LEASE_EXPIRED once
   * INFERENCE_JOB_MAX_ATTEMPTS is spent. Every reclaim is audited as a
   * SYSTEM action. Returns the reclaimed jobs. claimNext and the /start
   * service path run this first, so stranded work re-enters the queue
   * without an operator.
   */
  abstract reclaimExpired(tenantId: string): Promise<TJobDetail[]>;

  /**
   * Claim the highest-priority QUEUED job (priority DESC, requestedAt ASC,
   * id ASC) and flip it RUNNING under the given adapter, taking a lease
   * (INFERENCE_JOB_LEASE_SECONDS) and incrementing attempts. Returns null
   * when the tenant's queue is empty. The candidate query pins
   * status = QUEUED, so a PENDING_LINK job is NEVER claimed.
   */
  abstract claimNext(
    tenantId: string,
    adapterKey: string,
    buildAuditEntry: (before: TJobDetail, after: TJobDetail) => AuditEntry,
    jobType?: InferenceJobType,
  ): Promise<TJobDetail | null>;

  /** QUEUED → RUNNING for a specific job (compare-and-set on status). */
  abstract markRunning(
    tenantId: string,
    jobId: string,
    adapterKey: string,
    buildAuditEntry: (before: TJobDetail, after: TJobDetail) => AuditEntry,
  ): Promise<TJobDetail | TransitionRejection | null>;

  /**
   * RUNNING → SUCCEEDED, persisting the normalized result and its ranked
   * candidates atomically with the status flip. `expectedAttempts` fences
   * the transition to the attempt the caller observed: a stale worker whose
   * lease was reclaimed (and whose job was re-claimed, bumping `attempts`)
   * gets 'lease-superseded' instead of committing its result under the new
   * attempt's lease.
   */
  abstract complete(
    tenantId: string,
    jobId: string,
    expectedAttempts: number,
    result: NormalizedInferenceResult,
    buildAuditEntry: (before: TJobDetail, after: TJobDetail) => AuditEntry,
  ): Promise<TJobDetail | TransitionRejection | null>;

  /**
   * QUEUED/RUNNING → FAILED with a stable error code, fenced to the
   * observed attempt exactly like complete().
   */
  abstract fail(
    tenantId: string,
    jobId: string,
    expectedAttempts: number,
    input: FailJobInput,
    buildAuditEntry: (before: TJobDetail, after: TJobDetail) => AuditEntry,
  ): Promise<TJobDetail | TransitionRejection | null>;

  /**
   * PENDING_LINK → QUEUED compare-and-set: the second phase of two-phase
   * creation (see InferenceJobsService.publishPendingLinkJob). Publication
   * is a queue-lifecycle mutation — a broker-backed implementation ENQUEUES
   * its message here, which is precisely why the job must not be
   * deliverable before this call. Only a PENDING_LINK job publishes;
   * anything else (already published, cancelled, claimed) returns
   * 'not-pending' without writing or auditing, and a job missing in this
   * tenant returns null.
   */
  abstract publishPendingLink(
    tenantId: string,
    jobId: string,
    buildAuditEntry: (before: TJobDetail, after: TJobDetail) => AuditEntry,
  ): Promise<TJobDetail | PublishPendingLinkRejection | null>;

  /**
   * PENDING_LINK/QUEUED → CANCELLED compare-and-set for the orphaned-job
   * compensation path (see InferenceJobsService.cancelOrphanedJob): work
   * whose source media is gone must leave the queue, so an implementation
   * that holds queued work outside the database (a message broker) drops or
   * tombstones the message here — the orphan is never delivered to a
   * worker. A PENDING_LINK job cancels exactly like a QUEUED one: that is
   * what lets a later DELETE retire a job whose downstream link never
   * committed. A job that was claimed or finished (before or during the
   * CAS) returns 'not-queued' without writing, and a job missing in this
   * tenant returns null.
   */
  abstract cancelQueued(
    tenantId: string,
    jobId: string,
    buildAuditEntry: (before: TJobDetail, after: TJobDetail) => AuditEntry,
  ): Promise<TJobDetail | CancelQueuedRejection | null>;
}
