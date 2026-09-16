/**
 * The edge decision policy.
 *
 * It encodes the product invariant verbatim: computer vision only PROPOSES,
 * inventory VALIDATES the proposal against the local ledger projection, and
 * anything the policy cannot justify goes to a human instead of to stock.
 * There is no branch in which a proposal's own confidence is treated as
 * ground truth.
 */

export type EdgeProposalType =
  | 'PRODUCT_PICKUP'
  | 'PRODUCT_RETURN'
  | 'PRODUCT_TRANSFER'
  | 'CART_INSERTION'
  | 'EXIT_RECONCILIATION';

export interface CvProposal {
  readonly proposalId: string;
  readonly type: EdgeProposalType;
  readonly unitId: string;
  readonly productId?: string;
  readonly quantity: number;
  /** 0..1 as reported by the proposing pipeline. */
  readonly confidence: number;
  readonly occurredAt: string;
  /** Opaque lineage id. Never a storage key, path or URL. */
  readonly evidenceRef?: string;
}

export type EdgeDecision = 'ACCEPT' | 'REVIEW' | 'REJECT';

export type DecisionReason =
  | 'MALFORMED_PROPOSAL'
  | 'UNKNOWN_PRODUCT'
  | 'LOW_CONFIDENCE'
  | 'WOULD_DRIVE_STOCK_NEGATIVE'
  | 'NOT_A_STOCK_EVENT'
  | 'WITHIN_POLICY';

export interface DecisionInput {
  readonly proposal: CvProposal;
  readonly confidenceThreshold: number;
  /** The product exists in the locally-held catalog snapshot. */
  readonly productKnown: boolean;
  /** Stock for (product, unit) projected from the local ledger. */
  readonly projectedStock: number;
}

export interface DecisionOutcome {
  readonly decision: EdgeDecision;
  readonly reasons: readonly DecisionReason[];
  /** Signed ledger delta when the decision is ACCEPT; 0 otherwise. */
  readonly quantityDelta: number;
}

/** Events that move stock. Others are observations, not movements. */
const STOCK_EVENTS: ReadonlySet<EdgeProposalType> = new Set([
  'PRODUCT_PICKUP',
  'PRODUCT_RETURN',
]);

export function signedDelta(type: EdgeProposalType, quantity: number): number {
  if (type === 'PRODUCT_PICKUP') {
    return -Math.abs(quantity);
  }
  if (type === 'PRODUCT_RETURN') {
    return Math.abs(quantity);
  }
  return 0;
}

export function decide(input: DecisionInput): DecisionOutcome {
  const { proposal } = input;

  if (
    !Number.isInteger(proposal.quantity) ||
    proposal.quantity <= 0 ||
    !Number.isFinite(proposal.confidence) ||
    proposal.confidence < 0 ||
    proposal.confidence > 1
  ) {
    return {
      decision: 'REJECT',
      reasons: ['MALFORMED_PROPOSAL'],
      quantityDelta: 0,
    };
  }

  if (!STOCK_EVENTS.has(proposal.type)) {
    // A cart insertion or an exit reconciliation is recorded and forwarded,
    // but it is not a stock movement the edge may apply on its own.
    return {
      decision: 'REVIEW',
      reasons: ['NOT_A_STOCK_EVENT'],
      quantityDelta: 0,
    };
  }

  const reasons: DecisionReason[] = [];
  if (proposal.productId === undefined || !input.productKnown) {
    reasons.push('UNKNOWN_PRODUCT');
  }
  if (proposal.confidence < input.confidenceThreshold) {
    reasons.push('LOW_CONFIDENCE');
  }

  const delta = signedDelta(proposal.type, proposal.quantity);
  if (delta < 0 && input.projectedStock + delta < 0) {
    // Inventory validating the proposal: the ledger says this pickup cannot
    // have happened as described, so a human decides rather than the camera.
    reasons.push('WOULD_DRIVE_STOCK_NEGATIVE');
  }

  if (reasons.length > 0) {
    return { decision: 'REVIEW', reasons, quantityDelta: 0 };
  }
  return {
    decision: 'ACCEPT',
    reasons: ['WITHIN_POLICY'],
    quantityDelta: delta,
  };
}
