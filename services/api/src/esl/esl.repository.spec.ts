import {
  EslGatewayStatus,
  EslLabelStatus,
  EslUpdateErrorCode,
  EslUpdateJobStatus,
  EslUpdateTrigger,
} from '@prisma/client';
import { AuditLogService } from '../common/audit/audit-log.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  ESL_UPDATE_BACKOFF_BASE_SECONDS,
  ESL_UPDATE_MAX_ATTEMPTS,
} from './esl.constants';
import { EslRepository } from './esl.repository';

const TENANT = 'tenant-1';
const OTHER = 'tenant-2';

interface Recorded {
  model: string;
  op: string;
  args: Record<string, unknown>;
}

/**
 * A recording Prisma double. The point is not to simulate Postgres — it is to
 * prove the SHAPE of every query: that `tenantId` is in every `where`, and
 * that the queue transitions pin the predicate they claim to pin.
 */
function fakePrisma() {
  const calls: Recorded[] = [];
  const model = (name: string, defaults: Record<string, unknown> = {}) => {
    const make = (op: string, fallback: unknown) =>
      jest.fn(async (args: Record<string, unknown> = {}) => {
        calls.push({ model: name, op, args });
        return (defaults[op] as unknown) ?? fallback;
      });
    return {
      findFirst: make('findFirst', { id: `${name}-1`, tenantId: TENANT }),
      findFirstOrThrow: make('findFirstOrThrow', {
        id: `${name}-1`,
        tenantId: TENANT,
      }),
      findMany: make('findMany', []),
      count: make('count', 0),
      create: make('create', { id: `${name}-1`, tenantId: TENANT }),
      createMany: make('createMany', { count: 0 }),
      update: make('update', { id: `${name}-1`, tenantId: TENANT }),
      updateMany: make('updateMany', { count: 1 }),
    };
  };
  const client = {
    eslGateway: model('eslGateway'),
    eslLabel: model('eslLabel'),
    eslUpdateJob: model('eslUpdateJob'),
    location: model('location'),
    product: model('product'),
    planogramCellAssignment: model('planogramCellAssignment'),
    auditLog: model('auditLog'),
  };
  const prisma = {
    ...client,
    $transaction: jest.fn(
      async (fn: (tx: typeof client) => Promise<unknown>) => fn(client),
    ),
  };
  return { prisma, calls, client };
}

function build() {
  const { prisma, calls, client } = fakePrisma();
  const repository = new EslRepository(
    prisma as unknown as PrismaService,
    new AuditLogService(prisma as unknown as PrismaService),
  );
  const audit = () => ({
    tenantId: TENANT,
    actorEmail: 'ops@tenant.test',
    action: 'UPDATE' as never,
    entityType: 'EslLabel',
  });
  return { repository, calls, client, prisma, audit };
}

/** Every `where` a call carried, flattened. */
function wheres(calls: Recorded[], model: string): Record<string, unknown>[] {
  return calls
    .filter((call) => call.model === model && 'where' in call.args)
    .map((call) => call.args.where as Record<string, unknown>);
}

