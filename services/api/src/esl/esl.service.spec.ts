import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  EslGatewayStatus,
  EslLabelStatus,
  EslUpdateErrorCode,
  EslUpdateJobStatus,
  EslUpdateTrigger,
} from '@prisma/client';
import { AuditEntry } from '../common/audit/audit-log.service';
import { PriceActivationHub } from '../pricing/price-activation.hub';
import { SimulatedEslAdapter } from './adapters/simulated-esl.adapter';
import { EslVendorRegistry } from './adapters/esl-vendor.registry';
import { contentHash } from './esl.logic';
import { EnqueueJobInput } from './esl.repository';
import { EslService } from './esl.service';
import { EslPushOutcome, EslPushRequest, EslVendorPort } from './ports';

const TENANT = 'tenant-1';
const OTHER_TENANT = 'tenant-2';
const ACTOR = { id: 'user-1', email: 'ops@tenant.test' };

interface LabelSeed {
  id: string;
  vendorLabelId: string;
  gatewayId?: string;
  productId?: string | null;
  status?: EslLabelStatus;
  renderedContentHash?: string | null;
}

function label(seed: LabelSeed) {
  return {
    id: seed.id,
    tenantId: TENANT,
    gatewayId: seed.gatewayId ?? 'gw-1',
    vendorLabelId: seed.vendorLabelId,
    productId: seed.productId === undefined ? 'prod-1' : seed.productId,
    cellAssignmentId: null,
    status: seed.status ?? EslLabelStatus.BOUND,
    batteryPercent: null,
    signalPercent: null,
    lastRenderedAt: null,
    renderedContentHash: seed.renderedContentHash ?? null,
    renderedVersionId: null,
    product:
      seed.productId === null
        ? null
        : { id: 'prod-1', sku: 'WATER-500', name: 'Drinking Water 500ml' },
    gateway: {
      id: seed.gatewayId ?? 'gw-1',
      code: 'STORE-01',
      vendorCode: 'SIMULATED',
      status: EslGatewayStatus.ACTIVE,
    },
    cellAssignment: null,
  };
}

function job(
  id: string,
  labelId: string,
  over: Partial<{ gatewayId: string; attempts: number; claimedAttempt: number }> = {},
) {
  return {
    id,
    tenantId: TENANT,
    labelId,
    gatewayId: over.gatewayId ?? 'gw-1',
    trigger: EslUpdateTrigger.PRICE_ACTIVATION,
    priceBookVersionId: 'ver-1',
    status: EslUpdateJobStatus.RUNNING,
    contentHash: 'stale',
    idempotencyKey: `activation:ver-1:${labelId}`,
    attempts: over.attempts ?? 1,
    claimedAttempt: over.claimedAttempt ?? 1,
    leaseExpiresAt: new Date(),
    nextAttemptAt: new Date(),
    lastErrorCode: null,
    lastErrorMessage: null,
    requestedAt: new Date(),
    startedAt: new Date(),
    finishedAt: null,
  };
}

const gateway = (over: Partial<{ status: EslGatewayStatus; vendorCode: string }> = {}) => ({
  id: 'gw-1',
  tenantId: TENANT,
  code: 'STORE-01',
  name: 'Store 1',
  vendorCode: over.vendorCode ?? 'SIMULATED',
  locationId: 'loc-1',
  status: over.status ?? EslGatewayStatus.ACTIVE,
  credentialRef: 'STORE_01_KEY',
  metadata: null,
  lastSeenAt: null,
  location: { id: 'loc-1', code: 'S1', name: 'Store 1' },
  _count: { labels: 1 },
});

const RESOLVED_PRICE = {
  unitPriceMinor: 250,
  currencyCode: 'AED',
  priceBookId: 'book-1',
  priceBookVersionId: 'ver-1',
};

const CURRENT_HASH = contentHash({
  sku: 'WATER-500',
  productName: 'Drinking Water 500ml',
  unitPriceMinor: 250,
  currencyCode: 'AED',
});

