import { InferenceJobStatus, InferenceJobType } from '@prisma/client';
import {
  AuditEntry,
  SYSTEM_ACTOR_EMAIL,
} from '../../common/audit/audit-log.service';
import { TenantIdRequiredError } from '../../common/errors/domain.errors';
import { PrismaService } from '../../prisma/prisma.service';
import { NormalizedInferenceResult } from '../adapters/inference-adapter';
import { InferenceJobDetail } from '../inference-jobs.repository';
import {
  INFERENCE_JOB_MAX_ATTEMPTS,
  LEASE_EXPIRED_ERROR_CODE,
} from './inference-queue.port';
import { PrismaInferenceQueue, QUEUE_CLAIM_ORDER } from './prisma-inference-queue';

describe('PrismaInferenceQueue', () => {
  const auditEntry = (): AuditEntry => ({
    tenantId: 'tenant-a',
    actorEmail: 'jane@tenant-a.example',
    action: 'CREATE',
    entityType: 'InferenceJob',
  });
  const enqueueAudit = () => auditEntry();
  const transitionAudit = () => auditEntry();

  const queuedJob = {
    id: 'job-1',
    tenantId: 'tenant-a',
    jobType: InferenceJobType.PRODUCT_RECOGNITION,
    status: InferenceJobStatus.QUEUED,
    priority: 100,
    attempts: 0,
  } as unknown as InferenceJobDetail;

  const runningJob = {
    ...queuedJob,
    status: InferenceJobStatus.RUNNING,
    adapterKey: 'simulated',
    attempts: 1,
    leaseExpiresAt: new Date(Date.now() + 300_000),
  } as InferenceJobDetail;

  /** Two-phase creation, first phase: created but NOT yet published. */
  const pendingLinkJob = {
    ...queuedJob,
    status: InferenceJobStatus.PENDING_LINK,
  } as InferenceJobDetail;

  const normalizedResult: NormalizedInferenceResult = {
    eventType: 'PRODUCT_PICKUP',
    quantityDelta: 2,
    occurredAt: new Date('2026-07-26T10:00:30.000Z'),
    candidates: [
      { sku: 'COLA-330', rank: 1, score: 0.92, label: 'red can' },
      { sku: 'CHIPS-50', rank: 2, score: 0.41 },
    ],
    evidenceScore: 0.92,
    evidenceQuality: 'HIGH',
    modelKey: 'sim',
    modelVersion: '1.0',
  };

  const baseEnqueue = {
    jobType: InferenceJobType.PRODUCT_RECOGNITION,
    priority: 100,
    locationId: 'loc-a1',
    unitId: 'unit-a1',
  };

  let tx: {
    $queryRaw: jest.Mock;
    inferenceJob: {
      findFirst: jest.Mock;
      create: jest.Mock;
      updateMany: jest.Mock;
      findFirstOrThrow: jest.Mock;
    };
    inferenceResult: { create: jest.Mock };
    location: { findFirst: jest.Mock };
    retailUnit: { findFirst: jest.Mock };
    device: { findFirst: jest.Mock };
    checkoutSession: { findFirst: jest.Mock };
    user: { findFirst: jest.Mock };
  };
  let auditLog: { record: jest.Mock };
  let prismaFindFirst: jest.Mock;
  let prismaFindMany: jest.Mock;
  let queue: PrismaInferenceQueue;

  beforeEach(() => {
    tx = {
      $queryRaw: jest.fn().mockResolvedValue(undefined),
      inferenceJob: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest
          .fn()
          .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
            Promise.resolve({ id: 'job-1', ...data }),
          ),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findFirstOrThrow: jest.fn().mockResolvedValue(runningJob),
      },
      inferenceResult: {
        create: jest
          .fn()
          .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
            Promise.resolve({ id: 'result-1', ...data }),
          ),
      },
      location: { findFirst: jest.fn().mockResolvedValue({ id: 'loc-a1' }) },
      retailUnit: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'unit-a1', locationId: 'loc-a1' }),
      },
      device: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'dev-1', unitId: 'unit-a1' }),
      },
      checkoutSession: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'sess-1',
          unitId: 'unit-a1',
          locationId: 'loc-a1',
        }),
      },
      user: { findFirst: jest.fn().mockResolvedValue({ id: 'user-1' }) },
    };
    auditLog = { record: jest.fn().mockResolvedValue(undefined) };
    prismaFindFirst = jest.fn().mockResolvedValue(null);
    prismaFindMany = jest.fn().mockResolvedValue([]);
    const prisma = {
      $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
      inferenceJob: { findFirst: prismaFindFirst, findMany: prismaFindMany },
    } as unknown as PrismaService;
    queue = new PrismaInferenceQueue(prisma, auditLog as never);
  });

  describe('tenant isolation', () => {
    it('throws on a blank tenantId instead of widening the query', () => {
      expect(() =>
        queue.enqueue('', baseEnqueue, enqueueAudit),
      ).toThrow(TenantIdRequiredError);
      expect(() =>
        queue.markRunning('  ', 'job-1', 'simulated', transitionAudit),
      ).toThrow(TenantIdRequiredError);
      expect(() =>
        queue.complete('', 'job-1', 1, normalizedResult, transitionAudit),
      ).toThrow(TenantIdRequiredError);
      expect(() =>
        queue.fail('', 'job-1', 0, { errorCode: 'X_Y' }, transitionAudit),
      ).toThrow(TenantIdRequiredError);
      expect(() =>
        queue.cancelQueued('', 'job-1', transitionAudit),
      ).toThrow(TenantIdRequiredError);
      expect(() =>
        queue.publishPendingLink('', 'job-1', transitionAudit),
      ).toThrow(TenantIdRequiredError);
    });

    it('scopes every enqueue reference check to the tenant', async () => {
      await queue.enqueue(
        'tenant-a',
        { ...baseEnqueue, deviceId: 'dev-1', sessionId: 'sess-1' },
        enqueueAudit,
      );
      for (const table of [
        tx.location,
        tx.retailUnit,
        tx.device,
        tx.checkoutSession,
      ]) {
        expect(table.findFirst).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({ tenantId: 'tenant-a' }),
          }),
        );
      }
    });
  });

  describe('enqueue', () => {
    it('creates a QUEUED job scoped to the tenant and audits the creation', async () => {
      const result = await queue.enqueue('tenant-a', baseEnqueue, enqueueAudit);
      expect(result).toEqual(expect.objectContaining({ replayed: false }));
      const createArgs = tx.inferenceJob.create.mock.calls[0][0] as {
        data: { tenantId: string; jobType: InferenceJobType; priority: number };
      };
      expect(createArgs.data.tenantId).toBe('tenant-a');
      expect(createArgs.data.priority).toBe(100);
      expect(auditLog.record).toHaveBeenCalledWith(
        expect.objectContaining({ entityType: 'InferenceJob' }),
        tx,
      );
    });

    it('writes NO status for a normal enqueue — the QUEUED column default stands (Phase 9 unchanged)', async () => {
      await queue.enqueue(
        'tenant-a',
        { ...baseEnqueue, pendingLink: false },
        enqueueAudit,
      );
      const createArgs = tx.inferenceJob.create.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(createArgs.data).not.toHaveProperty('status');
    });

    it('creates a NON-CLAIMABLE PENDING_LINK job for two-phase creation', async () => {
      const result = await queue.enqueue(
        'tenant-a',
        { ...baseEnqueue, pendingLink: true },
        enqueueAudit,
      );
      const createArgs = tx.inferenceJob.create.mock.calls[0][0] as {
        data: { status: InferenceJobStatus };
      };
      expect(createArgs.data.status).toBe(InferenceJobStatus.PENDING_LINK);
      expect(result).toEqual(expect.objectContaining({ replayed: false }));
      // Creation is still audited: the row exists and must be traceable
      // even if the caller crashes before publishing it.
      expect(auditLog.record).toHaveBeenCalledTimes(1);
    });

    it('replays an existing PENDING_LINK job for the same idempotency key without writing', async () => {
      // Crash-window recovery: the retry finds the unpublished job under
      // the deterministic key instead of minting a second one.
      tx.inferenceJob.findFirst.mockResolvedValue(pendingLinkJob);
      await expect(
        queue.enqueue(
          'tenant-a',
          { ...baseEnqueue, idempotencyKey: 'video-crop:art-1', pendingLink: true },
          enqueueAudit,
        ),
      ).resolves.toEqual({ job: pendingLinkJob, replayed: true });
      expect(tx.inferenceJob.create).not.toHaveBeenCalled();
      expect(auditLog.record).not.toHaveBeenCalled();
    });

    it('replays an existing job for the same idempotency key without writing', async () => {
      tx.inferenceJob.findFirst.mockResolvedValue(queuedJob);
      await expect(
        queue.enqueue(
          'tenant-a',
          { ...baseEnqueue, idempotencyKey: 'key-1' },
          enqueueAudit,
        ),
      ).resolves.toEqual({ job: queuedJob, replayed: true });
      expect(tx.inferenceJob.create).not.toHaveBeenCalled();
      expect(auditLog.record).not.toHaveBeenCalled();
    });

    it.each([
      ['location-not-found', () => tx.location.findFirst.mockResolvedValue(null)],
      ['unit-not-found', () => tx.retailUnit.findFirst.mockResolvedValue(null)],
      [
        'unit-location-mismatch',
        () =>
          tx.retailUnit.findFirst.mockResolvedValue({
            id: 'unit-a1',
            locationId: 'loc-OTHER',
          }),
      ],
    ])('rejects with %s before any write', async (rejection, arrange) => {
      arrange();
      await expect(
        queue.enqueue('tenant-a', baseEnqueue, enqueueAudit),
      ).resolves.toBe(rejection);
      expect(tx.inferenceJob.create).not.toHaveBeenCalled();
      expect(auditLog.record).not.toHaveBeenCalled();
    });

    it('rejects a session bound to a different unit', async () => {
      tx.checkoutSession.findFirst.mockResolvedValue({
        id: 'sess-1',
        unitId: 'unit-OTHER',
        locationId: 'loc-a1',
      });
      await expect(
        queue.enqueue(
          'tenant-a',
          { ...baseEnqueue, sessionId: 'sess-1' },
          enqueueAudit,
        ),
      ).resolves.toBe('session-unit-mismatch');
    });

    it('rejects a session at a different store (reassigned unit) before any write', async () => {
      // The unit moved stores after the session opened: same unit id, but
      // the session kept its original store. Without this check the job
      // would SUCCEED and then be permanently unconvertible (Phase 7
      // rejects session-location-mismatch at ingest).
      tx.checkoutSession.findFirst.mockResolvedValue({
        id: 'sess-1',
        unitId: 'unit-a1',
        locationId: 'loc-OLD',
      });
      await expect(
        queue.enqueue(
          'tenant-a',
          { ...baseEnqueue, sessionId: 'sess-1' },
          enqueueAudit,
        ),
      ).resolves.toBe('session-location-mismatch');
      expect(tx.inferenceJob.create).not.toHaveBeenCalled();
      expect(auditLog.record).not.toHaveBeenCalled();
    });

    it("falls back to the unit's store when the job has no explicit store", async () => {
      tx.checkoutSession.findFirst.mockResolvedValue({
        id: 'sess-1',
        unitId: 'unit-a1',
        locationId: 'loc-OLD',
      });
      await expect(
        queue.enqueue(
          'tenant-a',
          {
            jobType: InferenceJobType.PRODUCT_RECOGNITION,
            priority: 100,
            unitId: 'unit-a1',
            sessionId: 'sess-1',
          },
          enqueueAudit,
        ),
      ).resolves.toBe('session-location-mismatch');
    });

    it('validates the creator under the scoped tenant inside the transaction', async () => {
      await queue.enqueue(
        'tenant-a',
        { ...baseEnqueue, createdById: 'user-1' },
        enqueueAudit,
      );
      expect(tx.user.findFirst).toHaveBeenCalledWith({
        where: { id: 'user-1', tenantId: 'tenant-a' },
        select: { id: true },
      });
    });

    it('rejects a creator from another tenant before any write', async () => {
      // The scoped lookup misses: the id exists only under another tenant.
      tx.user.findFirst.mockResolvedValue(null);
      await expect(
        queue.enqueue(
          'tenant-a',
          { ...baseEnqueue, createdById: 'user-of-tenant-b' },
          enqueueAudit,
        ),
      ).resolves.toBe('creator-not-found');
      expect(tx.inferenceJob.create).not.toHaveBeenCalled();
      expect(auditLog.record).not.toHaveBeenCalled();
    });

    it('skips the creator lookup for system flows (no createdById)', async () => {
      await queue.enqueue('tenant-a', baseEnqueue, enqueueAudit);
      expect(tx.user.findFirst).not.toHaveBeenCalled();
    });

    it('takes the unit advisory lock BEFORE the unit read and holds it through the insert', async () => {
      // Serializes with UnitsRepository.update()/delete() (same key): a
      // unit moved to another store must not slip between the validation
      // read and the job row.
      await queue.enqueue('tenant-a', baseEnqueue, enqueueAudit);
      expect(tx.$queryRaw.mock.calls[0][1]).toBe('retail-unit:tenant-a:unit-a1');
      expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        tx.retailUnit.findFirst.mock.invocationCallOrder[0],
      );
      expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        tx.inferenceJob.create.mock.invocationCallOrder[0],
      );
    });

    it('takes the device advisory lock BEFORE the device read — unit lock first (deadlock-safe order)', async () => {
      await queue.enqueue(
        'tenant-a',
        { ...baseEnqueue, deviceId: 'dev-1' },
        enqueueAudit,
      );
      expect(tx.$queryRaw.mock.calls.map((call) => call[1] as string)).toEqual([
        'retail-unit:tenant-a:unit-a1',
        'device:tenant-a:dev-1',
      ]);
      expect(tx.$queryRaw.mock.invocationCallOrder[1]).toBeLessThan(
        tx.device.findFirst.mock.invocationCallOrder[0],
      );
    });

    it('takes no advisory locks when the job binds neither unit nor device', async () => {
      await queue.enqueue(
        'tenant-a',
        { jobType: InferenceJobType.PRODUCT_RECOGNITION, priority: 100 },
        enqueueAudit,
      );
      expect(tx.$queryRaw).not.toHaveBeenCalled();
    });
  });

  describe('markRunning', () => {
    beforeEach(() => {
      tx.inferenceJob.findFirst.mockResolvedValue(queuedJob);
    });

    it('flips QUEUED → RUNNING with a tenant-scoped compare-and-set and audits it', async () => {
      const result = await queue.markRunning(
        'tenant-a',
        'job-1',
        'simulated',
        transitionAudit,
      );
      expect(tx.inferenceJob.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'job-1',
          tenantId: 'tenant-a',
          status: InferenceJobStatus.QUEUED,
        },
        data: expect.objectContaining({
          status: InferenceJobStatus.RUNNING,
          startedAt: expect.any(Date),
          adapterKey: 'simulated',
          attempts: { increment: 1 },
          leaseExpiresAt: expect.any(Date),
        }),
      });
      expect(result).toBe(runningJob);
      expect(auditLog.record).toHaveBeenCalledTimes(1);
    });

    it('takes a lease in the future when claiming', async () => {
      await queue.markRunning('tenant-a', 'job-1', 'simulated', transitionAudit);
      const { data } = tx.inferenceJob.updateMany.mock.calls[0][0] as {
        data: { leaseExpiresAt: Date };
      };
      expect(data.leaseExpiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('returns null when the job is missing in this tenant', async () => {
      tx.inferenceJob.findFirst.mockResolvedValue(null);
      await expect(
        queue.markRunning('tenant-a', 'missing', 'simulated', transitionAudit),
      ).resolves.toBeNull();
    });

    it('rejects an already-RUNNING job as not-claimable', async () => {
      tx.inferenceJob.findFirst.mockResolvedValue(runningJob);
      await expect(
        queue.markRunning('tenant-a', 'job-1', 'simulated', transitionAudit),
      ).resolves.toBe('not-claimable');
      expect(tx.inferenceJob.updateMany).not.toHaveBeenCalled();
    });

    it.each([
      InferenceJobStatus.SUCCEEDED,
      InferenceJobStatus.FAILED,
      InferenceJobStatus.CANCELLED,
    ])('rejects a terminal %s job', async (status) => {
      tx.inferenceJob.findFirst.mockResolvedValue({ ...queuedJob, status });
      await expect(
        queue.markRunning('tenant-a', 'job-1', 'simulated', transitionAudit),
      ).resolves.toBe('terminal');
      expect(tx.inferenceJob.updateMany).not.toHaveBeenCalled();
    });

    it('rejects a PENDING_LINK job as not-claimable (non-terminal) without writing', async () => {
      tx.inferenceJob.findFirst.mockResolvedValue(pendingLinkJob);
      await expect(
        queue.markRunning('tenant-a', 'job-1', 'simulated', transitionAudit),
      ).resolves.toBe('not-claimable');
      expect(tx.inferenceJob.updateMany).not.toHaveBeenCalled();
      expect(auditLog.record).not.toHaveBeenCalled();
    });

    it('loses a claim race as not-claimable without auditing', async () => {
      tx.inferenceJob.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        queue.markRunning('tenant-a', 'job-1', 'simulated', transitionAudit),
      ).resolves.toBe('not-claimable');
      expect(auditLog.record).not.toHaveBeenCalled();
    });
  });

  describe('claimNext', () => {
    it('picks by priority DESC, then requestedAt ASC, then id ASC', async () => {
      prismaFindFirst.mockResolvedValueOnce({ id: 'job-1' });
      tx.inferenceJob.findFirst.mockResolvedValue(queuedJob);
      const claimed = await queue.claimNext(
        'tenant-a',
        'simulated',
        transitionAudit,
      );
      expect(prismaFindFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            tenantId: 'tenant-a',
            status: InferenceJobStatus.QUEUED,
          }),
          orderBy: QUEUE_CLAIM_ORDER,
        }),
      );
      expect(QUEUE_CLAIM_ORDER).toEqual([
        { priority: 'desc' },
        { requestedAt: 'asc' },
        { id: 'asc' },
      ]);
      expect(claimed).toBe(runningJob);
    });

    it('NEVER hands a PENDING_LINK job to a worker (the claim query pins QUEUED)', async () => {
      // Simulates the table: only rows matching the claim predicate come
      // back. The PENDING_LINK row sorts first on every ordering key, so a
      // claim that did not pin the status would pick it up.
      const rows = [
        { id: 'job-pending', status: InferenceJobStatus.PENDING_LINK },
        { id: 'job-queued', status: InferenceJobStatus.QUEUED },
      ];
      prismaFindFirst.mockImplementation(
        ({ where }: { where: { status: InferenceJobStatus } }) =>
          Promise.resolve(
            rows.find((row) => row.status === where.status) ?? null,
          ),
      );
      tx.inferenceJob.findFirst.mockResolvedValue(queuedJob);
      const claimed = await queue.claimNext(
        'tenant-a',
        'simulated',
        transitionAudit,
      );
      expect(claimed).toBe(runningJob);
      const { where } = prismaFindFirst.mock.calls[0][0] as {
        where: { status: InferenceJobStatus };
      };
      expect(where.status).toBe(InferenceJobStatus.QUEUED);
      // The claimed id is the QUEUED row's — the unpublished job was never
      // even a candidate.
      expect(tx.inferenceJob.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 'job-queued',
            status: InferenceJobStatus.QUEUED,
          }),
        }),
      );
    });

    it('returns null when only PENDING_LINK work exists in the tenant', async () => {
      prismaFindFirst.mockImplementation(
        ({ where }: { where: { status: InferenceJobStatus } }) =>
          Promise.resolve(
            where.status === InferenceJobStatus.QUEUED ? null : { id: 'job-1' },
          ),
      );
      await expect(
        queue.claimNext('tenant-a', 'simulated', transitionAudit),
      ).resolves.toBeNull();
      expect(tx.inferenceJob.updateMany).not.toHaveBeenCalled();
    });

    it('returns null when the tenant queue is empty', async () => {
      await expect(
        queue.claimNext('tenant-a', 'simulated', transitionAudit),
      ).resolves.toBeNull();
    });

    it('moves on to the next job after losing a claim race', async () => {
      prismaFindFirst
        .mockResolvedValueOnce({ id: 'job-raced' })
        .mockResolvedValueOnce({ id: 'job-2' });
      tx.inferenceJob.findFirst.mockResolvedValue(queuedJob);
      tx.inferenceJob.updateMany
        .mockResolvedValueOnce({ count: 0 })
        .mockResolvedValueOnce({ count: 1 });
      const claimed = await queue.claimNext(
        'tenant-a',
        'simulated',
        transitionAudit,
      );
      expect(claimed).toBe(runningJob);
      expect(prismaFindFirst).toHaveBeenCalledTimes(2);
    });
  });

  describe('reclaimExpired', () => {
    const expiredJob = {
      ...runningJob,
      attempts: 1,
      leaseExpiresAt: new Date(Date.now() - 60_000),
    } as InferenceJobDetail;

    beforeEach(() => {
      prismaFindMany.mockResolvedValue([{ id: 'job-1' }]);
      tx.inferenceJob.findFirst.mockResolvedValue(expiredJob);
    });

    it('selects only RUNNING jobs with an expired lease, tenant-scoped', async () => {
      await queue.reclaimExpired('tenant-a');
      expect(prismaFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            tenantId: 'tenant-a',
            status: InferenceJobStatus.RUNNING,
            leaseExpiresAt: { lt: expect.any(Date) },
          }),
        }),
      );
    });

    it('requeues an expired job that still has attempts, audited as SYSTEM', async () => {
      const reclaimed = await queue.reclaimExpired('tenant-a');
      expect(tx.inferenceJob.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            status: InferenceJobStatus.QUEUED,
            startedAt: null,
            leaseExpiresAt: null,
            adapterKey: null,
          },
        }),
      );
      expect(auditLog.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actorEmail: SYSTEM_ACTOR_EMAIL,
          action: 'UPDATE',
          entityType: 'InferenceJob',
          entityId: 'job-1',
        }),
        tx,
      );
      expect(reclaimed).toHaveLength(1);
    });

    it('is claimable again after a requeue', async () => {
      // After the reclaim requeues job-1, the claim pass finds and wins it.
      prismaFindFirst.mockResolvedValueOnce({ id: 'job-1' });
      tx.inferenceJob.findFirst
        .mockResolvedValueOnce(expiredJob)
        .mockResolvedValueOnce(queuedJob);
      const claimed = await queue.claimNext(
        'tenant-a',
        'simulated',
        transitionAudit,
      );
      expect(claimed).toBe(runningJob);
    });

    it('fails a job that exhausted its attempts with LEASE_EXPIRED', async () => {
      tx.inferenceJob.findFirst.mockResolvedValue({
        ...expiredJob,
        attempts: INFERENCE_JOB_MAX_ATTEMPTS,
      });
      await queue.reclaimExpired('tenant-a');
      expect(tx.inferenceJob.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: InferenceJobStatus.FAILED,
            completedAt: expect.any(Date),
            leaseExpiresAt: null,
            errorCode: LEASE_EXPIRED_ERROR_CODE,
          }),
        }),
      );
      expect(auditLog.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actorEmail: SYSTEM_ACTOR_EMAIL,
          action: 'FAIL',
          reason: expect.stringContaining(LEASE_EXPIRED_ERROR_CODE),
        }),
        tx,
      );
    });

    it('does not touch RUNNING jobs whose lease is still live', async () => {
      prismaFindMany.mockResolvedValue([]);
      await expect(queue.reclaimExpired('tenant-a')).resolves.toEqual([]);
      expect(tx.inferenceJob.updateMany).not.toHaveBeenCalled();
      expect(auditLog.record).not.toHaveBeenCalled();
    });

    it('skips a job a live worker finished between listing and reclaiming', async () => {
      tx.inferenceJob.findFirst.mockResolvedValue(null);
      await expect(queue.reclaimExpired('tenant-a')).resolves.toEqual([]);
      expect(tx.inferenceJob.updateMany).not.toHaveBeenCalled();
    });

    it('never sweeps a PENDING_LINK job — RUNNING with an expired lease only', async () => {
      // An unpublished job carries no lease and no worker, so the crashed-
      // worker sweep must not touch it (and can never publish it by
      // accident through the requeue branch).
      const rows = [
        {
          id: 'job-pending',
          status: InferenceJobStatus.PENDING_LINK,
          leaseExpiresAt: null,
        },
      ];
      prismaFindMany.mockImplementation(
        ({ where }: { where: { status: InferenceJobStatus } }) =>
          Promise.resolve(
            rows
              .filter((row) => row.status === where.status)
              .map(({ id }) => ({ id })),
          ),
      );
      await expect(queue.reclaimExpired('tenant-a')).resolves.toEqual([]);
      expect(tx.inferenceJob.updateMany).not.toHaveBeenCalled();
      expect(auditLog.record).not.toHaveBeenCalled();
    });

    it('re-pins RUNNING inside the reclaim transaction as well', async () => {
      await queue.reclaimExpired('tenant-a');
      expect(tx.inferenceJob.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: InferenceJobStatus.RUNNING,
            leaseExpiresAt: { lt: expect.any(Date) },
          }),
        }),
      );
    });

    it('rejects a blank tenantId instead of widening the query', async () => {
      await expect(queue.reclaimExpired('')).rejects.toThrow(
        TenantIdRequiredError,
      );
    });
  });

  describe('publishPendingLink', () => {
    beforeEach(() => {
      tx.inferenceJob.findFirst.mockResolvedValue(pendingLinkJob);
      tx.inferenceJob.findFirstOrThrow.mockResolvedValue(queuedJob);
    });

    it('flips PENDING_LINK → QUEUED with a tenant-scoped compare-and-set and audits it in the SAME transaction', async () => {
      const result = await queue.publishPendingLink(
        'tenant-a',
        'job-1',
        transitionAudit,
      );
      expect(tx.inferenceJob.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'job-1',
          tenantId: 'tenant-a',
          status: InferenceJobStatus.PENDING_LINK,
        },
        // Publication moves NO timestamps, takes no lease, and does not
        // touch attempts: claiming is still markRunning's job.
        data: { status: InferenceJobStatus.QUEUED },
      });
      expect(result).toBe(queuedJob);
      expect(auditLog.record).toHaveBeenCalledWith(
        expect.objectContaining({ entityType: 'InferenceJob' }),
        tx,
      );
    });

    it('returns null when the job is missing in this tenant', async () => {
      tx.inferenceJob.findFirst.mockResolvedValue(null);
      await expect(
        queue.publishPendingLink('tenant-a', 'missing', transitionAudit),
      ).resolves.toBeNull();
      expect(tx.inferenceJob.updateMany).not.toHaveBeenCalled();
      expect(auditLog.record).not.toHaveBeenCalled();
    });

    it.each([
      InferenceJobStatus.QUEUED,
      InferenceJobStatus.RUNNING,
      InferenceJobStatus.SUCCEEDED,
      InferenceJobStatus.FAILED,
      InferenceJobStatus.CANCELLED,
    ])(
      "returns 'not-pending' for a %s job without writing or auditing",
      async (status) => {
        tx.inferenceJob.findFirst.mockResolvedValue({
          ...pendingLinkJob,
          status,
        });
        await expect(
          queue.publishPendingLink('tenant-a', 'job-1', transitionAudit),
        ).resolves.toBe('not-pending');
        expect(tx.inferenceJob.updateMany).not.toHaveBeenCalled();
        expect(auditLog.record).not.toHaveBeenCalled();
      },
    );

    it("loses the CAS to a concurrent cancellation as 'not-pending' without auditing", async () => {
      tx.inferenceJob.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        queue.publishPendingLink('tenant-a', 'job-1', transitionAudit),
      ).resolves.toBe('not-pending');
      expect(auditLog.record).not.toHaveBeenCalled();
    });
  });

  describe('complete', () => {
    beforeEach(() => {
      tx.inferenceJob.findFirst.mockResolvedValue(runningJob);
    });

    it('persists the result and candidates atomically with the status flip', async () => {
      await queue.complete(
        'tenant-a',
        'job-1',
        1,
        normalizedResult,
        transitionAudit,
      );
      expect(tx.inferenceJob.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'job-1',
          tenantId: 'tenant-a',
          status: InferenceJobStatus.RUNNING,
          attempts: 1,
        },
        data: expect.objectContaining({
          status: InferenceJobStatus.SUCCEEDED,
          completedAt: expect.any(Date),
          leaseExpiresAt: null,
        }),
      });
      expect(tx.inferenceResult.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          tenantId: 'tenant-a',
          jobId: 'job-1',
          eventType: 'PRODUCT_PICKUP',
          quantityDelta: 2,
          occurredAt: new Date('2026-07-26T10:00:30.000Z'),
          evidenceScore: 0.92,
          candidates: {
            create: [
              expect.objectContaining({
                tenantId: 'tenant-a',
                rank: 1,
                sku: 'COLA-330',
                score: 0.92,
              }),
              expect.objectContaining({ rank: 2, sku: 'CHIPS-50' }),
            ],
          },
        }),
      });
      expect(auditLog.record).toHaveBeenCalledTimes(1);
    });

    it('rejects a QUEUED job as not-running without writing a result', async () => {
      tx.inferenceJob.findFirst.mockResolvedValue(queuedJob);
      await expect(
        queue.complete(
          'tenant-a',
          'job-1',
          0,
          normalizedResult,
          transitionAudit,
        ),
      ).resolves.toBe('not-running');
      expect(tx.inferenceResult.create).not.toHaveBeenCalled();
    });

    it.each([
      InferenceJobStatus.SUCCEEDED,
      InferenceJobStatus.FAILED,
      InferenceJobStatus.CANCELLED,
    ])('rejects a terminal %s job', async (status) => {
      tx.inferenceJob.findFirst.mockResolvedValue({ ...runningJob, status });
      await expect(
        queue.complete(
          'tenant-a',
          'job-1',
          1,
          normalizedResult,
          transitionAudit,
        ),
      ).resolves.toBe('terminal');
      expect(tx.inferenceJob.updateMany).not.toHaveBeenCalled();
      expect(tx.inferenceResult.create).not.toHaveBeenCalled();
    });

    it('loses a completion race as terminal without writing a result', async () => {
      tx.inferenceJob.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        queue.complete(
          'tenant-a',
          'job-1',
          1,
          normalizedResult,
          transitionAudit,
        ),
      ).resolves.toBe('terminal');
      expect(tx.inferenceResult.create).not.toHaveBeenCalled();
      expect(auditLog.record).not.toHaveBeenCalled();
    });

    it('fences a stale attempt as lease-superseded without touching the job', async () => {
      // Attempt A (expectedAttempts 1) went stale: the lease expired, the
      // job was reclaimed, and attempt B re-claimed it (attempts now 2). A
      // late A must not commit its result under B's lease.
      tx.inferenceJob.findFirst.mockResolvedValue({
        ...runningJob,
        attempts: 2,
      });
      await expect(
        queue.complete(
          'tenant-a',
          'job-1',
          1,
          normalizedResult,
          transitionAudit,
        ),
      ).resolves.toBe('lease-superseded');
      expect(tx.inferenceJob.updateMany).not.toHaveBeenCalled();
      expect(tx.inferenceResult.create).not.toHaveBeenCalled();
      expect(auditLog.record).not.toHaveBeenCalled();
    });
  });

  describe('fail', () => {
    it('fails a QUEUED job (no adapter required) with code and message', async () => {
      tx.inferenceJob.findFirst.mockResolvedValue(queuedJob);
      await queue.fail(
        'tenant-a',
        'job-1',
        0,
        { errorCode: 'NO_ADAPTER', errorMessage: 'nothing can run this' },
        transitionAudit,
      );
      expect(tx.inferenceJob.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'job-1',
          tenantId: 'tenant-a',
          status: {
            in: [InferenceJobStatus.QUEUED, InferenceJobStatus.RUNNING],
          },
          attempts: 0,
        },
        data: expect.objectContaining({
          status: InferenceJobStatus.FAILED,
          completedAt: expect.any(Date),
          leaseExpiresAt: null,
          errorCode: 'NO_ADAPTER',
          errorMessage: 'nothing can run this',
        }),
      });
      expect(auditLog.record).toHaveBeenCalledTimes(1);
    });

    it('fails a RUNNING job', async () => {
      tx.inferenceJob.findFirst.mockResolvedValue(runningJob);
      await queue.fail(
        'tenant-a',
        'job-1',
        1,
        { errorCode: 'ADAPTER_TIMEOUT' },
        transitionAudit,
      );
      expect(tx.inferenceJob.updateMany).toHaveBeenCalled();
    });

    it.each([
      InferenceJobStatus.SUCCEEDED,
      InferenceJobStatus.FAILED,
      InferenceJobStatus.CANCELLED,
    ])('rejects a terminal %s job', async (status) => {
      tx.inferenceJob.findFirst.mockResolvedValue({ ...queuedJob, status });
      await expect(
        queue.fail(
          'tenant-a',
          'job-1',
          0,
          { errorCode: 'X_Y' },
          transitionAudit,
        ),
      ).resolves.toBe('terminal');
      expect(tx.inferenceJob.updateMany).not.toHaveBeenCalled();
    });

    it('fences a stale attempt as lease-superseded without failing the new attempt', async () => {
      tx.inferenceJob.findFirst.mockResolvedValue({
        ...runningJob,
        attempts: 2,
      });
      await expect(
        queue.fail(
          'tenant-a',
          'job-1',
          1,
          { errorCode: 'ADAPTER_TIMEOUT' },
          transitionAudit,
        ),
      ).resolves.toBe('lease-superseded');
      expect(tx.inferenceJob.updateMany).not.toHaveBeenCalled();
      expect(auditLog.record).not.toHaveBeenCalled();
    });
  });

  describe('cancelQueued', () => {
    it('cancels with a tenant-scoped QUEUED-only compare-and-set and audits it', async () => {
      tx.inferenceJob.findFirst.mockResolvedValue(queuedJob);
      tx.inferenceJob.findFirstOrThrow.mockResolvedValue({
        ...queuedJob,
        status: InferenceJobStatus.CANCELLED,
      });
      const result = await queue.cancelQueued(
        'tenant-a',
        'job-1',
        transitionAudit,
      );
      expect(tx.inferenceJob.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'job-1',
          tenantId: 'tenant-a',
          // The CAS pins the whole cancellable set: unclaimed work is
          // cancellable whether or not it has been published yet.
          status: {
            in: [InferenceJobStatus.PENDING_LINK, InferenceJobStatus.QUEUED],
          },
        },
        // CANCELLED is terminal: completedAt is stamped with the flip (DB
        // CHECK) and errorCode stays untouched (errors exist only on
        // FAILED).
        data: expect.objectContaining({
          status: InferenceJobStatus.CANCELLED,
          completedAt: expect.any(Date),
        }),
      });
      expect(result).toEqual(
        expect.objectContaining({ status: InferenceJobStatus.CANCELLED }),
      );
      expect(auditLog.record).toHaveBeenCalledWith(
        expect.objectContaining({ entityType: 'InferenceJob' }),
        tx,
      );
    });

    it('cancels a PENDING_LINK job exactly like a QUEUED one (crash-window cleanup)', async () => {
      // The DELETE flow found the job by its idempotency key: its artifact
      // link never committed, so nothing else can ever retire it.
      tx.inferenceJob.findFirst.mockResolvedValue(pendingLinkJob);
      tx.inferenceJob.findFirstOrThrow.mockResolvedValue({
        ...pendingLinkJob,
        status: InferenceJobStatus.CANCELLED,
      });
      await expect(
        queue.cancelQueued('tenant-a', 'job-1', transitionAudit),
      ).resolves.toEqual(
        expect.objectContaining({ status: InferenceJobStatus.CANCELLED }),
      );
      expect(tx.inferenceJob.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: InferenceJobStatus.CANCELLED,
            completedAt: expect.any(Date),
          }),
        }),
      );
      expect(auditLog.record).toHaveBeenCalledTimes(1);
    });

    it('returns null when the job is missing in this tenant', async () => {
      tx.inferenceJob.findFirst.mockResolvedValue(null);
      await expect(
        queue.cancelQueued('tenant-a', 'missing', transitionAudit),
      ).resolves.toBeNull();
      expect(tx.inferenceJob.updateMany).not.toHaveBeenCalled();
    });

    it("returns 'not-queued' for a claimed or finished job without writing", async () => {
      tx.inferenceJob.findFirst.mockResolvedValue(runningJob);
      await expect(
        queue.cancelQueued('tenant-a', 'job-1', transitionAudit),
      ).resolves.toBe('not-queued');
      expect(tx.inferenceJob.updateMany).not.toHaveBeenCalled();
      expect(auditLog.record).not.toHaveBeenCalled();
    });

    it("loses the CAS to a concurrent claim as 'not-queued' without auditing", async () => {
      tx.inferenceJob.findFirst.mockResolvedValue(queuedJob);
      tx.inferenceJob.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        queue.cancelQueued('tenant-a', 'job-1', transitionAudit),
      ).resolves.toBe('not-queued');
      expect(auditLog.record).not.toHaveBeenCalled();
    });
  });
});
