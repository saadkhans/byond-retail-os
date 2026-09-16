import {
  fakeConfig,
  sealedIdentity,
  silentLogger,
  temporaryStore,
} from '../../test/helpers';
import { ReviewQueueService } from '../decisioning/review-queue.service';
import { DriverRegistryService } from '../hardware/driver-registry.service';
import {
  SIMULATED_DRIVER_FACTORIES,
  SimulatedScaleDriver,
} from '../hardware/drivers/simulated-drivers';
import { LOGS } from '../store/store-names';
import { ConfigurationService } from '../sync/configuration.service';
import { OutboxService } from '../sync/outbox.service';
import { SimulatedCloudClient } from '../sync/simulated-cloud-client.adapter';
import { SyncService } from '../sync/sync.service';
import { MetricsService } from './metrics.service';

describe('MetricsService', () => {
  let context: Awaited<ReturnType<typeof temporaryStore>>;
  let metrics: MetricsService;
  let outbox: OutboxService;
  let drivers: DriverRegistryService;
  let sync: SyncService;
  let cloud: SimulatedCloudClient;

  beforeEach(async () => {
    context = await temporaryStore();
    const config = fakeConfig();
    cloud = new SimulatedCloudClient();
    outbox = new OutboxService(context.store, config);
    const reviews = new ReviewQueueService(context.store);
    drivers = new DriverRegistryService(
      SIMULATED_DRIVER_FACTORIES,
      config,
      outbox,
      silentLogger(),
    );
    sync = new SyncService(
      cloud,
      outbox,
      new ConfigurationService(context.store, await sealedIdentity(context.store)),
      config,
      silentLogger(),
    );
    metrics = new MetricsService(context.store, sync, outbox, reviews, drivers);
  });

  afterEach(async () => {
    sync.stop();
    await context.cleanup();
  });

  it('starts offline with everything at zero', async () => {
    await expect(metrics.snapshot()).resolves.toEqual({
      connectivity: 'OFFLINE',
      lastSyncAt: null,
      outboxPending: 0,
      deadLetters: 0,
      conflicts: 0,
      ledgerEntries: 0,
      proposalsObserved: 0,
      reviewsPending: 0,
      devices: [],
    });
  });

  it('counts pending work and reports connectivity after a sync', async () => {
    await outbox.enqueue({
      type: 'INVENTORY_MOVEMENT',
      idempotencyKey: 'm-1',
      occurredAt: '2026-09-16T10:00:00.000Z',
      payload: {},
    });
    await context.store.append(LOGS.ledger, { movementId: 'm-1' });
    await context.store.append(LOGS.proposals, { proposalId: 'p-1' });

    const before = await metrics.snapshot();
    expect(before).toMatchObject({
      outboxPending: 1,
      ledgerEntries: 1,
      proposalsObserved: 1,
      connectivity: 'OFFLINE',
    });

    await sync.runOnce(1_000);
    const after = await metrics.snapshot();
    expect(after.connectivity).toBe('ONLINE');
    expect(after.outboxPending).toBe(0);
    expect(after.lastSyncAt).not.toBeNull();
  });

  it('includes device health', async () => {
    drivers.register(new SimulatedScaleDriver('scale-1'));
    await drivers.connectAll();
    const snapshot = await metrics.snapshot();
    expect(snapshot.devices).toHaveLength(1);
    expect(snapshot.devices[0]).toMatchObject({
      kind: 'scale',
      state: 'CONNECTED',
      adapterKey: 'simulated',
    });
  });

  it('surfaces dead letters and conflicts rather than hiding them', async () => {
    cloud.rejectKeys.add('bad');
    await outbox.enqueue({
      type: 'INVENTORY_MOVEMENT',
      idempotencyKey: 'bad',
      occurredAt: '2026-09-16T10:00:00.000Z',
      payload: {},
    });
    await sync.runOnce(1_000);
    const snapshot = await metrics.snapshot();
    expect(snapshot.deadLetters).toBe(1);
    expect(snapshot.conflicts).toBe(1);
  });
});
