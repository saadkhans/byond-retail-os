import { InferenceJobStatus } from '@prisma/client';
import { PickupDetectionWorker } from './pickup-detection.worker';
import {
  CV_MODULE_DISABLED_ERROR_CODE,
  pickupSourceId,
} from './pickup-detection.service';

/**
 * scanOnce loop tests with Prisma and the detection service mocked: they
 * prove the SCAN SHAPE — tenant enumeration first, then tenant-scoped
 * asset/job queries only; query-level paging past already-attempted
 * assets; the MAX_ASSETS_PER_SCAN cap; and the catch-all that keeps the
 * interval callback from ever rejecting.
 */

/** Mirrors the module-private constants in pickup-detection.worker.ts. */
const MAX_ASSETS_PER_SCAN = 2;
const SCAN_PAGE_SIZE = 25;

interface FakeAsset {
  id: string;
  attempted: boolean;
}

interface EligibleWhere {
  tenantId?: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

function buildHarness(tenants: Record<string, FakeAsset[]>) {
  const groupBy = jest.fn(async (_args: { by: string[]; where: EligibleWhere }) =>
    Object.keys(tenants)
      .sort()
      .map((tenantId) => ({ tenantId })),
  );
  const findManyAssets = jest.fn(
    async (args: {
      where: EligibleWhere;
      take: number;
      cursor?: { id: string };
      skip?: number;
    }) => {
      const rows = (tenants[args.where.tenantId ?? ''] ?? []).map((a) => ({
        id: a.id,
      }));
      let start = 0;
      if (args.cursor) {
        start = rows.findIndex((r) => r.id === args.cursor?.id);
        start = start < 0 ? rows.length : start + (args.skip ?? 0);
      }
      return rows.slice(start, start + args.take);
    },
  );
  const findManyJobs = jest.fn(
    async (args: {
      where: { tenantId?: string; sourceId: { in: string[] } };
    }) => {
      const attempted = new Set(
        (tenants[args.where.tenantId ?? ''] ?? [])
          .filter((a) => a.attempted)
          .map((a) => pickupSourceId(a.id)),
      );
      return args.where.sourceId.in
        .filter((sourceId) => attempted.has(sourceId))
        .map((sourceId) => ({ sourceId }));
    },
  );
  const detectForAsset = jest.fn(
    async (_tenantId: string, _videoAssetId: string): Promise<void> =>
      undefined,
  );
  const isEnabledForTenant = jest.fn(
    async (_tenantId: string, _moduleCode: string) => true,
  );
  const worker = new PickupDetectionWorker(
    {
      videoAsset: { groupBy, findMany: findManyAssets },
      inferenceJob: { findMany: findManyJobs },
    } as never,
    { enabled: true } as never,
    { detectForAsset } as never,
    { isEnabledForTenant } as never,
  );
  return {
    worker,
    tenants,
    groupBy,
    findManyAssets,
    findManyJobs,
    detectForAsset,
    isEnabledForTenant,
  };
}

function assets(prefix: string, count: number, attempted: boolean): FakeAsset[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${String(i + 1).padStart(3, '0')}`,
    attempted,
  }));
}

describe('PickupDetectionWorker.scanOnce', () => {
  it('enumerates tenants first, then scopes every asset/job query to one tenantId', async () => {
    const h = buildHarness({
      'tenant-a': [{ id: 'a-1', attempted: false }],
      'tenant-b': [{ id: 'b-1', attempted: false }],
    });
    await h.worker.scanOnce();

    expect(h.groupBy).toHaveBeenCalledTimes(1);
    expect(h.groupBy.mock.calls[0][0]).toMatchObject({ by: ['tenantId'] });
    // The enumeration itself carries no tenantId (platform-level), but
    // every subsequent data query must.
    for (const [args] of h.findManyAssets.mock.calls) {
      expect(args.where.tenantId).toEqual(expect.any(String));
    }
    for (const [args] of h.findManyJobs.mock.calls) {
      expect(args.where.tenantId).toEqual(expect.any(String));
    }
    expect(h.detectForAsset.mock.calls).toEqual([
      ['tenant-a', 'a-1'],
      ['tenant-b', 'b-1'],
    ]);
  });

  it('pages past a full page of already-attempted assets to reach newer ones', async () => {
    const backlog = assets('old', SCAN_PAGE_SIZE, true);
    const fresh: FakeAsset = { id: 'zz-fresh', attempted: false };
    const h = buildHarness({ 'tenant-a': [...backlog, fresh] });
    await h.worker.scanOnce();

    // Second page was requested via a cursor at the end of the first page.
    expect(h.findManyAssets).toHaveBeenCalledTimes(2);
    expect(h.findManyAssets.mock.calls[1][0]).toMatchObject({
      cursor: { id: backlog[backlog.length - 1].id },
      skip: 1,
    });
    // Attempted assets are excluded via the batched job lookup, never run.
    expect(h.detectForAsset.mock.calls).toEqual([['tenant-a', 'zz-fresh']]);
  });

  it('caps work at MAX_ASSETS_PER_SCAN per scan, across tenants', async () => {
    const h = buildHarness({
      'tenant-a': assets('a', 5, false),
      'tenant-b': assets('b', 5, false),
    });
    await h.worker.scanOnce();

    expect(h.detectForAsset).toHaveBeenCalledTimes(MAX_ASSETS_PER_SCAN);
    // Oldest-first within the first tenant; tenant-b waits for a later scan.
    expect(h.detectForAsset.mock.calls).toEqual([
      ['tenant-a', 'a-001'],
      ['tenant-a', 'a-002'],
    ]);
  });

  it('rotates the tenant scan across polls instead of restarting at the first tenant', async () => {
    // tenant-a alone could fill the budget every poll; the rotating cursor
    // must hand the NEXT poll to tenant-b instead of starving it forever.
    const h = buildHarness({
      'tenant-a': assets('a', 5, false),
      'tenant-b': assets('b', 5, false),
    });
    await h.worker.scanOnce();
    expect(h.detectForAsset.mock.calls).toEqual([
      ['tenant-a', 'a-001'],
      ['tenant-a', 'a-002'],
    ]);

    // Second poll resumes AFTER the tenant that consumed the last budget…
    h.detectForAsset.mockClear();
    await h.worker.scanOnce();
    expect(h.detectForAsset.mock.calls).toEqual([
      ['tenant-b', 'b-001'],
      ['tenant-b', 'b-002'],
    ]);

    // …and the rotation wraps back around to the first tenant.
    h.detectForAsset.mockClear();
    await h.worker.scanOnce();
    expect(h.detectForAsset.mock.calls).toEqual([
      ['tenant-a', 'a-001'],
      ['tenant-a', 'a-002'],
    ]);
  });

  it('keeps single-tenant behavior unchanged under rotation', async () => {
    const h = buildHarness({ 'tenant-a': assets('a', 5, false) });
    await h.worker.scanOnce();
    h.detectForAsset.mockClear();
    await h.worker.scanOnce();
    // Rotating a one-tenant list is a no-op: same tenant, oldest first.
    expect(h.detectForAsset.mock.calls).toEqual([
      ['tenant-a', 'a-001'],
      ['tenant-a', 'a-002'],
    ]);
  });

  it('resumes the rotation past a served tenant that has since dropped out', async () => {
    // Serve tenant-b, then remove it from the eligible set entirely: the
    // cursor compares ids instead of positions, so the next poll starts at
    // the first tenant sorting after "tenant-b" (tenant-c), not back at
    // tenant-a.
    const h = buildHarness({ 'tenant-b': assets('b', 5, false) });
    await h.worker.scanOnce();
    expect(h.detectForAsset.mock.calls).toEqual([
      ['tenant-b', 'b-001'],
      ['tenant-b', 'b-002'],
    ]);

    delete h.tenants['tenant-b'];
    h.tenants['tenant-a'] = assets('x', 5, false);
    h.tenants['tenant-c'] = assets('z', 5, false);
    h.detectForAsset.mockClear();
    await h.worker.scanOnce();
    expect(h.detectForAsset.mock.calls).toEqual([
      ['tenant-c', 'z-001'],
      ['tenant-c', 'z-002'],
    ]);
  });

  it('windows eligibility on updatedAt (validation transition), not createdAt', async () => {
    // An upload can sit QUARANTINED past the 24h window and only then be
    // VALIDATED; keying the cutoff on createdAt would deny such assets
    // their automatic attempt forever. updatedAt is bumped by the status
    // transition itself, so it carries the window instead.
    const h = buildHarness({ 'tenant-a': [{ id: 'a-1', attempted: false }] });
    await h.worker.scanOnce();

    const wheres = [
      h.groupBy.mock.calls[0][0].where,
      h.findManyAssets.mock.calls[0][0].where,
    ];
    for (const where of wheres) {
      expect(where.updatedAt).toEqual({ gte: expect.any(Date) });
      expect(where.createdAt).toBeUndefined();
    }
  });

  it('counts a failed detectForAsset against the cap and keeps scanning', async () => {
    const h = buildHarness({ 'tenant-a': assets('a', 3, false) });
    h.detectForAsset.mockRejectedValueOnce(new Error('race with delete'));
    await expect(h.worker.scanOnce()).resolves.toBeUndefined();

    expect(h.detectForAsset.mock.calls).toEqual([
      ['tenant-a', 'a-001'],
      ['tenant-a', 'a-002'],
    ]);
  });

  it('swallows a failed poll so the interval callback never rejects', async () => {
    const h = buildHarness({});
    h.groupBy.mockRejectedValueOnce(new Error('db down'));
    await expect(h.worker.scanOnce()).resolves.toBeUndefined();
    expect(h.detectForAsset).not.toHaveBeenCalled();
  });

  it('skips a tenant whose cv module is disabled without burning any attempts', async () => {
    // While the cv gate is closed every attempt is a guaranteed
    // CV_MODULE_DISABLED failure, so the tenant must be skipped BEFORE
    // any asset is selected — otherwise the worker burns each asset's
    // single automatic attempt on a failure the tenant cannot influence.
    const h = buildHarness({
      'tenant-a': assets('a', 5, false),
      'tenant-b': assets('b', 1, false),
    });
    h.isEnabledForTenant.mockImplementation(
      async (tenantId) => tenantId !== 'tenant-a',
    );
    await h.worker.scanOnce();

    expect(h.isEnabledForTenant).toHaveBeenCalledWith('tenant-a', 'cv');
    // The gated tenant gets no asset queries and no attempts…
    for (const [args] of h.findManyAssets.mock.calls) {
      expect(args.where.tenantId).toBe('tenant-b');
    }
    // …and does not consume the cross-tenant per-scan budget either.
    expect(h.detectForAsset.mock.calls).toEqual([['tenant-b', 'b-001']]);
  });

  it('does not count a FAILED CV_MODULE_DISABLED job as an attempt', async () => {
    // A gate refusal is environmental, not a verdict on the asset: the
    // attempted lookup must exclude those jobs so the asset is auto
    // re-attempted once the tenant's cv module is enabled again.
    const h = buildHarness({ 'tenant-a': [{ id: 'a-1', attempted: false }] });
    await h.worker.scanOnce();

    expect(h.findManyJobs.mock.calls[0][0].where).toMatchObject({
      NOT: {
        status: InferenceJobStatus.FAILED,
        errorCode: CV_MODULE_DISABLED_ERROR_CODE,
      },
    });
  });

  it('backs off an asset that throws before a job exists instead of letting it starve the budget', async () => {
    jest.useFakeTimers({ now: new Date('2026-08-11T12:00:00Z') });
    try {
      const tenantAssets = assets('a', 3, false);
      const h = buildHarness({ 'tenant-a': tenantAssets });
      // a-001 fails BEFORE a job row exists (e.g. its store was deleted
      // after upload) — every other asset succeeds and, like production,
      // gains a job row that marks it attempted for later scans.
      h.detectForAsset.mockImplementation(async (_tenantId, videoAssetId) => {
        if (videoAssetId === 'a-001') {
          throw new Error('Store "loc-gone" not found');
        }
        const asset = tenantAssets.find((a) => a.id === videoAssetId);
        if (asset) {
          asset.attempted = true;
        }
      });

      await h.worker.scanOnce();
      expect(h.detectForAsset.mock.calls).toEqual([
        ['tenant-a', 'a-001'],
        ['tenant-a', 'a-002'],
      ]);

      // Next scan: a-001 is backing off and must not consume budget, so
      // the newer a-003 gets its attempt instead of being starved.
      h.detectForAsset.mockClear();
      await h.worker.scanOnce();
      expect(h.detectForAsset.mock.calls).toEqual([['tenant-a', 'a-003']]);

      // Once the backoff elapses the asset is retried, not abandoned.
      jest.setSystemTime(Date.now() + 61_000);
      h.detectForAsset.mockClear();
      await h.worker.scanOnce();
      expect(h.detectForAsset.mock.calls).toEqual([['tenant-a', 'a-001']]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('refuses to overlap scans (re-entrancy guard)', async () => {
    const h = buildHarness({});
    let release!: (value: never[]) => void;
    h.groupBy.mockImplementationOnce(
      () => new Promise<never[]>((resolve) => (release = resolve)),
    );
    const first = h.worker.scanOnce();
    await h.worker.scanOnce(); // returns immediately without querying
    expect(h.groupBy).toHaveBeenCalledTimes(1);
    release([]);
    await first;
  });
});
