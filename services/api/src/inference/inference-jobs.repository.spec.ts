import { InferenceJobStatus } from '@prisma/client';
import { AuditEntry } from '../common/audit/audit-log.service';
import { TenantIdRequiredError } from '../common/errors/domain.errors';
import { PrismaService } from '../prisma/prisma.service';
import {
  InferenceJobDetail,
  InferenceJobsRepository,
} from './inference-jobs.repository';

describe('InferenceJobsRepository', () => {
  const linkAudit = (): AuditEntry => ({
    tenantId: 'tenant-a',
    actorEmail: 'jane@tenant-a.example',
    action: 'UPDATE',
    entityType: 'InferenceJob',
  });

  const succeededJob = {
    id: 'job-1',
    tenantId: 'tenant-a',
    status: InferenceJobStatus.SUCCEEDED,
    visionEventId: null,
  } as unknown as InferenceJobDetail;

  let tx: {
    inferenceJob: {
      findFirst: jest.Mock;
      updateMany: jest.Mock;
      findFirstOrThrow: jest.Mock;
    };
  };
  let prismaModel: {
    findFirst: jest.Mock;
    findMany: jest.Mock;
    count: jest.Mock;
  };
  let auditLog: { record: jest.Mock };
  let repository: InferenceJobsRepository;

  beforeEach(() => {
    tx = {
      inferenceJob: {
        findFirst: jest.fn().mockResolvedValue(succeededJob),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findFirstOrThrow: jest
          .fn()
          .mockResolvedValue({ ...succeededJob, visionEventId: 'event-1' }),
      },
    };
    prismaModel = {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    };
    auditLog = { record: jest.fn().mockResolvedValue(undefined) };
    const prisma = {
      $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
      inferenceJob: prismaModel,
    } as unknown as PrismaService;
    repository = new InferenceJobsRepository(prisma, auditLog as never);
  });

  describe('tenant isolation', () => {
    it('throws on a blank tenantId instead of widening the query', async () => {
      expect(() => repository.findById('', 'job-1')).toThrow(
        TenantIdRequiredError,
      );
      await expect(repository.search('  ', {})).rejects.toThrow(
        TenantIdRequiredError,
      );
      expect(() =>
        repository.linkVisionEvent('', 'job-1', 'event-1', linkAudit),
      ).toThrow(TenantIdRequiredError);
    });

    it('scopes reads to the tenant so another tenant’s job is invisible', async () => {
      await repository.findById('tenant-a', 'job-b');
      expect(prismaModel.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            tenantId: 'tenant-a',
            id: 'job-b',
          }),
        }),
      );
    });
  });

  describe('search', () => {
    it('orders deterministically (requestedAt DESC, id DESC) with scoped filters', async () => {
      await repository.search('tenant-a', {
        status: InferenceJobStatus.QUEUED,
        sessionId: 'sess-1',
        skip: 10,
        take: 5,
      });
      expect(prismaModel.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            tenantId: 'tenant-a',
            status: InferenceJobStatus.QUEUED,
            sessionId: 'sess-1',
          }),
          orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
          skip: 10,
          take: 5,
        }),
      );
      expect(prismaModel.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ tenantId: 'tenant-a' }),
        }),
      );
    });
  });

  describe('linkVisionEvent', () => {
    it('stamps the link with a tenant-scoped compare-and-set and audits it', async () => {
      const result = await repository.linkVisionEvent(
        'tenant-a',
        'job-1',
        'event-1',
        linkAudit,
      );
      expect(tx.inferenceJob.updateMany).toHaveBeenCalledWith({
        where: { id: 'job-1', tenantId: 'tenant-a', visionEventId: null },
        data: { visionEventId: 'event-1' },
      });
      expect(result).toEqual(
        expect.objectContaining({ visionEventId: 'event-1' }),
      );
      expect(auditLog.record).toHaveBeenCalledWith(
        expect.objectContaining({ entityType: 'InferenceJob' }),
        tx,
      );
    });

    it('returns null when the job is missing in this tenant', async () => {
      tx.inferenceJob.findFirst.mockResolvedValue(null);
      await expect(
        repository.linkVisionEvent('tenant-a', 'missing', 'event-1', linkAudit),
      ).resolves.toBeNull();
    });

    it('rejects an already-linked job without writing', async () => {
      tx.inferenceJob.findFirst.mockResolvedValue({
        ...succeededJob,
        visionEventId: 'event-0',
      });
      await expect(
        repository.linkVisionEvent('tenant-a', 'job-1', 'event-1', linkAudit),
      ).resolves.toBe('already-linked');
      expect(tx.inferenceJob.updateMany).not.toHaveBeenCalled();
      expect(auditLog.record).not.toHaveBeenCalled();
    });

    it('loses the link race as already-linked without auditing', async () => {
      tx.inferenceJob.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        repository.linkVisionEvent('tenant-a', 'job-1', 'event-1', linkAudit),
      ).resolves.toBe('already-linked');
      expect(auditLog.record).not.toHaveBeenCalled();
    });
  });

  describe('cancelQueuedJob', () => {
    const queuedJob = {
      id: 'job-1',
      tenantId: 'tenant-a',
      status: InferenceJobStatus.QUEUED,
      visionEventId: null,
    } as unknown as InferenceJobDetail;

    it('cancels with a tenant-scoped QUEUED-only compare-and-set and audits it', async () => {
      tx.inferenceJob.findFirst.mockResolvedValue(queuedJob);
      tx.inferenceJob.findFirstOrThrow.mockResolvedValue({
        ...queuedJob,
        status: InferenceJobStatus.CANCELLED,
      });
      const result = await repository.cancelQueuedJob(
        'tenant-a',
        'job-1',
        linkAudit,
      );
      expect(tx.inferenceJob.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'job-1',
          tenantId: 'tenant-a',
          status: InferenceJobStatus.QUEUED,
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

    it('returns null when the job is missing in this tenant', async () => {
      tx.inferenceJob.findFirst.mockResolvedValue(null);
      await expect(
        repository.cancelQueuedJob('tenant-a', 'missing', linkAudit),
      ).resolves.toBeNull();
      expect(tx.inferenceJob.updateMany).not.toHaveBeenCalled();
    });

    it("returns 'not-queued' for a claimed or finished job without writing", async () => {
      tx.inferenceJob.findFirst.mockResolvedValue({
        ...queuedJob,
        status: InferenceJobStatus.RUNNING,
      });
      await expect(
        repository.cancelQueuedJob('tenant-a', 'job-1', linkAudit),
      ).resolves.toBe('not-queued');
      expect(tx.inferenceJob.updateMany).not.toHaveBeenCalled();
      expect(auditLog.record).not.toHaveBeenCalled();
    });

    it("loses the CAS to a concurrent claim as 'not-queued' without auditing", async () => {
      tx.inferenceJob.findFirst.mockResolvedValue(queuedJob);
      tx.inferenceJob.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        repository.cancelQueuedJob('tenant-a', 'job-1', linkAudit),
      ).resolves.toBe('not-queued');
      expect(auditLog.record).not.toHaveBeenCalled();
    });

    it('throws on a blank tenantId instead of widening the query', () => {
      expect(() =>
        repository.cancelQueuedJob('', 'job-1', linkAudit),
      ).toThrow(TenantIdRequiredError);
    });
  });
});
