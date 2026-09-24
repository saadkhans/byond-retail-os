import {
  EslGatewayStatus,
  EslLabelStatus,
  EslUpdateJobStatus,
  PriceBookVersionStatus,
  PriceChangeReason,
} from '@prisma/client';
import { PriceActivationHub } from '../pricing/price-activation.hub';
import { PricingService } from '../pricing/pricing.service';
import { EslVendorRegistry } from './adapters/esl-vendor.registry';
import { SimulatedEslAdapter } from './adapters/simulated-esl.adapter';
import { contentHash } from './esl.logic';
import { EnqueueJobInput } from './esl.repository';
import { EslService } from './esl.service';
import { EslLabelContent } from './ports';

/**
 * The end-to-end journey TESTING.md names: "admin price change → ESL update".
 *
 * Everything across the seam is REAL — the pricing service, the activation
 * hub, the ESL service, the vendor registry and the simulated adapter. Only
 * the two repositories are doubled, so the test proves the wiring rather than
 * Prisma. A change here that silently stops labels following prices fails
 * this test, which is the whole point of having it.
 */

const TENANT = 'tenant-1';
const ACTOR = { id: 'user-1', email: 'ops@tenant.test' };

const PRODUCT = { id: 'prod-1', sku: 'WATER-500', name: 'Drinking Water 500ml' };

