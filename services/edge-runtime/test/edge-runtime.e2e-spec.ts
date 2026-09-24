import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { rm } from 'node:fs/promises';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { NodeIdentityService } from '../src/config/node-identity.service';
import { EDGE_STORE, EdgeStorePort } from '../src/store/edge-store.port';
import { OfflineDecisionService } from '../src/decisioning/offline-decision.service';
import { ReviewQueueService } from '../src/decisioning/review-queue.service';
import { LocalLedgerService } from '../src/ledger/local-ledger.service';
import { StructuredLogger } from '../src/logging/structured-logger';
import { CLOUD_CLIENT } from '../src/sync/cloud-client.port';
import { ConfigurationService } from '../src/sync/configuration.service';
import { SimulatedCloudClient } from '../src/sync/simulated-cloud-client.adapter';
import { SyncService } from '../src/sync/sync.service';
import { fakeConfig } from './helpers';

/**
 * The edge-first promise, end to end: the store keeps trading while the cloud
 * is unreachable, and everything it observed reaches the control plane once
 * connectivity returns.
 */
describe('edge runtime (e2e)', () => {
  let app: INestApplication;
  let root: string;
  let cloud: SimulatedCloudClient;

  beforeAll(async () => {
    // The store root comes from `test/setup-env.ts`: ConfigModule reads the
    // environment while `app.module.ts` is imported, which is before any hook
    // can run, so it cannot be set here.
    root = process.env.EDGE_STORE_ROOT ?? '';

    cloud = new SimulatedCloudClient();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CLOUD_CLIENT)
      .useValue(cloud)
      .compile();

    app = moduleRef.createNestApplication();
    const logger = app.get(StructuredLogger);
    logger.setSink(() => undefined);
    app.useLogger(logger);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  });

  it('reports health without disclosing anything about the store', async () => {
    const response = await request(app.getHttpServer()).get('/health').expect(200);
    expect(response.body).toEqual({
      status: 'ok',
      store: 'up',
      cloud: expect.stringMatching(/online|offline/),
    });
  });

  it('connects the configured devices at boot', async () => {
    const response = await request(app.getHttpServer()).get('/metrics').expect(200);
    expect(response.body.devices.map((device: { kind: string }) => device.kind)).toEqual(
      ['esl', 'scale'],
    );
  });

  it('refuses to reopen its store as a different tenant', async () => {
    // The node is already sealed. Re-provisioning the box to another retailer
    // without wiping the store must stop it, not resume the first tenant's
    // ledger under the second tenant's name.
    const store = app.get<EdgeStorePort>(EDGE_STORE);
    const foreign = new NodeIdentityService(
      store,
      fakeConfig({ EDGE_TENANT_ID: 'tenant-someone-else' }),
    );
    await expect(foreign.seal()).rejects.toThrow(/tenantId/);
    // The running node is unaffected and still knows who it is.
    expect(app.get(NodeIdentityService).current().tenantId).toBe('tenant-test');
  });

  it('keeps trading, reviewing and reconciling across an outage', async () => {
    const configuration = app.get(ConfigurationService);
    const decisions = app.get(OfflineDecisionService);
    const reviews = app.get(ReviewQueueService);
    const ledger = app.get(LocalLedgerService);
    const sync = app.get(SyncService);

    // The cloud has published a catalog and the node has it.
    cloud.publishConfiguration([
      {
        resourceType: 'PRODUCT',
        resourceId: 'sku-water',
        version: 1,
        payload: { name: 'Water 500ml' },
      },
    ]);
    await sync.runOnce(1_000);
    await expect(
      configuration.get('PRODUCT', 'sku-water'),
    ).resolves.not.toBeNull();

    await ledger.record({
      movementId: 'opening-count',
      type: 'RECEIPT',
      productId: 'sku-water',
      unitId: 'unit-1',
      quantityDelta: 6,
      occurredAt: '2026-09-16T08:00:00.000Z',
    });

    // The link goes down mid-morning.
    cloud.online = false;

    const confident = await decisions.ingest({
      proposalId: 'p-confident',
      type: 'PRODUCT_PICKUP',
      unitId: 'unit-1',
      productId: 'sku-water',
      quantity: 2,
      confidence: 0.94,
      occurredAt: '2026-09-16T10:00:00.000Z',
    });
    const unsure = await decisions.ingest({
      proposalId: 'p-unsure',
      type: 'PRODUCT_PICKUP',
      unitId: 'unit-1',
      productId: 'sku-water',
      quantity: 1,
      confidence: 0.31,
      occurredAt: '2026-09-16T10:05:00.000Z',
    });

    // Trading continued: the confident pick moved stock, the doubtful one did
    // not and is waiting for a person.
    expect(confident.outcome.decision).toBe('ACCEPT');
    expect(unsure.outcome.decision).toBe('REVIEW');
    await expect(ledger.stockFor('sku-water', 'unit-1')).resolves.toBe(4);
    await expect(reviews.pendingCount()).resolves.toBe(1);

    const offlinePass = await sync.runOnce(2_000);
    expect(offlinePass.connectivity).toBe('OFFLINE');

    // A member of staff clears the queue while still offline.
    await decisions.decideReview('p-unsure', true, 'operator-1');
    await expect(ledger.stockFor('sku-water', 'unit-1')).resolves.toBe(3);

    // The link comes back.
    cloud.online = true;
    let now = 10_000_000;
    for (let pass = 0; pass < 10; pass += 1) {
      now += 10_000_000;
      const outcome = await sync.runOnce(now);
      if (outcome.connectivity === 'ONLINE' && outcome.pendingAfter === 0) {
        break;
      }
    }

    const delivered = [...cloud.durable.keys()].sort();
    expect(delivered).toEqual(
      expect.arrayContaining([
        'proposal:p-confident',
        'proposal:p-unsure',
        'review:p-unsure',
        'movement:proposal:p-confident:movement',
        'movement:review:p-unsure:movement',
      ]),
    );

    const metrics = await request(app.getHttpServer()).get('/metrics').expect(200);
    expect(metrics.body).toMatchObject({
      connectivity: 'ONLINE',
      outboxPending: 0,
      reviewsPending: 0,
      proposalsObserved: 2,
    });
  });
});