function harness(
  options: {
    labels?: ReturnType<typeof label>[];
    claimed?: ReturnType<typeof job>[];
    gatewayRow?: ReturnType<typeof gateway> | null;
    adapter?: EslVendorPort;
    price?: typeof RESOLVED_PRICE | null;
  } = {},
) {
  const labels = options.labels ?? [];
  const byId = new Map(labels.map((row) => [row.id, row]));
  const enqueued: EnqueueJobInput[][] = [];
  const completed: Array<{ jobId: string; attempt: number; render: unknown }> =
    [];
  const failed: Array<{
    jobId: string;
    attempt: number;
    code: EslUpdateErrorCode;
    message: string | null;
  }> = [];
  const tenantsSeen: string[] = [];
  const audits: AuditEntry[] = [];
  const seen: Array<{ id: string; status: EslGatewayStatus }> = [];

  const record = (tenantId: string) => {
    tenantsSeen.push(tenantId);
  };

  const repository = {
    maxAttempts: 3,
    createGateway: jest.fn(async (tenantId: string, _data, build) => {
      record(tenantId);
      const row = gateway();
      audits.push(build({ ...row }));
      return row;
    }),
    findGatewayById: jest.fn(async (tenantId: string) => {
      record(tenantId);
      return options.gatewayRow === undefined
        ? gateway()
        : options.gatewayRow;
    }),
    findLabelById: jest.fn(async (tenantId: string, id: string) => {
      record(tenantId);
      return byId.get(id) ?? null;
    }),
    findBoundLabelsForProducts: jest.fn(
      async (tenantId: string, productIds: string[]) => {
        record(tenantId);
        return productIds.length === 0
          ? []
          : labels.map((row) => ({
              id: row.id,
              gatewayId: row.gatewayId,
              productId: row.productId,
            }));
      },
    ),
    findAllBoundLabels: jest.fn(async (tenantId: string) => {
      record(tenantId);
      return labels;
    }),
    findLabelLocations: jest.fn(async (tenantId: string, ids: string[]) => {
      record(tenantId);
      return new Map(ids.map((id) => [id, 'loc-1']));
    }),
    enqueueJobs: jest.fn(async (tenantId: string, inputs: EnqueueJobInput[]) => {
      record(tenantId);
      enqueued.push(inputs);
      return inputs.length;
    }),
    reclaimExpired: jest.fn(async (tenantId: string) => {
      record(tenantId);
      return { requeued: 0, failed: 0 };
    }),
    claimBatch: jest.fn(async (tenantId: string) => {
      record(tenantId);
      return options.claimed ?? [];
    }),
    completeJob: jest.fn(
      async (
        tenantId: string,
        jobId: string,
        attempt: number,
        render: unknown,
        build,
      ) => {
        record(tenantId);
        completed.push({ jobId, attempt, render });
        const row = { ...job(jobId, 'lbl-1'), status: 'SUCCEEDED' as const };
        audits.push(build({ ...row }, { ...row }));
        return row;
      },
    ),
    failJob: jest.fn(
      async (
        tenantId: string,
        jobId: string,
        attempt: number,
        error: { code: EslUpdateErrorCode; message: string | null },
        build,
      ) => {
        record(tenantId);
        failed.push({ jobId, attempt, ...error });
        const row = { ...job(jobId, 'lbl-1'), status: 'FAILED' as const };
        audits.push(build({ ...row }, { ...row }));
        return row;
      },
    ),
    touchGatewaySeen: jest.fn(
      async (tenantId: string, id: string, status: EslGatewayStatus) => {
        record(tenantId);
        seen.push({ id, status });
      },
    ),
    updateLabel: jest.fn(async (tenantId: string, id: string, _data, build) => {
      record(tenantId);
      const row = byId.get(id) ?? label({ id, vendorLabelId: 'L' });
      audits.push(build({ ...row }, { ...row }));
      return row;
    }),
    upsertLabel: jest.fn(async (tenantId: string) => {
      record(tenantId);
      return labels[0];
    }),
  };

  const prices = {
    resolve: jest.fn(async () =>
      options.price === undefined ? RESOLVED_PRICE : options.price,
    ),
  };
  const registry = new EslVendorRegistry(new SimulatedEslAdapter());
  if (options.adapter) {
    jest
      .spyOn(registry, 'resolve')
      .mockImplementation((code) =>
        code.toUpperCase() === 'SIMULATED' ? options.adapter! : null,
      );
  }
  const hub = new PriceActivationHub();
  const service = new EslService(
    repository as never,
    prices as never,
    hub,
    registry,
  );
  return {
    service,
    repository,
    prices,
    hub,
    enqueued,
    completed,
    failed,
    audits,
    seen,
    tenantsSeen,
  };
}

/** An adapter whose batch behaviour a test dictates outright. */
function scriptedAdapter(
  push: (requests: readonly EslPushRequest[]) => EslPushOutcome[],
): EslVendorPort {
  return {
    vendorCode: 'SIMULATED',
    discoverLabels: jest.fn(async () => []),
    readHealth: jest.fn(async () => null),
    pushBatch: jest.fn(async (_ctx, requests) => push(requests)),
  } as unknown as EslVendorPort;
}