describe('ESL repository tenant isolation', () => {
  it('refuses a blank tenant id rather than reading every tenant', async () => {
    const { repository } = build();
    await expect(repository.findGateways('', {}, { skip: 0, take: 10 }))
      .rejects.toThrow();
    await expect(repository.enqueueJobs('  ', [])).resolves.toBe(0);
  });

  it('scopes every gateway read to the caller’s tenant', async () => {
    const { repository, calls } = build();
    await repository.findGateways(TENANT, {}, { skip: 0, take: 10 });
    await repository.findGatewayById(TENANT, 'gw-1');
    for (const where of wheres(calls, 'eslGateway')) {
      expect(where.tenantId).toBe(TENANT);
    }
  });

  it('scopes every label read to the caller’s tenant', async () => {
    const { repository, calls } = build();
    await repository.findLabels(TENANT, {}, { skip: 0, take: 10 });
    await repository.findLabelById(TENANT, 'lbl-1');
    await repository.findAllBoundLabels(TENANT);
    await repository.findBoundLabelsForProducts(TENANT, ['p1'], 'loc-1');
    await repository.findLabelLocations(TENANT, ['lbl-1']);
    for (const where of wheres(calls, 'eslLabel')) {
      expect(where.tenantId).toBe(TENANT);
    }
  });

  it('scopes every job read to the caller’s tenant', async () => {
    const { repository, calls } = build();
    await repository.findJobs(TENANT, {}, { skip: 0, take: 10 });
    await repository.findJobById(TENANT, 'job-1');
    await repository.reclaimExpired(TENANT);
    await repository.claimBatch(OTHER, 0);
    for (const where of wheres(calls, 'eslUpdateJob')) {
      expect([TENANT, OTHER]).toContain(where.tenantId);
    }
  });

  it('stamps the caller’s tenant on enqueued work', async () => {
    const { repository, client } = build();
    await repository.enqueueJobs(TENANT, [
      {
        labelId: 'lbl-1',
        gatewayId: 'gw-1',
        trigger: EslUpdateTrigger.PRICE_ACTIVATION,
        priceBookVersionId: 'ver-1',
        contentHash: 'abc',
        idempotencyKey: 'activation:ver-1:lbl-1',
      },
    ]);
    const args = client.eslUpdateJob.createMany.mock.calls[0][0] as {
      data: Array<{ tenantId: string }>;
      skipDuplicates: boolean;
    };
    expect(args.data[0].tenantId).toBe(TENANT);
    // The de-duplication that makes a replayed activation a no-op.
    expect(args.skipDuplicates).toBe(true);
  });

  it('verifies the location belongs to the tenant before creating a gateway', async () => {
    const { repository, client } = build();
    client.location.findFirst.mockResolvedValueOnce(null);
    const result = await repository.createGateway(
      TENANT,
      {
        code: 'S1',
        name: 'Store 1',
        vendorCode: 'SIMULATED',
        locationId: 'loc-other',
        credentialRef: null,
      },
      () => audit(),
    );
    expect(result).toBe('location-not-found');
    // Read from the mock rather than the recorder: mockResolvedValueOnce
    // replaces the recording implementation for that call.
    const locationWhere = (
      client.location.findFirst.mock.calls[0][0] as {
        where: { tenantId: string };
      }
    ).where;
    expect(locationWhere.tenantId).toBe(TENANT);
    expect(client.eslGateway.create).not.toHaveBeenCalled();
  });

  it('verifies the product belongs to the tenant before binding a label', async () => {
    const { repository, client } = build();
    client.eslLabel.findFirst.mockResolvedValueOnce({
      id: 'lbl-1',
      tenantId: TENANT,
      status: EslLabelStatus.UNBOUND,
      productId: null,
    });
    client.product.findFirst.mockResolvedValueOnce(null);
    const result = await repository.updateLabel(
      TENANT,
      'lbl-1',
      { productId: 'prod-other' },
      () => audit(),
    );
    expect(result).toBe('product-not-found');
    const productWhere = (
      client.product.findFirst.mock.calls[0][0] as {
        where: { tenantId: string };
      }
    ).where;
    expect(productWhere.tenantId).toBe(TENANT);
    expect(client.eslLabel.update).not.toHaveBeenCalled();
  });
});

function audit() {
  return {
    tenantId: TENANT,
    actorEmail: 'ops@tenant.test',
    action: 'UPDATE' as never,
    entityType: 'EslLabel',
  };
}

describe('ESL queue claiming', () => {
  const queued = (id: string, attempts = 0) => ({ id, attempts });

  it('claims with a compare-and-set on status and attempts', async () => {
    const { repository, client } = build();
    client.eslUpdateJob.findFirst
      .mockResolvedValueOnce(queued('job-1'))
      .mockResolvedValueOnce({ id: 'job-1', tenantId: TENANT })
      .mockResolvedValue(null);
    const claimed = await repository.claimBatch(TENANT, 1);
    expect(claimed).toHaveLength(1);
    const update = client.eslUpdateJob.updateMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(update.where).toMatchObject({
      id: 'job-1',
      tenantId: TENANT,
      status: EslUpdateJobStatus.QUEUED,
      attempts: 0,
    });
    // The fencing token the worker echoes back on complete/fail.
    expect(update.data.claimedAttempt).toBe(1);
    expect(update.data.leaseExpiresAt).toBeInstanceOf(Date);
  });

  it('ignores work whose backoff has not elapsed', async () => {
    const { repository, client } = build();
    client.eslUpdateJob.findFirst.mockResolvedValue(null);
    await repository.claimBatch(TENANT, 5);
    const where = client.eslUpdateJob.findFirst.mock.calls[0][0] as {
      where: { nextAttemptAt: { lte: Date } };
    };
    expect(where.where.nextAttemptAt.lte).toBeInstanceOf(Date);
  });

  it('moves on when another worker wins the race, and terminates', async () => {
    const { repository, client } = build();
    // Honour `notIn` the way Postgres would: without it, a row the claim
    // loses would be handed back for ever. That the loop terminates is the
    // property under test.
    client.eslUpdateJob.findFirst.mockImplementation(
      async (args: Record<string, unknown> = {}) => {
        const where = (args.where ?? {}) as {
          id?: { notIn?: string[] };
        };
        const excluded = where.id?.notIn ?? [];
        const next = ['job-1', 'job-2'].find((id) => !excluded.includes(id));
        return next ? queued(next) : null;
      },
    );
    client.eslUpdateJob.updateMany.mockResolvedValue({ count: 0 });
    const claimed = await repository.claimBatch(TENANT, 3);
    expect(claimed).toEqual([]);
    // One attempt per candidate, then the candidate pool is exhausted.
    expect(client.eslUpdateJob.updateMany).toHaveBeenCalledTimes(2);
  });
});

