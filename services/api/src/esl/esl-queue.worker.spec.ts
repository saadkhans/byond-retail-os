import { ConfigService } from '@nestjs/config';
import { TenantStatus } from '@prisma/client';
import { PlatformModulesService } from '../platform-modules/platform-modules.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  DEFAULT_ESL_RECONCILE_INTERVAL_MS,
  DEFAULT_ESL_SWEEP_BATCH,
  DEFAULT_ESL_SWEEP_INTERVAL_MS,
  EslQueueConfig,
} from './esl-queue.config';
import { EslQueueWorker } from './esl-queue.worker';
import { EslProcessSummary, EslService } from './esl.service';

/**
 * The runner behind the ESL queue, with Prisma, the service and the module
 * gate mocked. What is pinned here is the SWEEP SHAPE, not label pushing —
 * pushing is EslService's and is covered by its own suites:
 *
 *   * it is OFF unless configured on, and it never holds the process open;
 *   * it enumerates ACTIVE tenants from the platform-scoped Tenant table and
 *     then works one tenantId at a time;
 *   * one tenant's failure does not stop the sweep;
 *   * a gateway's failure does not stop the other gateways (the service
 *     already isolates that, and the worker must not defeat it by treating a
 *     partly-failed batch as a sweep failure);
 *   * overlapping ticks never double-process.
 */

/** Let every already-queued microtask and I/O callback run. */
const flush = (): Promise<void> =>
  new Promise<void>((resolve) => setImmediate(resolve));

const emptySummary = (): EslProcessSummary => ({
  claimed: 0,
  succeeded: 0,
  failed: 0,
  requeued: 0,
  leaseReclaimed: 0,
  leaseFailed: 0,
});

function configFor(values: Record<string, string | number>): EslQueueConfig {
  return new EslQueueConfig({
    get: (key: string) => values[key],
  } as unknown as ConfigService);
}

interface Harness {
  worker: EslQueueWorker;
  findManyTenants: jest.Mock;
  processBatch: jest.Mock;
  reconcile: jest.Mock;
  isEnabledForTenant: jest.Mock;
}

function buildHarness(
  tenantIds: string[],
  overrides: {
    config?: Record<string, string | number>;
    processBatch?: jest.Mock;
    reconcile?: jest.Mock;
    isEnabledForTenant?: jest.Mock;
  } = {},
): Harness {
  const findManyTenants = jest.fn(
    async (_args: { where: { status: TenantStatus } }) =>
      [...tenantIds].sort().map((id) => ({ id })),
  );
  const processBatch =
    overrides.processBatch ??
    jest.fn(async (_tenantId: string, _limit: number) => emptySummary());
  const reconcile =
    overrides.reconcile ??
    jest.fn(async (_tenantId: string, _actor: unknown) => ({
      inspected: 0,
      enqueued: 0,
    }));
  const isEnabledForTenant =
    overrides.isEnabledForTenant ??
    jest.fn(async (_tenantId: string, _code: string) => true);
  const worker = new EslQueueWorker(
    { tenant: { findMany: findManyTenants } } as unknown as PrismaService,
    configFor({ ESL_QUEUE_WORKER_ENABLED: 'true', ...overrides.config }),
    { processBatch, reconcile } as unknown as EslService,
    { isEnabledForTenant } as unknown as PlatformModulesService,
  );
  return { worker, findManyTenants, processBatch, reconcile, isEnabledForTenant };
}

describe('EslQueueConfig', () => {
  it('is disabled unless the flag says otherwise, with safe defaults', () => {
    const config = configFor({});
    expect(config.enabled).toBe(false);
    expect(config.sweepIntervalMs).toBe(DEFAULT_ESL_SWEEP_INTERVAL_MS);
    expect(config.batchSize).toBe(DEFAULT_ESL_SWEEP_BATCH);
    expect(config.reconcileIntervalMs).toBe(DEFAULT_ESL_RECONCILE_INTERVAL_MS);
  });

  it('falls back to the default rather than to zero on nonsense values', () => {
    const config = configFor({
      ESL_QUEUE_WORKER_ENABLED: 'yes',
      ESL_QUEUE_WORKER_INTERVAL_MS: 0,
      ESL_QUEUE_WORKER_BATCH_SIZE: 5_000,
      ESL_RECONCILE_INTERVAL_MS: 'soon',
    });
    // 'yes' is not the validated spelling of true — fail closed.
    expect(config.enabled).toBe(false);
    expect(config.sweepIntervalMs).toBe(DEFAULT_ESL_SWEEP_INTERVAL_MS);
    expect(config.batchSize).toBe(DEFAULT_ESL_SWEEP_BATCH);
    expect(config.reconcileIntervalMs).toBe(DEFAULT_ESL_RECONCILE_INTERVAL_MS);
  });

  it('accepts configured values inside the bounds', () => {
    const config = configFor({
      ESL_QUEUE_WORKER_ENABLED: 'TRUE',
      ESL_QUEUE_WORKER_INTERVAL_MS: 5_000,
      ESL_QUEUE_WORKER_BATCH_SIZE: 10,
      ESL_RECONCILE_INTERVAL_MS: 60_000,
    });
    expect(config.enabled).toBe(true);
    expect(config.sweepIntervalMs).toBe(5_000);
    expect(config.batchSize).toBe(10);
    expect(config.reconcileIntervalMs).toBe(60_000);
  });
});