describe('price activation propagates to labels', () => {
  it('enqueues one job per bound label, keyed by the activation', async () => {
    const h = harness({
      labels: [
        label({ id: 'lbl-1', vendorLabelId: 'A' }),
        label({ id: 'lbl-2', vendorLabelId: 'B' }),
      ],
    });
    await h.service.onVersionActivated({
      tenantId: TENANT,
      priceBookId: 'book-1',
      priceBookVersionId: 'ver-9',
      locationId: 'loc-1',
      productIds: ['prod-1'],
    });
    expect(h.enqueued).toHaveLength(1);
    expect(h.enqueued[0].map((input) => input.idempotencyKey)).toEqual([
      'activation:ver-9:lbl-1',
      'activation:ver-9:lbl-2',
    ]);
    expect(h.enqueued[0][0].trigger).toBe(EslUpdateTrigger.PRICE_ACTIVATION);
  });

  it('restricts a location-scoped book to that location', async () => {
    const h = harness({ labels: [label({ id: 'lbl-1', vendorLabelId: 'A' })] });
    await h.service.onVersionActivated({
      tenantId: TENANT,
      priceBookId: 'book-1',
      priceBookVersionId: 'ver-9',
      locationId: 'loc-7',
      productIds: ['prod-1'],
    });
    expect(h.repository.findBoundLabelsForProducts).toHaveBeenCalledWith(
      TENANT,
      ['prod-1'],
      'loc-7',
    );
  });

  it('does nothing when no label shows an affected product', async () => {
    const h = harness({ labels: [] });
    await h.service.onVersionActivated({
      tenantId: TENANT,
      priceBookId: 'book-1',
      priceBookVersionId: 'ver-9',
      locationId: null,
      productIds: ['prod-1'],
    });
    expect(h.repository.enqueueJobs).not.toHaveBeenCalled();
  });

  it('is reachable through the hub a price activation publishes to', async () => {
    const h = harness({ labels: [label({ id: 'lbl-1', vendorLabelId: 'A' })] });
    h.service.onModuleInit();
    await h.hub.publish({
      tenantId: TENANT,
      priceBookId: 'book-1',
      priceBookVersionId: 'ver-9',
      locationId: null,
      productIds: ['prod-1'],
    });
    expect(h.enqueued).toHaveLength(1);
  });

  it('never lets a label failure escape into the price change', async () => {
    const h = harness({ labels: [label({ id: 'lbl-1', vendorLabelId: 'A' })] });
    h.repository.findBoundLabelsForProducts.mockRejectedValueOnce(
      new Error('database down'),
    );
    h.service.onModuleInit();
    await expect(
      h.hub.publish({
        tenantId: TENANT,
        priceBookId: 'book-1',
        priceBookVersionId: 'ver-9',
        locationId: null,
        productIds: ['prod-1'],
      }),
    ).resolves.toBeUndefined();
  });

  it('scopes every read and write to the tenant it was given', async () => {
    const h = harness({ labels: [label({ id: 'lbl-1', vendorLabelId: 'A' })] });
    await h.service.onVersionActivated({
      tenantId: OTHER_TENANT,
      priceBookId: 'book-1',
      priceBookVersionId: 'ver-9',
      locationId: null,
      productIds: ['prod-1'],
    });
    expect(h.tenantsSeen.length).toBeGreaterThan(0);
    expect(new Set(h.tenantsSeen)).toEqual(new Set([OTHER_TENANT]));
  });
});