describe('ESL queue lease recovery', () => {
  it('requeues a stranded job behind an exponential backoff', async () => {
    const { repository, client } = build();
    const now = new Date('2026-09-16T10:00:00.000Z');
    client.eslUpdateJob.findMany.mockResolvedValueOnce([
      { id: 'job-1', attempts: 1 },
    ]);
    const result = await repository.reclaimExpired(TENANT, now);
    expect(result).toEqual({ requeued: 1, failed: 0 });
    const update = client.eslUpdateJob.updateMany.mock.calls[0][0] as {
      data: { status: string; nextAttemptAt: Date; leaseExpiresAt: null };
    };
    expect(update.data.status).toBe(EslUpdateJobStatus.QUEUED);
    expect(update.data.leaseExpiresAt).toBeNull();
    expect(update.data.nextAttemptAt.getTime() - now.getTime()).toBe(
      ESL_UPDATE_BACKOFF_BASE_SECONDS * 1000,
    );
  });

  it('fails a job that has spent its attempt budget, never looping forever', async () => {
    const { repository, client } = build();
    client.eslUpdateJob.findMany.mockResolvedValueOnce([
      { id: 'job-1', attempts: ESL_UPDATE_MAX_ATTEMPTS },
    ]);
    const result = await repository.reclaimExpired(TENANT);
    expect(result).toEqual({ requeued: 0, failed: 1 });
    const update = client.eslUpdateJob.updateMany.mock.calls[0][0] as {
      data: { status: string; lastErrorCode: string };
    };
    expect(update.data.status).toBe(EslUpdateJobStatus.FAILED);
    expect(update.data.lastErrorCode).toBe(EslUpdateErrorCode.LEASE_EXPIRED);
  });

  it('only looks at RUNNING jobs whose lease has actually expired', async () => {
    const { repository, client } = build();
    const now = new Date('2026-09-16T10:00:00.000Z');
    await repository.reclaimExpired(TENANT, now);
    const args = client.eslUpdateJob.findMany.mock.calls[0][0] as {
      where: { status: string; leaseExpiresAt: { lt: Date }; tenantId: string };
    };
    expect(args.where.status).toBe(EslUpdateJobStatus.RUNNING);
    expect(args.where.leaseExpiresAt.lt).toBe(now);
    expect(args.where.tenantId).toBe(TENANT);
  });
});

