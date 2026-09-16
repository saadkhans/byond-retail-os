import { temporaryStore } from '../../test/helpers';
import { CvProposal } from './decision-policy';
import { ReviewQueueService } from './review-queue.service';

function proposal(id: string): CvProposal {
  return {
    proposalId: id,
    type: 'PRODUCT_PICKUP',
    unitId: 'unit-1',
    productId: 'sku-water',
    quantity: 1,
    confidence: 0.3,
    occurredAt: '2026-09-16T10:00:00.000Z',
  };
}

describe('ReviewQueueService', () => {
  let context: Awaited<ReturnType<typeof temporaryStore>>;
  let reviews: ReviewQueueService;

  beforeEach(async () => {
    context = await temporaryStore();
    reviews = new ReviewQueueService(context.store);
  });

  afterEach(async () => {
    await context.cleanup();
  });

  it('raises an item and lists it as pending', async () => {
    await reviews.raise(proposal('p-1'), ['LOW_CONFIDENCE']);
    const pending = await reviews.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ reviewId: 'p-1', state: 'PENDING' });
  });

  it('records who decided and when, and drops the item from pending', async () => {
    await reviews.raise(proposal('p-1'), ['LOW_CONFIDENCE']);
    const decided = await reviews.resolve('p-1', 'APPROVED', 'operator-1');
    expect(decided).toMatchObject({ state: 'APPROVED', decidedBy: 'operator-1' });
    expect(decided?.decidedAt).toBeDefined();
    await expect(reviews.pendingCount()).resolves.toBe(0);
  });

  it('treats a decision as terminal', async () => {
    await reviews.raise(proposal('p-1'), ['LOW_CONFIDENCE']);
    await reviews.resolve('p-1', 'APPROVED', 'operator-1');
    await expect(
      reviews.resolve('p-1', 'REJECTED', 'operator-2'),
    ).resolves.toBeNull();
    await expect(reviews.get('p-1')).resolves.toMatchObject({
      state: 'APPROVED',
    });
  });

  it('returns null for an unknown item', async () => {
    await expect(reviews.get('missing')).resolves.toBeNull();
    await expect(
      reviews.resolve('missing', 'APPROVED', 'operator-1'),
    ).resolves.toBeNull();
  });

  it('survives a restart', async () => {
    await reviews.raise(proposal('p-1'), ['LOW_CONFIDENCE']);
    const restarted = new ReviewQueueService(context.store);
    await expect(restarted.pendingCount()).resolves.toBe(1);
  });
});