describe('EslQueueWorker scheduling', () => {
  it('starts no timer when disabled — the default', () => {
    const setInterval = jest.spyOn(global, 'setInterval');
    try {
      const { worker } = buildHarness(['t1'], {
        config: { ESL_QUEUE_WORKER_ENABLED: 'false' },
      });
      worker.onModuleInit();
      expect(setInterval).not.toHaveBeenCalled();
      worker.onModuleDestroy();
    } finally {
      setInterval.mockRestore();
    }
  });

  it('unrefs its timer so it can never hold a process (or a jest worker) open', () => {
    const { worker } = buildHarness(['t1']);
    const unref = jest.fn();
    const handle = { unref } as unknown as NodeJS.Timeout;
    const setInterval = jest
      .spyOn(global, 'setInterval')
      .mockReturnValue(handle);
    const clearInterval = jest
      .spyOn(global, 'clearInterval')
      .mockImplementation(() => undefined);
    try {
      worker.onModuleInit();
      expect(setInterval).toHaveBeenCalledTimes(1);
      expect(setInterval.mock.calls[0][1]).toBe(DEFAULT_ESL_SWEEP_INTERVAL_MS);
      expect(unref).toHaveBeenCalledTimes(1);
      worker.onModuleDestroy();
      expect(clearInterval).toHaveBeenCalledWith(handle);
    } finally {
      setInterval.mockRestore();
      clearInterval.mockRestore();
    }
  });

  it('honours a configured interval', () => {
    const { worker } = buildHarness(['t1'], {
      config: { ESL_QUEUE_WORKER_INTERVAL_MS: 2_500 },
    });
    const setInterval = jest
      .spyOn(global, 'setInterval')
      .mockReturnValue({ unref: jest.fn() } as unknown as NodeJS.Timeout);
    try {
      worker.onModuleInit();
      expect(setInterval.mock.calls[0][1]).toBe(2_500);
    } finally {
      setInterval.mockRestore();
      worker.onModuleDestroy();
    }
  });
});