describe('ESL queue fencing', () => {
  const running = (claimedAttempt: number) => ({
    id: 'job-1',
    tenantId: TENANT,
    labelId: 'lbl-1',
    status: EslUpdateJobStatus.RUNNING,
    attempts: claimedAttempt,
    claimedAttempt,
  });

  it('refuses a result from a superseded attempt', async () => {
    const { repository, client } = build();
    client.eslUpdateJob.findFirst.mockResolvedValueOnce(running(2));
    const result = await repository.completeJob(
      TENANT,
      'job-1',
      1,
      null,
      () => audit(),
    );
    expect(result).toBe('lease-superseded');
    expect(client.eslUpdateJob.updateMany).not.toHaveBeenCalled();
  });

  it('refuses a result for a job that already finished', async () => {
    const { repository, client } = build();
    client.eslUpdateJob.findFirst.mockResolvedValueOnce({
      ...running(1),
      status: EslUpdateJobStatus.SUCCEEDED,
    });
    expect(
      await repository.failJob(
        TENANT,
        'job-1',
        1,
        { code: EslUpdateErrorCode.VENDOR_REJECTED, message: null },
        () => audit(),
      ),
    ).toBe('terminal');
  });

  it('writes the label’s rendered state in the same transaction as success', async () => {
    const { repository, client } = build();
    client.eslUpdateJob.findFirst.mockResolvedValueOnce(running(1));
    const now = new Date('2026-09-16T10:00:00.000Z');
    await repository.completeJob(
      TENANT,
      'job-1',
      1,
      {
        contentHash: 'abc',
        batteryPercent: 80,
        signalPercent: 70,
        priceBookVersionId: 'ver-1',
      },
      () => audit(),
      now,
    );
    const labelUpdate = client.eslLabel.updateMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(labelUpdate.where).toMatchObject({
      id: 'lbl-1',
      tenantId: TENANT,
    });
    expect(labelUpdate.data).toMatchObject({
      renderedContentHash: 'abc',
      renderedVersionId: 'ver-1',
      lastRenderedAt: now,
    });
    // One transaction covers the job, the label and the audit row.
    expect(client.auditLog.create).toHaveBeenCalled();
  });

  it('requeues a failure while attempts remain', async () => {
    const { repository, client } = build();
    client.eslUpdateJob.findFirst.mockResolvedValueOnce(running(1));
    await repository.failJob(
      TENANT,
      'job-1',
      1,
      { code: EslUpdateErrorCode.LABEL_UNREACHABLE, message: null },
      () => audit(),
    );
    const update = client.eslUpdateJob.updateMany.mock.calls[0][0] as {
      data: { status: string };
    };
    expect(update.data.status).toBe(EslUpdateJobStatus.QUEUED);
  });

  it('fails a failure that spent the budget', async () => {
    const { repository, client } = build();
    client.eslUpdateJob.findFirst.mockResolvedValueOnce({
      ...running(ESL_UPDATE_MAX_ATTEMPTS),
      attempts: ESL_UPDATE_MAX_ATTEMPTS,
    });
    await repository.failJob(
      TENANT,
      'job-1',
      ESL_UPDATE_MAX_ATTEMPTS,
      { code: EslUpdateErrorCode.LABEL_UNREACHABLE, message: null },
      () => audit(),
    );
    const update = client.eslUpdateJob.updateMany.mock.calls[0][0] as {
      data: { status: string };
    };
    expect(update.data.status).toBe(EslUpdateJobStatus.FAILED);
  });
});

describe('ESL lifecycle side effects', () => {
  it('cancels queued work when a gateway is disabled', async () => {
    const { repository, client } = build();
    client.eslGateway.findFirst.mockResolvedValueOnce({
      id: 'gw-1',
      tenantId: TENANT,
      status: EslGatewayStatus.ACTIVE,
    });
    client.eslGateway.update.mockResolvedValueOnce({
      id: 'gw-1',
      tenantId: TENANT,
      status: EslGatewayStatus.DISABLED,
    });
    await repository.updateGateway(
      TENANT,
      'gw-1',
      { status: EslGatewayStatus.DISABLED },
      () => audit(),
    );
    const cancel = client.eslUpdateJob.updateMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
      data: { status: string; lastErrorCode: string };
    };
    expect(cancel.where).toMatchObject({ tenantId: TENANT, gatewayId: 'gw-1' });
    expect(cancel.data.status).toBe(EslUpdateJobStatus.CANCELLED);
    expect(cancel.data.lastErrorCode).toBe(
      EslUpdateErrorCode.GATEWAY_DISABLED,
    );
  });

  it('refuses to edit a retired label', async () => {
    const { repository, client } = build();
    client.eslLabel.findFirst.mockResolvedValueOnce({
      id: 'lbl-1',
      tenantId: TENANT,
      status: EslLabelStatus.RETIRED,
      productId: null,
    });
    expect(
      await repository.updateLabel(
        TENANT,
        'lbl-1',
        { productId: 'prod-1' },
        () => audit(),
      ),
    ).toBe('label-retired');
  });

  it('re-discovering a label keeps its binding and refreshes its health', async () => {
    const { repository, client } = build();
    client.eslLabel.findFirst.mockResolvedValueOnce({
      id: 'lbl-1',
      tenantId: TENANT,
      productId: 'prod-1',
      status: EslLabelStatus.BOUND,
    });
    await repository.upsertLabel(
      TENANT,
      'gw-1',
      { vendorLabelId: 'A', batteryPercent: 55, signalPercent: 60 },
      () => audit(),
    );
    const update = client.eslLabel.update.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(update.data).toEqual({ batteryPercent: 55, signalPercent: 60 });
    expect(update.data).not.toHaveProperty('productId');
    expect(update.data).not.toHaveProperty('status');
  });
});
