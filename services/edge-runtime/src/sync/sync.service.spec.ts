import {
  fakeConfig,
  sealedIdentity,
  silentLogger,
  temporaryStore,
} from '../../test/helpers';
import { StructuredLogger } from '../logging/structured-logger';
import { ConfigurationService } from './configuration.service';
import { OutboxService } from './outbox.service';
import { SimulatedCloudClient } from './simulated-cloud-client.adapter';
import { OfflineCloudClient } from './offline-cloud-client.adapter';
import { SyncService } from './sync.service';
import { backoffDelayMs } from './sync.types';

describe('backoffDelayMs', () => {
  it('grows exponentially and stops at the ceiling', () => {
    expect(backoffDelayMs(0, 1000, 60_000)).toBe(0);
    expect(backoffDelayMs(1, 1000, 60_000)).toBe(1000);
    expect(backoffDelayMs(2, 1000, 60_000)).toBe(2000);
    expect(backoffDelayMs(4, 1000, 60_000)).toBe(8000);
    expect(backoffDelayMs(40, 1000, 60_000)).toBe(60_000);
  });
});

describe('SyncService', () => {
  let context: Awaited<ReturnType<typeof temporaryStore>>;
  let cloud: SimulatedCloudClient;
  let outbox: OutboxService;
  let configuration: ConfigurationService;
  let sync: SyncService;

  beforeEach(async () => {
    context = await temporaryStore();
    cloud = new SimulatedCloudClient();
    const config = fakeConfig({
      EDGE_SYNC_BATCH_SIZE: 10,
      EDGE_SYNC_MAX_ATTEMPTS: 5,
      EDGE_SYNC_BACKOFF_BASE_MS: 1000,
      EDGE_SYNC_BACKOFF_MAX_MS: 60_000,
    });
    outbox = new OutboxService(context.store, config);
    configuration = new ConfigurationService(
      context.store,
      await sealedIdentity(context.store),
    );
    sync = new SyncService(
      cloud,
      outbox,
      configuration,
      config,
      silentLogger(),
    );
  });

  afterEach(async () => {
    sync.stop();
    await context.cleanup();
  });

  it('pulls configuration and pushes facts in one pass', async () => {
    cloud.publishConfiguration([
      {
        resourceType: 'PRODUCT',
        resourceId: 'sku-water',
        version: 1,
        payload: { name: 'Water' },
      },
    ]);
    await outbox.enqueue({
      type: 'INVENTORY_MOVEMENT',
      idempotencyKey: 'movement:1',
      occurredAt: '2026-09-16T10:00:00.000Z',
      payload: { movementId: '1' },
    });

    const outcome = await sync.runOnce(1_000);
    expect(outcome.connectivity).toBe('ONLINE');
    expect(outcome.configurationApplied).toBe(1);
    expect(outcome.accepted).toBe(1);
    expect(outcome.pendingAfter).toBe(0);
    expect(sync.lastSyncedAt).not.toBeNull();
  });

  it('reports offline and keeps the facts when the cloud is unreachable', async () => {
    cloud.online = false;
    await outbox.enqueue({
      type: 'INVENTORY_MOVEMENT',
      idempotencyKey: 'movement:1',
      occurredAt: '2026-09-16T10:00:00.000Z',
      payload: { movementId: '1' },
    });

    const outcome = await sync.runOnce(1_000);
    expect(outcome.connectivity).toBe('OFFLINE');
    expect(outcome.errorClass).toBe('Error');
    await expect(outbox.pendingCount()).resolves.toBe(1);
  });

  it('backs off before trying again, then recovers', async () => {
    cloud.online = false;
    await outbox.enqueue({
      type: 'INVENTORY_MOVEMENT',
      idempotencyKey: 'movement:1',
      occurredAt: '2026-09-16T10:00:00.000Z',
      payload: { movementId: '1' },
    });

    await sync.runOnce(1_000);
    const skipped = await sync.runOnce(1_100);
    expect(skipped.skippedForBackoff).toBe(true);

    cloud.online = true;
    const recovered = await sync.runOnce(1_000_000);
    expect(recovered.connectivity).toBe('ONLINE');
    expect(recovered.accepted).toBe(1);
  });

  it('does nothing but stay online when there is nothing to send', async () => {
    const outcome = await sync.runOnce(1_000);
    expect(outcome).toMatchObject({
      connectivity: 'ONLINE',
      pushed: 0,
      pendingAfter: 0,
    });
  });

  it('treats an unconfigured control plane as permanently offline', async () => {
    const offline = new SyncService(
      new OfflineCloudClient(),
      outbox,
      configuration,
      fakeConfig(),
      silentLogger(),
    );
    await outbox.enqueue({
      type: 'DEVICE_HEARTBEAT',
      idempotencyKey: 'hb:1',
      occurredAt: '2026-09-16T10:00:00.000Z',
      payload: {},
    });
    const outcome = await offline.runOnce(1_000);
    expect(outcome.connectivity).toBe('OFFLINE');
    await expect(outbox.pendingCount()).resolves.toBe(1);
  });

  it('never logs the cloud credential or a media path when degrading', async () => {
    const logger = new StructuredLogger();
    const lines: string[] = [];
    logger.setSink((record) => lines.push(JSON.stringify(record)));
    const degrading = new SyncService(
      {
        adapterKey: 'boom',
        version: '1',
        checkReady: async (): Promise<boolean> => false,
        pushOperations: async (): Promise<never> => {
          throw new Error('token super-secret-token at C:/media/clip.mp4');
        },
        pullConfiguration: async (): Promise<never> => {
          throw new Error('token super-secret-token at C:/media/clip.mp4');
        },
      },
      outbox,
      configuration,
      fakeConfig(),
      logger,
    );
    await degrading.runOnce(1_000);
    const joined = lines.join('');
    expect(joined).not.toContain('super-secret-token');
    expect(joined).not.toContain('clip.mp4');
  });
});
