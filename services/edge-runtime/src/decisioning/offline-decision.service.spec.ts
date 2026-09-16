import { fakeConfig, sealedIdentity, temporaryStore } from '../../test/helpers';
import { LocalLedgerService } from '../ledger/local-ledger.service';
import { LOGS } from '../store/store-names';
import { ConfigurationService } from '../sync/configuration.service';
import { OutboxService } from '../sync/outbox.service';
import { OutboxOperation } from '../sync/sync.types';
import { CvProposal } from './decision-policy';
import { OfflineDecisionService } from './offline-decision.service';
import { ReviewQueueService } from './review-queue.service';

function proposal(overrides: Partial<CvProposal> = {}): CvProposal {
  return {
    proposalId: `p-${Math.random().toString(36).slice(2)}`,
    type: 'PRODUCT_PICKUP',
    unitId: 'unit-1',
    productId: 'sku-water',
    quantity: 1,
    confidence: 0.9,
    occurredAt: '2026-09-16T10:00:00.000Z',
    ...overrides,
  };
}

describe('OfflineDecisionService', () => {
  let context: Awaited<ReturnType<typeof temporaryStore>>;
  let ledger: LocalLedgerService;
  let outbox: OutboxService;
  let configuration: ConfigurationService;
  let reviews: ReviewQueueService;
  let decisions: OfflineDecisionService;

  beforeEach(async () => {
    context = await temporaryStore();
    const config = fakeConfig({ EDGE_REVIEW_CONFIDENCE_THRESHOLD: 0.75 });
    ledger = new LocalLedgerService(context.store);
    await ledger.rebuild();
    outbox = new OutboxService(context.store, config);
    configuration = new ConfigurationService(
      context.store,
      await sealedIdentity(context.store),
    );
    reviews = new ReviewQueueService(context.store);
    decisions = new OfflineDecisionService(
      context.store,
      ledger,
      outbox,
      configuration,
      reviews,
      config,
    );
    await configuration.apply([
      {
        resourceType: 'PRODUCT',
        resourceId: 'sku-water',
        version: 1,
        payload: { name: 'Water' },
      },
    ]);
    await ledger.record({
      movementId: 'seed',
      type: 'RECEIPT',
      productId: 'sku-water',
      unitId: 'unit-1',
      quantityDelta: 10,
      occurredAt: '2026-09-16T09:00:00.000Z',
    });
  });

  afterEach(async () => {
    await context.cleanup();
  });

  async function outboxTypes(): Promise<string[]> {
    const entries = await context.store.read<OutboxOperation>(LOGS.outbox, 0, 50);
    return entries.map((item) => item.entry.type);
  }

  it('records the proposal as observed before deciding anything', async () => {
    await decisions.ingest(proposal({ confidence: 0.1 }));
    await expect(context.store.count(LOGS.proposals)).resolves.toBe(1);
  });

  it('applies a confident pickup to the local ledger and forwards both facts', async () => {
    const result = await decisions.ingest(proposal());
    expect(result.outcome.decision).toBe('ACCEPT');
    expect(result.ledgerSequence).toBeDefined();
    await expect(ledger.stockFor('sku-water', 'unit-1')).resolves.toBe(9);
    await expect(outboxTypes()).resolves.toEqual([
      'VISION_EVENT_PROPOSAL',
      'INVENTORY_MOVEMENT',
    ]);
  });

  it('queues a low-confidence proposal for review and leaves stock alone', async () => {
    const result = await decisions.ingest(proposal({ confidence: 0.2 }));
    expect(result.outcome.decision).toBe('REVIEW');
    expect(result.review?.state).toBe('PENDING');
    await expect(ledger.stockFor('sku-water', 'unit-1')).resolves.toBe(10);
    await expect(reviews.pendingCount()).resolves.toBe(1);
    // The cloud still hears about it — the control plane is authoritative.
    await expect(outboxTypes()).resolves.toEqual(['VISION_EVENT_PROPOSAL']);
  });

  it('reviews a product the local catalog does not know', async () => {
    const result = await decisions.ingest(proposal({ productId: 'sku-ghost' }));
    expect(result.outcome.reasons).toContain('UNKNOWN_PRODUCT');
    await expect(reviews.pendingCount()).resolves.toBe(1);
  });

  it('lets the ledger veto a pickup it cannot support', async () => {
    await ledger.record({
      movementId: 'drain',
      type: 'SALE',
      productId: 'sku-water',
      unitId: 'unit-1',
      quantityDelta: -10,
      occurredAt: '2026-09-16T09:30:00.000Z',
    });
    const result = await decisions.ingest(proposal());
    expect(result.outcome.reasons).toContain('WOULD_DRIVE_STOCK_NEGATIVE');
    await expect(ledger.stockFor('sku-water', 'unit-1')).resolves.toBe(0);
  });

  it('records a malformed proposal without queuing or applying it', async () => {
    const result = await decisions.ingest(proposal({ quantity: 0 }));
    expect(result.outcome.decision).toBe('REJECT');
    await expect(reviews.pendingCount()).resolves.toBe(0);
    await expect(context.store.count(LOGS.proposals)).resolves.toBe(1);
  });

  it('applies the movement when an operator approves a queued item', async () => {
    const queued = await decisions.ingest(proposal({ confidence: 0.2 }));
    const reviewId = queued.review?.reviewId ?? '';
    const decided = await decisions.decideReview(reviewId, true, 'operator-1');
    expect(decided?.outcome.decision).toBe('ACCEPT');
    await expect(ledger.stockFor('sku-water', 'unit-1')).resolves.toBe(9);
    await expect(outboxTypes()).resolves.toEqual([
      'VISION_EVENT_PROPOSAL',
      'REVIEW_DECISION',
      'INVENTORY_MOVEMENT',
    ]);
  });

  it('leaves stock untouched when an operator rejects a queued item', async () => {
    const queued = await decisions.ingest(proposal({ confidence: 0.2 }));
    const reviewId = queued.review?.reviewId ?? '';
    const decided = await decisions.decideReview(reviewId, false, 'operator-1');
    expect(decided?.outcome.decision).toBe('REJECT');
    await expect(ledger.stockFor('sku-water', 'unit-1')).resolves.toBe(10);
    await expect(reviews.pendingCount()).resolves.toBe(0);
  });

  it('refuses to decide the same item twice', async () => {
    const queued = await decisions.ingest(proposal({ confidence: 0.2 }));
    const reviewId = queued.review?.reviewId ?? '';
    await decisions.decideReview(reviewId, true, 'operator-1');
    await expect(
      decisions.decideReview(reviewId, true, 'operator-2'),
    ).resolves.toBeNull();
    await expect(ledger.stockFor('sku-water', 'unit-1')).resolves.toBe(9);
  });

  it('returns null for an unknown review id', async () => {
    await expect(
      decisions.decideReview('nope', true, 'operator-1'),
    ).resolves.toBeNull();
  });

  it('gives each fact a stable idempotency key derived from the proposal', async () => {
    const one = proposal({ proposalId: 'p-fixed' });
    await decisions.ingest(one);
    const entries = await context.store.read<OutboxOperation>(LOGS.outbox, 0, 50);
    expect(entries.map((item) => item.entry.idempotencyKey)).toEqual([
      'proposal:p-fixed',
      'movement:proposal:p-fixed:movement',
    ]);
  });
});