describe('processing a batch of label updates', () => {
  it('pushes and records what the label now shows', async () => {
    const h = harness({
      labels: [label({ id: 'lbl-1', vendorLabelId: 'A' })],
      claimed: [job('job-1', 'lbl-1')],
    });
    const summary = await h.service.processBatch(TENANT);
    expect(summary.succeeded).toBe(1);
    expect(h.completed[0].render).toMatchObject({
      contentHash: CURRENT_HASH,
      priceBookVersionId: 'ver-1',
    });
  });

  it('pushes the price in force NOW, not the one queued earlier', async () => {
    // The job was queued with contentHash 'stale'; the push must carry the
    // current price, and the label must record the current hash.
    const h = harness({
      labels: [label({ id: 'lbl-1', vendorLabelId: 'A' })],
      claimed: [job('job-1', 'lbl-1')],
    });
    await h.service.processBatch(TENANT);
    expect(h.completed[0].render).toMatchObject({ contentHash: CURRENT_HASH });
  });

  it('treats an already-correct label as success without pushing', async () => {
    const adapter = scriptedAdapter(() => []);
    const h = harness({
      labels: [
        label({
          id: 'lbl-1',
          vendorLabelId: 'A',
          renderedContentHash: CURRENT_HASH,
        }),
      ],
      claimed: [job('job-1', 'lbl-1')],
      adapter,
    });
    const summary = await h.service.processBatch(TENANT);
    expect(summary.succeeded).toBe(1);
    expect(h.completed[0].render).toBeNull();
    expect(adapter.pushBatch).not.toHaveBeenCalled();
  });

  it('fences each transition with the attempt the worker claimed', async () => {
    const h = harness({
      labels: [label({ id: 'lbl-1', vendorLabelId: 'A' })],
      claimed: [job('job-1', 'lbl-1', { attempts: 2, claimedAttempt: 2 })],
    });
    await h.service.processBatch(TENANT);
    expect(h.completed[0].attempt).toBe(2);
  });

  it('fails one label without touching the others', async () => {
    const h = harness({
      labels: [
        label({ id: 'lbl-1', vendorLabelId: 'GOOD' }),
        label({ id: 'lbl-2', vendorLabelId: 'BAD-REJECT' }),
        label({ id: 'lbl-3', vendorLabelId: 'ALSO-GOOD' }),
      ],
      claimed: [
        job('job-1', 'lbl-1'),
        job('job-2', 'lbl-2'),
        job('job-3', 'lbl-3'),
      ],
    });
    const summary = await h.service.processBatch(TENANT);
    expect(summary.succeeded).toBe(2);
    expect(h.failed).toHaveLength(1);
    expect(h.failed[0]).toMatchObject({
      jobId: 'job-2',
      code: EslUpdateErrorCode.VENDOR_REJECTED,
    });
  });

  it('retries every label when the gateway itself throws', async () => {
    const adapter = scriptedAdapter(() => {
      throw new Error('connection refused to 10.0.0.5:8080');
    });
    const h = harness({
      labels: [
        label({ id: 'lbl-1', vendorLabelId: 'A' }),
        label({ id: 'lbl-2', vendorLabelId: 'B' }),
      ],
      claimed: [job('job-1', 'lbl-1'), job('job-2', 'lbl-2')],
      adapter,
    });
    await h.service.processBatch(TENANT);
    expect(h.failed.map((entry) => entry.code)).toEqual([
      EslUpdateErrorCode.GATEWAY_UNREACHABLE,
      EslUpdateErrorCode.GATEWAY_UNREACHABLE,
    ]);
    expect(h.seen).toContainEqual({
      id: 'gw-1',
      status: EslGatewayStatus.UNREACHABLE,
    });
  });

  it('never writes the gateway address a thrown error carried', async () => {
    const adapter = scriptedAdapter(() => {
      throw new Error('connection refused to 10.0.0.5:8080');
    });
    const h = harness({
      labels: [label({ id: 'lbl-1', vendorLabelId: 'A' })],
      claimed: [job('job-1', 'lbl-1')],
      adapter,
    });
    await h.service.processBatch(TENANT);
    expect(h.failed[0].message).toBeNull();
  });

  it('drops a vendor message that carries a credential', async () => {
    const adapter = scriptedAdapter((requests) =>
      requests.map((request) => ({
        vendorLabelId: request.vendorLabelId,
        ok: false as const,
        errorCode: EslUpdateErrorCode.VENDOR_REJECTED,
        message: 'rejected: api_key=sk_' + 'live_4eC39HqLyjWDarjtT1zdp7dc',
      })),
    );
    const h = harness({
      labels: [label({ id: 'lbl-1', vendorLabelId: 'A' })],
      claimed: [job('job-1', 'lbl-1')],
      adapter,
    });
    await h.service.processBatch(TENANT);
    expect(h.failed[0].message).toBeNull();
  });

  it('keeps a harmless vendor message for the operator', async () => {
    const adapter = scriptedAdapter((requests) =>
      requests.map((request) => ({
        vendorLabelId: request.vendorLabelId,
        ok: false as const,
        errorCode: EslUpdateErrorCode.VENDOR_REJECTED,
        message: 'display buffer too small',
      })),
    );
    const h = harness({
      labels: [label({ id: 'lbl-1', vendorLabelId: 'A' })],
      claimed: [job('job-1', 'lbl-1')],
      adapter,
    });
    await h.service.processBatch(TENANT);
    expect(h.failed[0].message).toBe('display buffer too small');
  });

  it('retries a label the adapter did not answer for', async () => {
    const adapter = scriptedAdapter((requests) =>
      requests
        .slice(0, 1)
        .map((request) => ({ vendorLabelId: request.vendorLabelId, ok: true })),
    );
    const h = harness({
      labels: [
        label({ id: 'lbl-1', vendorLabelId: 'A' }),
        label({ id: 'lbl-2', vendorLabelId: 'B' }),
      ],
      claimed: [job('job-1', 'lbl-1'), job('job-2', 'lbl-2')],
      adapter,
    });
    await h.service.processBatch(TENANT);
    expect(h.failed).toEqual([
      expect.objectContaining({
        jobId: 'job-2',
        code: EslUpdateErrorCode.VENDOR_TIMEOUT,
      }),
    ]);
  });

  it('pushes once for a label carrying two jobs, and finishes both', async () => {
    // A binding and an activation can both be QUEUED for one label and be
    // claimed in the same pass. They want identical content, so the label is
    // pushed once — but BOTH jobs must reach a terminal state, or the extra
    // one sits RUNNING until its lease expires.
    const adapter = scriptedAdapter((requests) =>
      requests.map((request) => ({
        vendorLabelId: request.vendorLabelId,
        ok: true as const,
      })),
    );
    const h = harness({
      labels: [label({ id: 'lbl-1', vendorLabelId: 'A' })],
      claimed: [job('job-1', 'lbl-1'), job('job-2', 'lbl-1')],
      adapter,
    });
    const summary = await h.service.processBatch(TENANT);
    expect(
      (adapter.pushBatch as jest.Mock).mock.calls[0][1],
    ).toHaveLength(1);
    expect(h.completed.map((entry) => entry.jobId)).toEqual([
      'job-1',
      'job-2',
    ]);
    expect(summary.succeeded).toBe(2);
    expect(h.failed).toEqual([]);
  });

  it('never writes an outcome twice when the adapter answers twice', async () => {
    const adapter = scriptedAdapter((requests) => [
      { vendorLabelId: requests[0].vendorLabelId, ok: true as const },
      {
        vendorLabelId: requests[0].vendorLabelId,
        ok: false as const,
        errorCode: EslUpdateErrorCode.VENDOR_REJECTED,
      },
    ]);
    const h = harness({
      labels: [label({ id: 'lbl-1', vendorLabelId: 'A' })],
      claimed: [job('job-1', 'lbl-1')],
      adapter,
    });
    await h.service.processBatch(TENANT);
    expect(h.completed).toHaveLength(1);
    expect(h.failed).toEqual([]);
  });

  it('fails a job whose gateway was disabled under it', async () => {
    const h = harness({
      labels: [label({ id: 'lbl-1', vendorLabelId: 'A' })],
      claimed: [job('job-1', 'lbl-1')],
      gatewayRow: gateway({ status: EslGatewayStatus.DISABLED }),
    });
    await h.service.processBatch(TENANT);
    expect(h.failed[0].code).toBe(EslUpdateErrorCode.GATEWAY_DISABLED);
  });

  it('fails a job whose gateway names a vendor nothing implements', async () => {
    const h = harness({
      labels: [label({ id: 'lbl-1', vendorLabelId: 'A' })],
      claimed: [job('job-1', 'lbl-1')],
      gatewayRow: gateway({ vendorCode: 'ACME' }),
    });
    await h.service.processBatch(TENANT);
    expect(h.failed[0].code).toBe(EslUpdateErrorCode.UNKNOWN_VENDOR);
  });

  it('fails a job for a label that has no resolvable price', async () => {
    const h = harness({
      labels: [label({ id: 'lbl-1', vendorLabelId: 'A' })],
      claimed: [job('job-1', 'lbl-1')],
      price: null,
    });
    await h.service.processBatch(TENANT);
    expect(h.failed[0].code).toBe(EslUpdateErrorCode.CONTENT_UNRESOLVABLE);
  });

  it('fails a job for a label retired since it was queued', async () => {
    const h = harness({
      labels: [
        label({
          id: 'lbl-1',
          vendorLabelId: 'A',
          status: EslLabelStatus.RETIRED,
        }),
      ],
      claimed: [job('job-1', 'lbl-1')],
    });
    await h.service.processBatch(TENANT);
    expect(h.failed[0].code).toBe(EslUpdateErrorCode.LABEL_RETIRED);
  });

  it('recovers stranded work before claiming', async () => {
    const h = harness({ claimed: [] });
    h.repository.reclaimExpired.mockResolvedValueOnce({
      requeued: 2,
      failed: 1,
    });
    const summary = await h.service.processBatch(TENANT);
    expect(summary.leaseReclaimed).toBe(2);
    expect(summary.leaseFailed).toBe(1);
  });
});