function priceBookVersion(id: string) {
  return {
    id,
    tenantId: TENANT,
    priceBookId: 'book-1',
    versionNumber: 2,
    status: PriceBookVersionStatus.ACTIVE,
    effectiveFrom: new Date('2026-09-16T00:00:00.000Z'),
    effectiveTo: null,
    reason: PriceChangeReason.PRICE_CHANGE,
    note: null,
    createdById: ACTOR.id,
    activatedById: ACTOR.id,
    activatedAt: new Date(),
    supersededByVersionId: null,
    rolledBackFromVersionId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function label(id: string, vendorLabelId: string) {
  return {
    id,
    tenantId: TENANT,
    gatewayId: 'gw-1',
    vendorLabelId,
    productId: PRODUCT.id,
    cellAssignmentId: null,
    status: EslLabelStatus.BOUND,
    batteryPercent: null,
    signalPercent: null,
    lastRenderedAt: null,
    renderedContentHash: null as string | null,
    renderedVersionId: null as string | null,
    product: PRODUCT,
    gateway: {
      id: 'gw-1',
      code: 'STORE-01',
      vendorCode: 'SIMULATED',
      status: EslGatewayStatus.ACTIVE,
    },
    cellAssignment: null,
  };
}

function stack(options: { vendorLabelIds?: string[]; priceMinor?: number } = {}) {
  const ids = options.vendorLabelIds ?? ['SHELF-A1'];
  const labels = ids.map((vendorLabelId, index) =>
    label(`lbl-${index + 1}`, vendorLabelId),
  );
  const byId = new Map(labels.map((row) => [row.id, row]));
  let price = {
    unitPriceMinor: options.priceMinor ?? 250,
    currencyCode: 'AED',
    priceBookId: 'book-1',
    priceBookVersionId: 'ver-2',
  };

  // --- pricing side -------------------------------------------------------
  const pricingRepository = {
    activateVersion: jest.fn(
      async (
        _tenantId: string,
        _bookId: string,
        versionId: string,
        _data: unknown,
        builders: { activated: (a: unknown, b: unknown) => unknown },
      ) => {
        const version = priceBookVersion(versionId);
        builders.activated(version, version);
        return version;
      },
    ),
    rollbackToVersion: jest.fn(
      async (
        _tenantId: string,
        _bookId: string,
        _versionId: string,
        _data: unknown,
        builders: {
          created: (v: unknown) => unknown;
          activated: (a: unknown, b: unknown) => unknown;
        },
      ) => {
        const version = priceBookVersion('ver-3');
        builders.created(version);
        builders.activated(version, version);
        return version;
      },
    ),
    findActivationFacts: jest.fn(async () => ({
      locationId: 'loc-1',
      productIds: [PRODUCT.id],
    })),
  };
  const resolution = {
    resolve: jest.fn(async () => price),
  };
  const hub = new PriceActivationHub();
  const pricing = new PricingService(
    pricingRepository as never,
    resolution as never,
    hub,
  );

  // --- ESL side -----------------------------------------------------------
  const queue: Array<
    EnqueueJobInput & { id: string; attempts: number; claimedAttempt: number }
  > = [];
  const keys = new Set<string>();
  /** jobId → labelId, so completeJob can find the label it rendered. */
  const jobLabels = new Map<string, string>();
  const pushed: Array<{ vendorLabelId: string; content: EslLabelContent }> = [];

  const eslRepository = {
    maxAttempts: 3,
    findBoundLabelsForProducts: jest.fn(async () =>
      labels.map((row) => ({
        id: row.id,
        gatewayId: row.gatewayId,
        productId: row.productId,
      })),
    ),
    findLabelById: jest.fn(async (_tenantId: string, id: string) =>
      byId.get(id) ?? null,
    ),
    findAllBoundLabels: jest.fn(async () => labels),
    findLabelLocations: jest.fn(
      async (_tenantId: string, labelIds: string[]) =>
        new Map(labelIds.map((id) => [id, 'loc-1'])),
    ),
    enqueueJobs: jest.fn(async (_tenantId: string, inputs: EnqueueJobInput[]) => {
      let added = 0;
      for (const input of inputs) {
        // Mirrors the unique (tenantId, idempotencyKey) index.
        if (keys.has(input.idempotencyKey)) {
          continue;
        }
        keys.add(input.idempotencyKey);
        const id = `job-${jobLabels.size + 1}`;
        jobLabels.set(id, input.labelId);
        queue.push({ ...input, id, attempts: 0, claimedAttempt: 0 });
        added += 1;
      }
      return added;
    }),
    reclaimExpired: jest.fn(async () => ({ requeued: 0, failed: 0 })),
    claimBatch: jest.fn(async () => {
      const claimed = queue.splice(0, queue.length);
      return claimed.map((entry) => ({
        ...entry,
        status: EslUpdateJobStatus.RUNNING,
        attempts: entry.attempts + 1,
        claimedAttempt: entry.attempts + 1,
      }));
    }),
    findGatewayById: jest.fn(async () => ({
      id: 'gw-1',
      tenantId: TENANT,
      code: 'STORE-01',
      name: 'Store 1',
      vendorCode: 'SIMULATED',
      locationId: 'loc-1',
      status: EslGatewayStatus.ACTIVE,
      credentialRef: 'STORE_01_KEY',
      metadata: null,
      lastSeenAt: null,
      location: { id: 'loc-1', code: 'S1', name: 'Store 1' },
      _count: { labels: labels.length },
    })),
    completeJob: jest.fn(
      async (
        _tenantId: string,
        jobId: string,
        _attempt: number,
        render: {
          contentHash: string;
          priceBookVersionId: string | null;
        } | null,
      ) => {
        // Writing the label's rendered state here mirrors the real
        // repository, which does it inside the job's own transaction.
        const target = byId.get(jobLabels.get(jobId) ?? '');
        if (render && target) {
          target.renderedContentHash = render.contentHash;
          target.renderedVersionId = render.priceBookVersionId;
        }
        return { id: jobId, status: 'SUCCEEDED' };
      },
    ),
    // Mirrors the real repository: a failure requeues while attempts remain
    // and only FAILS once the budget is spent.
    failJob: jest.fn(async (_t: string, jobId: string, attempt: number) => ({
      id: jobId,
      status: attempt >= 3 ? 'FAILED' : 'QUEUED',
    })),
    touchGatewaySeen: jest.fn(async () => undefined),
  };

  const adapter = new SimulatedEslAdapter();
  const originalPush = adapter.pushBatch.bind(adapter);
  jest.spyOn(adapter, 'pushBatch').mockImplementation(async (ctx, requests) => {
    for (const request of requests) {
      pushed.push({
        vendorLabelId: request.vendorLabelId,
        content: request.content,
      });
    }
    return originalPush(ctx, requests);
  });
  const registry = new EslVendorRegistry(adapter);
  const esl = new EslService(
    eslRepository as never,
    resolution as never,
    hub,
    registry,
  );
  esl.onModuleInit();

  return {
    pricing,
    esl,
    hub,
    labels,
    pushed,
    queue,
    eslRepository,
    setPrice: (minor: number) => {
      price = { ...price, unitPriceMinor: minor };
    },
  };
}

describe('admin price change reaches the shelf label', () => {
  it('activating a version renders the new price on the bound label', async () => {
    const s = stack();
    s.setPrice(275);

    await s.pricing.activateVersion(
      TENANT,
      'book-1',
      'ver-2',
      {} as never,
      ACTOR,
    );

    // The activation queued exactly one push for the one bound label.
    expect(s.eslRepository.enqueueJobs).toHaveBeenCalledTimes(1);

    const summary = await s.esl.processBatch(TENANT);
    expect(summary.succeeded).toBe(1);

    // The vendor was handed the NEW price, with the product it identifies.
    expect(s.pushed).toEqual([
      {
        vendorLabelId: 'SHELF-A1',
        content: {
          sku: 'WATER-500',
          productName: 'Drinking Water 500ml',
          unitPriceMinor: 275,
          currencyCode: 'AED',
        },
      },
    ]);

    // And the label now records what it is showing.
    expect(s.labels[0].renderedContentHash).toBe(
      contentHash({
        sku: 'WATER-500',
        productName: 'Drinking Water 500ml',
        unitPriceMinor: 275,
        currencyCode: 'AED',
      }),
    );
    expect(s.labels[0].renderedVersionId).toBe('ver-2');
  });

  it('a rollback propagates too — the shelf follows the price back', async () => {
    const s = stack();
    s.setPrice(275);
    await s.pricing.activateVersion(TENANT, 'book-1', 'ver-2', {} as never, ACTOR);
    await s.esl.processBatch(TENANT);

    s.setPrice(250);
    await s.pricing.rollbackToVersion(
      TENANT,
      'book-1',
      'ver-1',
      {} as never,
      ACTOR,
    );
    await s.esl.processBatch(TENANT);

    expect(s.pushed.map((entry) => entry.content.unitPriceMinor)).toEqual([
      275, 250,
    ]);
  });

  it('replaying the same activation pushes once, not twice', async () => {
    const s = stack();
    await s.pricing.activateVersion(TENANT, 'book-1', 'ver-2', {} as never, ACTOR);
    await s.pricing.activateVersion(TENANT, 'book-1', 'ver-2', {} as never, ACTOR);
    await s.esl.processBatch(TENANT);
    expect(s.pushed).toHaveLength(1);
  });

  it('one unreachable label does not stop the rest of the shelf updating', async () => {
    const s = stack({
      vendorLabelIds: ['SHELF-A1', 'SHELF-A2-UNREACHABLE', 'SHELF-A3'],
    });
    await s.pricing.activateVersion(TENANT, 'book-1', 'ver-2', {} as never, ACTOR);
    const summary = await s.esl.processBatch(TENANT);
    expect(summary.succeeded).toBe(2);
    expect(summary.requeued).toBe(1);
  });

  it('a price change the listener missed is repaired by reconciliation', async () => {
    const s = stack();
    // Simulate the listener being unavailable at activation time.
    s.eslRepository.findBoundLabelsForProducts.mockRejectedValueOnce(
      new Error('listener unavailable'),
    );
    s.setPrice(275);
    await s.pricing.activateVersion(TENANT, 'book-1', 'ver-2', {} as never, ACTOR);
    expect(s.pushed).toHaveLength(0);

    await s.esl.reconcile(TENANT, ACTOR);
    await s.esl.processBatch(TENANT);
    expect(s.pushed.map((entry) => entry.content.unitPriceMinor)).toEqual([275]);
  });

  it('a failed label push never fails the price change itself', async () => {
    const s = stack();
    s.eslRepository.findBoundLabelsForProducts.mockRejectedValueOnce(
      new Error('database down'),
    );
    await expect(
      s.pricing.activateVersion(TENANT, 'book-1', 'ver-2', {} as never, ACTOR),
    ).resolves.toMatchObject({ id: 'ver-2' });
  });
});
