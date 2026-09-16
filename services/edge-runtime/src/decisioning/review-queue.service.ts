import { Inject, Injectable } from '@nestjs/common';
import { EDGE_STORE, EdgeStorePort } from '../store/edge-store.port';
import { COLLECTIONS } from '../store/store-names';
import { CvProposal, DecisionReason } from './decision-policy';

export type ReviewState = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface ReviewItem {
  readonly reviewId: string;
  readonly proposal: CvProposal;
  readonly reasons: readonly DecisionReason[];
  readonly state: ReviewState;
  readonly raisedAt: string;
  readonly decidedAt?: string;
  readonly decidedBy?: string;
}

/**
 * The local review queue: where a proposal waits when the edge is not entitled
 * to apply it. It keeps the store running offline without ever letting an
 * unvalidated CV proposal reach the ledger.
 *
 * A decided item is terminal. The decision itself is forwarded to the cloud as
 * an append-only fact, so the control plane remains the authoritative record.
 */
@Injectable()
export class ReviewQueueService {
  constructor(@Inject(EDGE_STORE) private readonly store: EdgeStorePort) {}

  async raise(
    proposal: CvProposal,
    reasons: readonly DecisionReason[],
  ): Promise<ReviewItem> {
    const item: ReviewItem = {
      reviewId: proposal.proposalId,
      proposal,
      reasons,
      state: 'PENDING',
      raisedAt: new Date().toISOString(),
    };
    await this.store.put(COLLECTIONS.review, item.reviewId, item);
    return item;
  }

  async get(reviewId: string): Promise<ReviewItem | null> {
    return this.store.get<ReviewItem>(COLLECTIONS.review, reviewId);
  }

  async pending(): Promise<ReadonlyArray<ReviewItem>> {
    const all = await this.store.list<ReviewItem>(COLLECTIONS.review);
    return all
      .map((record) => record.value)
      .filter((item) => item.state === 'PENDING')
      .sort((left, right) => left.raisedAt.localeCompare(right.raisedAt));
  }

  async pendingCount(): Promise<number> {
    return (await this.pending()).length;
  }

  /** Marks an item decided. Returns the updated item, or null if not pending. */
  async resolve(
    reviewId: string,
    state: Exclude<ReviewState, 'PENDING'>,
    decidedBy: string,
  ): Promise<ReviewItem | null> {
    const current = await this.get(reviewId);
    if (current === null || current.state !== 'PENDING') {
      return null;
    }
    const updated: ReviewItem = {
      ...current,
      state,
      decidedAt: new Date().toISOString(),
      decidedBy,
    };
    await this.store.put(COLLECTIONS.review, reviewId, updated);
    return updated;
  }
}