describe('reconciliation repairs drift', () => {
  it('queues only the labels showing the wrong thing', async () => {
    const h = harness({
      labels: [
        label({
          id: 'lbl-current',
          vendorLabelId: 'A',
          renderedContentHash: CURRENT_HASH,
        }),
        label({
          id: 'lbl-stale',
          vendorLabelId: 'B',
          renderedContentHash: 'something-else',
        }),
      ],
    });
    const result = await h.service.reconcile(TENANT, ACTOR);
    expect(result.inspected).toBe(2);
    expect(h.enqueued[0].map((input) => input.labelId)).toEqual(['lbl-stale']);
    expect(h.enqueued[0][0].trigger).toBe(EslUpdateTrigger.RECONCILIATION);
  });

  it('is idempotent across sweeps that see the same drift', async () => {
    const h = harness({
      labels: [
        label({
          id: 'lbl-stale',
          vendorLabelId: 'B',
          renderedContentHash: 'something-else',
        }),
      ],
    });
    await h.service.reconcile(TENANT, ACTOR);
    await h.service.reconcile(TENANT, ACTOR);
    expect(h.enqueued[0][0].idempotencyKey).toBe(
      h.enqueued[1][0].idempotencyKey,
    );
  });
});

describe('operator actions on labels', () => {
  it('refuses to render a label with nothing bound to it', async () => {
    const h = harness({
      labels: [
        label({
          id: 'lbl-1',
          vendorLabelId: 'A',
          productId: null,
          status: EslLabelStatus.UNBOUND,
        }),
      ],
    });
    await expect(
      h.service.requestRender(TENANT, 'lbl-1', ACTOR),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('never de-duplicates two operator re-render requests', async () => {
    const h = harness({ labels: [label({ id: 'lbl-1', vendorLabelId: 'A' })] });
    await h.service.requestRender(TENANT, 'lbl-1', ACTOR);
    await h.service.requestRender(TENANT, 'lbl-1', ACTOR);
    expect(h.enqueued[0][0].idempotencyKey).not.toBe(
      h.enqueued[1][0].idempotencyKey,
    );
  });

  it('queues a render as soon as a product is bound', async () => {
    const h = harness({ labels: [label({ id: 'lbl-1', vendorLabelId: 'A' })] });
    await h.service.updateLabel(TENANT, 'lbl-1', { productId: 'prod-1' }, ACTOR);
    expect(h.enqueued[0][0].trigger).toBe(EslUpdateTrigger.LABEL_BOUND);
  });
});

describe('credentials never enter the platform', () => {
  const base = {
    code: 'S1',
    name: 'Store 1',
    vendorCode: 'SIMULATED',
    locationId: 'loc-1',
  };

  it('rejects a credentialRef that is itself a credential', async () => {
    const h = harness();
    await expect(
      h.service.createGateway(
        TENANT,
        { ...base, credentialRef: 'sk_' + 'live_4eC39HqLyjWDarjtT1zdp7dc' },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts an opaque configuration key', async () => {
    const h = harness();
    await expect(
      h.service.createGateway(
        TENANT,
        { ...base, credentialRef: 'ACME_STORE_01' },
        ACTOR,
      ),
    ).resolves.toBeDefined();
  });

  it('rejects metadata carrying a credential-shaped key', async () => {
    const h = harness();
    await expect(
      h.service.createGateway(
        TENANT,
        { ...base, metadata: { apiKey: 'anything' } },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an unknown vendor at registration rather than at push time', async () => {
    const h = harness();
    await expect(
      h.service.createGateway(TENANT, { ...base, vendorCode: 'ACME' }, ACTOR),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('keeps credentialRef out of the audit trail', async () => {
    const h = harness();
    await h.service.createGateway(
      TENANT,
      { ...base, credentialRef: 'ACME_STORE_01' },
      ACTOR,
    );
    const entry = h.audits.find((audit) => audit.entityType === 'EslGateway');
    expect(entry).toBeDefined();
    expect(JSON.stringify(entry?.after)).not.toContain('ACME_STORE_01');
    expect(entry?.after).toMatchObject({ hasCredentialRef: true });
  });
});
