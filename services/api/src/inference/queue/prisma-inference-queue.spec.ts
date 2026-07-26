import { InferenceJobStatus, InferenceJobType } from '@prisma/client';
import { AuditEntry } from '../../common/audit/audit-log.service';
import { TenantIdRequiredError } from '../../common/errors/domain.errors';
import { PrismaService } from '../../prisma/prisma.service';
import { NormalizedInferenceResult } from '../adapters/inference-adapter';
import { InferenceJobDetail } from '../inference-jobs.repository';
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
  } as unknown as InferenceJobDetail;

  const runningJob = {
    ...queuedJob,
    status: InferenceJobStatus.RUNNING,
    adapterKey: 'simulated',
  } as InferenceJobDetail;

  const normalizedResult: NormalizedInferenceResult = {
    eventType: 'PRODUCT_PICKUP',
    quantityDelta: 2,
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
  };
  let auditLog: { record: jest.Mock };
  let prismaFindFirst: jest.Mock;
  let queue: PrismaInferenceQueue;

  beforeEach(() => {
    tx = {
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
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'sess-1', unitId: 'unit-a1' }),
      },
    };
    auditLog = { record: jest.fn().mockResolvedValue(undefined) };
    prismaFindFirst = jest.fn().mockResolvedValue(null);
    const prisma = {
      $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
      inferenceJob: { findFirst: prismaFindFirst },
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
        queue.complete('', 'job-1', normalizedResult, transitionAudit),
      ).toThrow(TenantIdRequiredError);
      expect(() =>
        queue.fail('', 'job-1', { errorCode: 'X_Y' }, transitionAudit),
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
      });
      await expect(
        queue.enqueue(
          'tenant-a',
          { ...baseEnqueue, sessionId: 'sess-1' },
          enqueueAudit,
        ),
      ).resolves.toBe('session-unit-mismatch');
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
        }),
      });
      expect(result).toBe(runningJob);
      expect(auditLog.record).toHaveBeenCalledTimes(1);
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

  describe('complete', () => {
    beforeEach(() => {
      tx.inferenceJob.findFirst.mockResolvedValue(runningJob);
    });

    it('persists the result and candidates atomically with the status flip', async () => {
      await queue.complete(
        'tenant-a',
        'job-1',
        normalizedResult,
        transitionAudit,
      );
      expect(tx.inferenceJob.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'job-1',
          tenantId: 'tenant-a',
          status: InferenceJobStatus.RUNNING,
        },
        data: expect.objectContaining({
          status: InferenceJobStatus.SUCCEEDED,
          completedAt: expect.any(Date),
        }),
      });
      expect(tx.inferenceResult.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          tenantId: 'tenant-a',
          jobId: 'job-1',
          eventType: 'PRODUCT_PICKUP',
          quantityDelta: 2,
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
        queue.complete('tenant-a', 'job-1', normalizedResult, transitionAudit),
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
        queue.complete('tenant-a', 'job-1', normalizedResult, transitionAudit),
      ).resolves.toBe('terminal');
      expect(tx.inferenceJob.updateMany).not.toHaveBeenCalled();
      expect(tx.inferenceResult.create).not.toHaveBeenCalled();
    });

    it('loses a completion race as terminal without writing a result', async () => {
      tx.inferenceJob.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        queue.complete('tenant-a', 'job-1', normalizedResult, transitionAudit),
      ).resolves.toBe('terminal');
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
        },
        data: expect.objectContaining({
          status: InferenceJobStatus.FAILED,
          completedAt: expect.any(Date),
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
          { errorCode: 'X_Y' },
          transitionAudit,
        ),
      ).resolves.toBe('terminal');
      expect(tx.inferenceJob.updateMany).not.toHaveBeenCalled();
    });
  });
});
