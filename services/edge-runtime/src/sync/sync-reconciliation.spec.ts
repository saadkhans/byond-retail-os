import {
  fakeConfig,
  sealedIdentity,
  silentLogger,
  temporaryStore,
} from '../../test/helpers';
import { ConfigurationService } from './configuration.service';
import { OutboxService } from './outbox.service';
import { SimulatedCloudClient } from './simulated-cloud-client.adapter';
import { SyncService } from './sync.service';
import { InboxEntry, OutboxOperation } from './sync.types';

/**
 * Reconciliation on reconnect must be convergent: however many times a batch
 * is replayed, and wherever a crash interrupts it, the cloud ends up holding
 * each fact exactly once and the node ends up holding the cloud's latest
 * configuration exactly once.
 */
describe('sync reconciliation', () => {
  let context: Awaited<ReturnType<typeof temporaryStore>>;
  let cloud: SimulatedCloudClient;
  let identity: Awaited<ReturnType<typeof sealedIdentity>>;

  const config = fakeConfig({
    EDGE_SYNC_BATCH_SIZE: 5,
    EDGE_SYNC_MAX_ATTEMPTS: 10,
    EDGE_SYNC_BACKOFF_BASE_MS: 10,
    EDGE_SYNC_BACKOFF_MAX_MS: 10,
  });

  function build(): {
    outbox: OutboxService;
    configuration: ConfigurationService;
    sync: SyncService;
  } {
    const outbox = new OutboxService(context.store, config);
    const configuration = new ConfigurationService(context.store, identity);
    const sync = new SyncService(
      cloud,
      outbox,
      configuration,
      config,
      silentLogger(),
    );
    return { outbox, configuration, sync };
  }

  function movement(index: number): OutboxOperation {
    return {
      type: 'INVENTORY_MOVEMENT',
      idempotencyKey: `movement:${index}`,
      occurredAt: '2026-09-16T10:00:00.000Z',
      payload: { movementId: String(index) },
    };
  }

  beforeEach(async () => {
    context = await temporaryStore();
    cloud = new SimulatedCloudClient();
    identity = await sealedIdentity(context.store);
  });

  afterEach(async () => {
    await context.cleanup();
  });

  it('delivers a backlog accumulated offline once connectivity returns', async () => {
    const { outbox, sync } = build();
    cloud.online = false;
    for (let index = 0; index < 12; index += 1) {
      await outbox.enqueue(movement(index));
    }
    await sync.runOnce(0);
    await expect(outbox.pendingCount()).resolves.toBe(12);

    cloud.online = true;
    let now = 1_000_000;
    while ((await outbox.pendingCount()) > 0) {
      now += 1_000_000;
      await sync.runOnce(now);
    }
    expect(cloud.durable.size).toBe(12);
  });

  it('holds each fact exactly once even though the crash replays the batch', async () => {
    const first = build();
    for (let index = 0; index < 5; index += 1) {
      await first.outbox.enqueue(movement(index));
    }

    // The cloud accepts the batch, then the node dies before the acknowledgement
    // is persisted. Restarting re-sends the same batch.
    const batch = await first.outbox.nextBatch();
    await cloud.pushOperations(batch);

    const restarted = build();
    let now = 1_000;
    while ((await restarted.outbox.pendingCount()) > 0) {
      now += 1_000_000;
      await restarted.sync.runOnce(now);
    }

    // Delivered twice, held once — that is what the idempotency key buys.
    expect(cloud.received.length).toBeGreaterThan(5);
    expect(cloud.durable.size).toBe(5);
    await expect(restarted.outbox.pendingCount()).resolves.toBe(0);
  });

  it('converges on the cloud configuration however often the batch replays', async () => {
    const entries: InboxEntry[] = [
      {
        resourceType: 'PRODUCT',
        resourceId: 'sku-water',
        version: 1,
        payload: { name: 'Water' },
      },
      {
        resourceType: 'PRODUCT',
        resourceId: 'sku-water',
        version: 2,
        payload: { name: 'Water 500ml' },
      },
      {
        resourceType: 'UNIT',
        resourceId: 'unit-1',
        version: 3,
        payload: { code: 'R1' },
      },
    ];
    cloud.publishConfiguration(entries);

    const { configuration, sync } = build();
    await sync.runOnce(1_000);
    const afterFirst = await configuration.all();

    // A second and third pass pull nothing new; applying the same entries again
    // by hand is also a no-op.
    await sync.runOnce(2_000_000);
    await configuration.apply(entries);
    const afterReplays = await configuration.all();

    expect(afterReplays).toEqual(afterFirst);
    await expect(configuration.get('PRODUCT', 'sku-water')).resolves.toMatchObject(
      { version: 2, payload: { name: 'Water 500ml' } },
    );
    await expect(configuration.appliedVersion()).resolves.toBe(3);
  });

  it('resumes mid-backlog after a restart without re-sending what was acknowledged', async () => {
    const first = build();
    for (let index = 0; index < 8; index += 1) {
      await first.outbox.enqueue(movement(index));
    }
    await first.sync.runOnce(1_000);
    const deliveredFirstPass = cloud.received.length;
    expect(deliveredFirstPass).toBe(5);

    const restarted = build();
    await restarted.sync.runOnce(2_000_000);
    expect(cloud.durable.size).toBe(8);
    // The second pass carried only the three that were never acknowledged.
    expect(cloud.received.length).toBe(8);
  });

  it('keeps a fact the cloud refuses out of the way of the rest', async () => {
    const { outbox, sync } = build();
    cloud.rejectKeys.add('movement:2');
    for (let index = 0; index < 4; index += 1) {
      await outbox.enqueue(movement(index));
    }
    await sync.runOnce(1_000);
    await expect(outbox.pendingCount()).resolves.toBe(0);
    expect(cloud.durable.has('movement:2')).toBe(false);
    expect(cloud.durable.size).toBe(3);
  });
});
