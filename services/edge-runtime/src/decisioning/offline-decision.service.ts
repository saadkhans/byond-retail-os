import { Inject, Injectable } from '@nestjs/common';
import { EdgeConfigService } from '../config/edge-config.service';
import { LocalLedgerService } from '../ledger/local-ledger.service';
import { EDGE_STORE, EdgeStorePort } from '../store/edge-store.port';
import { LOGS } from '../store/store-names';
import { ConfigurationService } from '../sync/configuration.service';
import { OutboxService } from '../sync/outbox.service';
import { signedDelta } from './decision-policy';
import {
  CvProposal,
  DecisionOutcome,
  decide,
} from './decision-policy';
import { ReviewItem, ReviewQueueService } from './review-queue.service';

export interface IngestResult {
  readonly outcome: DecisionOutcome;
  readonly ledgerSequence?: number;
  readonly review?: ReviewItem;
}

/**
 * The offline decision path — what keeps a store trading when the cloud is
 * unreachable.
 *
 * Every proposal is recorded as observed BEFORE any decision is taken, so the
 * observation survives even if the decision is later disputed. Then the policy
 * runs, and only an ACCEPT reaches the local ledger. In every case the
 * proposal is forwarded to the cloud, because the control plane stays the
 * authoritative record of what the cameras claimed.
 */
@Injectable()
export class OfflineDecisionService {
  constructor(
    @Inject(EDGE_STORE) private readonly store: EdgeStorePort,
    private readonly ledger: LocalLedgerService,
    private readonly outbox: OutboxService,
    private readonly configuration: ConfigurationService,
    private readonly reviews: ReviewQueueService,
    private readonly config: EdgeConfigService,
  ) {}

  async ingest(proposal: CvProposal): Promise<IngestResult> {
    await this.store.append(LOGS.proposals, proposal);

    const productKnown =
      proposal.productId !== undefined &&
      (await this.configuration.get('PRODUCT', proposal.productId)) !== null;
    const projectedStock =
      proposal.productId === undefined
        ? 0
        : await this.ledger.stockFor(proposal.productId, proposal.unitId);

    const outcome = decide({
      proposal,
      confidenceThreshold: this.config.reviewConfidenceThreshold,
      productKnown,
      projectedStock,
    });

    // The cloud sees every proposal, whatever the edge decided locally.
    await this.outbox.enqueue({
      type: 'VISION_EVENT_PROPOSAL',
      idempotencyKey: `proposal:${proposal.proposalId}`,
      occurredAt: proposal.occurredAt,
      payload: {
        proposalId: proposal.proposalId,
        eventType: proposal.type,
        unitId: proposal.unitId,
        productId: proposal.productId ?? null,
        quantity: proposal.quantity,
        confidence: proposal.confidence,
        evidenceRef: proposal.evidenceRef ?? null,
        edgeDecision: outcome.decision,
        edgeReasons: [...outcome.reasons],
      },
    });

    if (outcome.decision === 'ACCEPT' && proposal.productId !== undefined) {
      const ledgerSequence = await this.applyMovement(
        proposal,
        proposal.productId,
        outcome.quantityDelta,
        `proposal:${proposal.proposalId}`,
      );
      return { outcome, ledgerSequence };
    }

    if (outcome.decision === 'REVIEW') {
      const review = await this.reviews.raise(proposal, outcome.reasons);
      return { outcome, review };
    }

    return { outcome };
  }

  /**
   * An operator's decision on a queued item. Approving applies the movement
   * the policy declined to apply automatically; the decision itself is a fact
   * forwarded to the cloud either way.
   */
  async decideReview(
    reviewId: string,
    approve: boolean,
    decidedBy: string,
  ): Promise<IngestResult | null> {
    const item = await this.reviews.resolve(
      reviewId,
      approve ? 'APPROVED' : 'REJECTED',
      decidedBy,
    );
    if (item === null) {
      return null;
    }

    await this.outbox.enqueue({
      type: 'REVIEW_DECISION',
      idempotencyKey: `review:${reviewId}`,
      occurredAt: item.decidedAt ?? new Date().toISOString(),
      payload: {
        reviewId,
        proposalId: item.proposal.proposalId,
        decision: item.state,
        decidedBy,
        reasons: [...item.reasons],
      },
    });

    const outcome: DecisionOutcome = {
      decision: approve ? 'ACCEPT' : 'REJECT',
      reasons: item.reasons,
      quantityDelta: approve
        ? signedDelta(item.proposal.type, item.proposal.quantity)
        : 0,
    };

    if (
      approve &&
      item.proposal.productId !== undefined &&
      outcome.quantityDelta !== 0
    ) {
      const ledgerSequence = await this.applyMovement(
        item.proposal,
        item.proposal.productId,
        outcome.quantityDelta,
        `review:${reviewId}`,
      );
      return { outcome, ledgerSequence, review: item };
    }
    return { outcome, review: item };
  }

  private async applyMovement(
    proposal: CvProposal,
    productId: string,
    quantityDelta: number,
    reference: string,
  ): Promise<number> {
    const movementId = `${reference}:movement`;
    const sequence = await this.ledger.record({
      movementId,
      type: quantityDelta < 0 ? 'SALE' : 'CORRECTION_IN',
      productId,
      unitId: proposal.unitId,
      quantityDelta,
      occurredAt: proposal.occurredAt,
      reference,
    });
    await this.outbox.enqueue({
      type: 'INVENTORY_MOVEMENT',
      idempotencyKey: `movement:${movementId}`,
      occurredAt: proposal.occurredAt,
      payload: {
        movementId,
        productId,
        unitId: proposal.unitId,
        quantityDelta,
        reference,
      },
    });
    return sequence;
  }
}
