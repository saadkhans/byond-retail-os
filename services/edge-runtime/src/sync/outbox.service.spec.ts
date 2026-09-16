import { fakeConfig, temporaryStore } from '../../test/helpers';
import { LOGS } from '../store/store-names';
import { OutboxService } from './outbox.service';
import { OutboxEntry, OutboxOperation } from './sync.types';

function operation(key: string): OutboxOperation {
  return {
    type: 'INVENTORY_MOVEMENT',
    idempotencyKey: key,
    occurredAt: '2026-09-16T10:00:00.000Z',
    payload: { movementId: key },
  };
}

describe('OutboxService', () => {
  let context: Awaited<ReturnType<typeof temporaryStore>>;
  let outbox: OutboxService;

  beforeEach(async () => {
    context = await temporaryStore();
    outbox = new OutboxService(
      context.store,
      fakeConfig({ EDGE_SYNC_BATCH_SIZE: 3, EDGE_SYNC_MAX_ATTEMPTS: 3 }),
    );
  });

  afterEach(async () => {
    await context.cleanup();
  });

  it('delivers in order and bounds the batch', async () => {
    for (const key of ['a', 'b', 'c', 'd']) {
      await outbox.enqueue(operation(key));
    }
    const batch = await outbox.nextBatch();
    expect(batch.map((entry) => entry.idempotencyKey)).toEqual(['a', 'b', 'c']);
    await expect(outbox.pendingCount()).resolves.toBe(4);
  });

  it('advances the cursor over accepted entries', async () => {
    for (const key of ['a', 'b']) {
      await outbox.enqueue(operation(key));
    }
    const batch = await outbox.nextBatch();
    await outbox.settle(batch, { accepted: ['a', 'b'], rejected: [] });
    await expect(outbox.pendingCount()).resolves.toBe(0);
    await expect(outbox.nextBatch()).resolves.toEqual([]);
  });

  it('stops at the first entry the cloud did not resolve', async () => {
    for (const key of ['a', 'b', 'c']) {
      await outbox.enqueue(operation(key));
    }
    const batch = await outbox.nextBatch();
    await outbox.settle(batch, { accepted: ['a'], rejected: [] });
    const next = await outbox.nextBatch();
    expect(next.map((entry) => entry.idempotencyKey)).toEqual(['b', 'c']);
    await expect(outbox.headAttempts()).resolves.toBe(1);
  });

  it('dead-letters a rejected fact and keeps the queue moving', async () => {
    for (const key of ['a', 'b']) {
      await outbox.enqueue(operation(key));
    }
    const batch = await outbox.nextBatch();
    await outbox.settle(batch, {
      accepted: ['b'],
      rejected: [{ idempotencyKey: 'a', reasonCode: 'REJECTED_BY_CLOUD' }],
    });
    await expect(outbox.pendingCount()).resolves.toBe(0);
    await expect(context.store.count(LOGS.deadletter)).resolves.toBe(1);
    const conflicts = await context.store.read<{ kind: string }>(
      LOGS.conflicts,
      0,
      10,
    );
    expect(conflicts[0].entry.kind).toBe('CLOUD_REJECTED_FACT');
  });

  it('breaks head-of-line blocking once the attempt budget is spent', async () => {
    await outbox.enqueue(operation('stuck'));
    await outbox.enqueue(operation('next'));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const batch = await outbox.nextBatch();
      await outbox.recordDeliveryFailure(batch);
    }
    const remaining = await outbox.nextBatch();
    expect(remaining.map((entry: OutboxEntry) => entry.idempotencyKey)).toEqual([
      'next',
    ]);
    const dead = await context.store.read<{ reasonCode: string }>(
      LOGS.deadletter,
      0,
      10,
    );
    expect(dead[0].entry.reasonCode).toBe('ATTEMPT_BUDGET_EXHAUSTED');
  });

  it('resets the attempt count once an entry is accepted', async () => {
    await outbox.enqueue(operation('a'));
    await outbox.recordDeliveryFailure(await outbox.nextBatch());
    await expect(outbox.headAttempts()).resolves.toBe(1);
    await outbox.settle(await outbox.nextBatch(), {
      accepted: ['a'],
      rejected: [],
    });
    await outbox.enqueue(operation('b'));
    await expect(outbox.headAttempts()).resolves.toBe(0);
  });

  it('keeps the backlog bounded without erasing the fact from disk', async () => {
    const bounded = new OutboxService(
      context.store,
      fakeConfig({ EDGE_OUTBOX_MAX_ENTRIES: 10, EDGE_SYNC_BATCH_SIZE: 50 }),
    );
    for (let index = 0; index < 13; index += 1) {
      await bounded.enqueue(operation(`k-${index}`));
    }
    await expect(bounded.pendingCount()).resolves.toBe(10);
    // The skipped entries are still in the append-only log, and each one is
    // recorded as a conflict rather than vanishing.
    await expect(context.store.count(LOGS.outbox)).resolves.toBe(13);
    await expect(context.store.count(LOGS.deadletter)).resolves.toBe(3);
    const batch = await bounded.nextBatch();
    expect(batch[0].idempotencyKey).toBe('k-3');
  });

  it('survives a restart with its cursor intact', async () => {
    await outbox.enqueue(operation('a'));
    await outbox.enqueue(operation('b'));
    await outbox.settle(await outbox.nextBatch(), {
      accepted: ['a'],
      rejected: [],
    });
    const restarted = new OutboxService(context.store, fakeConfig());
    const batch = await restarted.nextBatch();
    expect(batch.map((entry) => entry.idempotencyKey)).toEqual(['b']);
  });
});