describe('EslQueueWorker.sweepOnce', () => {
  it('drains every ACTIVE tenant, one tenantId at a time', async () => {
    const { worker, findManyTenants, processBatch } = buildHarness([
      'tenant-b',
      'tenant-a',
    ]);

    await worker.sweepOnce();

    expect(findManyTenants).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: TenantStatus.ACTIVE } }),
    );
    expect(processBatch.mock.calls.map((call) => call[0])).toEqual([
      'tenant-a',
      'tenant-b',
    ]);
    // Every call carries exactly one tenant id and the configured batch size;
    // there is no cross-tenant variant of processBatch to reach for.
    for (const call of processBatch.mock.calls) {
      expect(typeof call[0]).toBe('string');
      expect(call[1]).toBe(DEFAULT_ESL_SWEEP_BATCH);
    }
  });

  it('skips a tenant whose esl module is disabled without claiming anything', async () => {
    const isEnabledForTenant = jest.fn(
      async (tenantId: string, _code: string) => tenantId === 'on',
    );
    const { worker, processBatch, reconcile } = buildHarness(['on', 'off'], {
      isEnabledForTenant,
    });

    await worker.sweepOnce();

    expect(isEnabledForTenant).toHaveBeenCalledWith('off', 'esl');
    expect(processBatch.mock.calls.map((call) => call[0])).toEqual(['on']);
    expect(reconcile.mock.calls.map((call) => call[0])).toEqual(['on']);
  });

  it('keeps sweeping when one tenant throws', async () => {
    const processBatch = jest.fn(async (tenantId: string) => {
      if (tenantId === 'tenant-b') {
        throw new Error('database went away');
      }
      return emptySummary();
    });
    const { worker } = buildHarness(['tenant-a', 'tenant-b', 'tenant-c'], {
      processBatch,
    });

    await expect(worker.sweepOnce()).resolves.toBeUndefined();

    expect(processBatch.mock.calls.map((call) => call[0])).toEqual([
      'tenant-a',
      'tenant-b',
      'tenant-c',
    ]);
  });

  it('keeps sweeping when one tenant’s reconcile throws, and retries it next sweep', async () => {
    const reconcile = jest.fn(async (tenantId: string) => {
      if (tenantId === 'tenant-a') {
        throw new Error('price resolution failed');
      }
      return { inspected: 0, enqueued: 0 };
    });
    const { worker, processBatch } = buildHarness(['tenant-a', 'tenant-b'], {
      reconcile,
    });

    await worker.sweepOnce();
    expect(processBatch.mock.calls.map((call) => call[0])).toEqual([
      'tenant-a',
      'tenant-b',
    ]);

    // tenant-a was never stamped as reconciled, so it is due again at once —
    // tenant-b, which succeeded, is not.
    await worker.sweepOnce();
    expect(reconcile.mock.calls.map((call) => call[0])).toEqual([
      'tenant-a',
      'tenant-b',
      'tenant-a',
    ]);
  });

  it('does not treat a partly-failed batch as a sweep failure — a failing gateway costs only its own labels', async () => {
    // What EslService reports when one gateway was unreachable and another
    // pushed normally: the summary carries both, and NOTHING throws. The
    // worker must carry on to the next tenant and still reconcile this one.
    const processBatch = jest.fn(async (_tenantId: string) => ({
      ...emptySummary(),
      claimed: 4,
      succeeded: 2,
      failed: 2,
    }));
    const { worker, reconcile } = buildHarness(['tenant-a', 'tenant-b'], {
      processBatch,
    });

    await worker.sweepOnce();

    expect(processBatch).toHaveBeenCalledTimes(2);
    expect(reconcile.mock.calls.map((call) => call[0])).toEqual([
      'tenant-a',
      'tenant-b',
    ]);
  });

  it('survives a failed tenant enumeration without rejecting', async () => {
    const { worker, findManyTenants, processBatch } = buildHarness(['t1']);
    findManyTenants.mockRejectedValueOnce(new Error('connection refused'));

    await expect(worker.sweepOnce()).resolves.toBeUndefined();
    expect(processBatch).not.toHaveBeenCalled();

    // The next tick is unaffected: the re-entrancy flag was released.
    await worker.sweepOnce();
    expect(processBatch).toHaveBeenCalledTimes(1);
  });

  it('refuses to overlap sweeps, so a slow sweep cannot double-process', async () => {
    let release: () => void = () => undefined;
    const processBatch = jest.fn(async (_tenantId: string) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return emptySummary();
    });
    const { worker } = buildHarness(['tenant-a'], { processBatch });

    const first = worker.sweepOnce();
    await flush();
    // The tick that lands while the first sweep is still in flight is
    // dropped, not queued behind it.
    await worker.sweepOnce();
    expect(processBatch).toHaveBeenCalledTimes(1);

    release();
    await first;

    // Once the slow sweep finished, the next tick proceeds normally.
    const second = worker.sweepOnce();
    await flush();
    expect(processBatch).toHaveBeenCalledTimes(2);
    release();
    await second;
  });
});

describe('EslQueueWorker reconciliation cadence', () => {
  it('reconciles on first sight, then not again until the interval has passed', async () => {
    const start = 1_750_000_000_000;
    const now = jest.spyOn(Date, 'now').mockReturnValue(start);
    try {
      const { worker, reconcile, processBatch } = buildHarness(['tenant-a'], {
        config: { ESL_RECONCILE_INTERVAL_MS: 60_000 },
      });

      await worker.sweepOnce();
      expect(reconcile).toHaveBeenCalledTimes(1);

      now.mockReturnValue(start + 59_000);
      await worker.sweepOnce();
      // Draining happens every sweep; repairing does not.
      expect(processBatch).toHaveBeenCalledTimes(2);
      expect(reconcile).toHaveBeenCalledTimes(1);

      now.mockReturnValue(start + 60_001);
      await worker.sweepOnce();
      expect(reconcile).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  });

  it('attributes a background pass to no user', async () => {
    const { worker, reconcile } = buildHarness(['tenant-a']);
    await worker.sweepOnce();
    expect(reconcile).toHaveBeenCalledWith('tenant-a', null);
  });

  it('forgets the cadence cursor for a tenant that is no longer active', async () => {
    const start = 1_750_000_000_000;
    const now = jest.spyOn(Date, 'now').mockReturnValue(start);
    // The harness reads this array on every enumeration, so mutating it
    // between sweeps is a tenant changing status under the worker.
    const tenantIds = ['tenant-a'];
    try {
      const { worker, reconcile } = buildHarness(tenantIds, {
        config: { ESL_RECONCILE_INTERVAL_MS: 3_600_000 },
      });

      await worker.sweepOnce();
      expect(reconcile).toHaveBeenCalledTimes(1);

      // The tenant is suspended (drops out of the ACTIVE list) and later
      // reactivated, well inside the reconcile interval.
      tenantIds.pop();
      await worker.sweepOnce();
      expect(reconcile).toHaveBeenCalledTimes(1);

      tenantIds.push('tenant-a');
      now.mockReturnValue(start + 1_000);
      await worker.sweepOnce();
      // The cursor went with it, so the returning tenant is reconciled once
      // on re-entry rather than being trusted for another hour.
      expect(reconcile).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  });
});
