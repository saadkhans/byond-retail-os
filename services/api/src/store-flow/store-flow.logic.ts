import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  CustomerJourneyEventType,
  StoreFlowAutonomyLevel,
  StoreFlowProjectionOutcome,
  VisionEventType,
} from '@prisma/client';
import {
  DEFAULT_STORE_FLOW_POLICY,
  ENTRY_TOKEN_SECRET_BYTES,
  PROJECTION_REASON,
  ProjectionReason,
} from './store-flow.constants';

/**
 * Phase 26 — the pure decisions behind the store flow.
 *
 * Everything in this file is a total function of its arguments: no database,
 * no clock beyond what is passed in, no I/O. The rules that decide whether a
 * store may act without a human live here so they can be exhaustively tested
 * and read in one sitting.
 */

/** The effective policy for one store, after resolution. */
export interface EffectiveStoreFlowPolicy {
  autonomyLevel: StoreFlowAutonomyLevel;
  autoApplyMinConfidence: number;
  requireInventoryValidation: boolean;
  settleOnExit: boolean;
  /** The version that supplied these values, or null for the built-in default. */
  policyVersionId: string | null;
  /** The store the policy was written for, or null for the tenant default. */
  policyLocationId: string | null;
}

/** A candidate policy row, as the repository reads it. */
export interface PolicyCandidate {
  locationId: string | null;
  version: {
    id: string;
    autonomyLevel: StoreFlowAutonomyLevel;
    autoApplyMinConfidence: number;
    requireInventoryValidation: boolean;
    settleOnExit: boolean;
  } | null;
}

/** The built-in policy: observe, change nothing. */
export function defaultPolicy(): EffectiveStoreFlowPolicy {
  return {
    autonomyLevel: DEFAULT_STORE_FLOW_POLICY.autonomyLevel,
    autoApplyMinConfidence: DEFAULT_STORE_FLOW_POLICY.autoApplyMinConfidence,
    requireInventoryValidation:
      DEFAULT_STORE_FLOW_POLICY.requireInventoryValidation,
    settleOnExit: DEFAULT_STORE_FLOW_POLICY.settleOnExit,
    policyVersionId: null,
    policyLocationId: null,
  };
}

/**
 * Resolve the policy in force at one store. A policy written for that store
 * beats the tenant-wide default; a policy row with no active version is
 * ignored, because a half-configured policy must never be more permissive
 * than no policy at all.
 */
export function resolvePolicy(
  candidates: readonly PolicyCandidate[],
  locationId: string,
): EffectiveStoreFlowPolicy {
  const usable = candidates.filter((candidate) => candidate.version !== null);
  const forStore = usable.find(
    (candidate) => candidate.locationId === locationId,
  );
  const tenantWide = usable.find((candidate) => candidate.locationId === null);
  const chosen = forStore ?? tenantWide;
  if (!chosen?.version) {
    return defaultPolicy();
  }
  return {
    autonomyLevel: chosen.version.autonomyLevel,
    autoApplyMinConfidence: chosen.version.autoApplyMinConfidence,
    requireInventoryValidation: chosen.version.requireInventoryValidation,
    settleOnExit: chosen.version.settleOnExit,
    policyVersionId: chosen.version.id,
    policyLocationId: chosen.locationId,
  };
}

/** The journey observation the bridge is deciding about. */
export interface ObservationInput {
  eventType: CustomerJourneyEventType;
  productId: string | null;
  quantity: number;
  matchScore: number | null;
}

/** What inventory said about the proposed movement. */
export type InventoryVerdict = 'PLAUSIBLE' | 'IMPLAUSIBLE' | 'NOT_CHECKED';

/** The decision, before anything is written. */
export interface ProjectionDecision {
  outcome: StoreFlowProjectionOutcome;
  reasonCode: ProjectionReason;
  /** Whether a vision event should be created for this observation. */
  createsVisionEvent: boolean;
  /** Whether that vision event should be approved without a human. */
  autoApproves: boolean;
  /** The vision event type to ingest, when one is created. */
  visionEventType: VisionEventType | null;
}

const PRODUCT_OBSERVATIONS = new Set<CustomerJourneyEventType>([
  CustomerJourneyEventType.PRODUCT_PICKUP,
  CustomerJourneyEventType.PRODUCT_RETURN,
]);

/** Map a journey observation onto the vision event vocabulary. */
export function visionEventTypeFor(
  eventType: CustomerJourneyEventType,
): VisionEventType | null {
  if (eventType === CustomerJourneyEventType.PRODUCT_PICKUP) {
    return VisionEventType.PRODUCT_PICKUP;
  }
  if (eventType === CustomerJourneyEventType.PRODUCT_RETURN) {
    return VisionEventType.PRODUCT_RETURN;
  }
  return null;
}

/**
 * Decide what the bridge does with one observation.
 *
 * The order of the gates is the product invariant in ARCHITECTURE.md, written
 * out: computer vision proposes, inventory validates, checkout routes, and a
 * low-confidence event goes to a human. A score alone is never enough — a
 * confident proposal that inventory calls implausible still waits for a
 * person.
 */
export function decideProjection(
  observation: ObservationInput,
  policy: EffectiveStoreFlowPolicy,
  inventory: InventoryVerdict,
): ProjectionDecision {
  const skipped = (reasonCode: ProjectionReason): ProjectionDecision => ({
    outcome: StoreFlowProjectionOutcome.SKIPPED,
    reasonCode,
    createsVisionEvent: false,
    autoApproves: false,
    visionEventType: null,
  });
  const toHuman = (reasonCode: ProjectionReason): ProjectionDecision => ({
    outcome: StoreFlowProjectionOutcome.REVIEW_REQUIRED,
    reasonCode,
    createsVisionEvent: false,
    autoApproves: false,
    visionEventType: null,
  });

  // SHADOW observes and changes nothing. This is the branch that makes the
  // whole phase inert until an operator opts in.
  if (policy.autonomyLevel === StoreFlowAutonomyLevel.SHADOW) {
    return skipped(PROJECTION_REASON.SHADOW_MODE);
  }

  // The pipeline flagged this one itself; it never becomes a basket line
  // without a person, whatever the policy says.
  if (observation.eventType === CustomerJourneyEventType.REVIEW_REQUIRED) {
    return toHuman(PROJECTION_REASON.PIPELINE_FLAGGED_REVIEW);
  }

  if (!PRODUCT_OBSERVATIONS.has(observation.eventType)) {
    return skipped(PROJECTION_REASON.NOT_A_PRODUCT_OBSERVATION);
  }

  // A product movement with no catalog product is a review item, not a
  // silent drop: somebody took something the pipeline could not name.
  if (!observation.productId) {
    return toHuman(PROJECTION_REASON.UNKNOWN_PRODUCT);
  }

  const visionEventType = visionEventTypeFor(observation.eventType);
  if (visionEventType === null) {
    return skipped(PROJECTION_REASON.NOT_A_PRODUCT_OBSERVATION);
  }

  const proposed: ProjectionDecision = {
    outcome: StoreFlowProjectionOutcome.PROPOSED,
    reasonCode: PROJECTION_REASON.PROPOSED_FOR_REVIEW,
    createsVisionEvent: true,
    autoApproves: false,
    visionEventType,
  };

  if (policy.autonomyLevel === StoreFlowAutonomyLevel.PROPOSE) {
    return proposed;
  }

  // AUTO_APPLY from here. Every gate below leaves the event PROPOSED — it is
  // still created and still visible in the queue, it simply waits for a human.
  if (
    observation.matchScore === null ||
    !Number.isFinite(observation.matchScore)
  ) {
    return { ...proposed, reasonCode: PROJECTION_REASON.NO_CONFIDENCE_RECORDED };
  }
  if (observation.matchScore < policy.autoApplyMinConfidence) {
    return {
      ...proposed,
      reasonCode: PROJECTION_REASON.BELOW_CONFIDENCE_THRESHOLD,
    };
  }
  if (policy.requireInventoryValidation && inventory !== 'PLAUSIBLE') {
    return { ...proposed, reasonCode: PROJECTION_REASON.INVENTORY_IMPLAUSIBLE };
  }

  return {
    outcome: StoreFlowProjectionOutcome.AUTO_APPLIED,
    reasonCode: PROJECTION_REASON.AUTO_APPLIED,
    createsVisionEvent: true,
    autoApproves: true,
    visionEventType,
  };
}

/**
 * Is the proposed movement plausible against the store's inventory
 * projection? A pickup of something the store has no stock of is the classic
 * recognition error, and it is cheap to catch here. A return adds stock back,
 * so it is always plausible.
 */
export function inventoryVerdict(
  eventType: CustomerJourneyEventType,
  onHandQuantity: number | null,
  requestedQuantity: number,
): InventoryVerdict {
  if (eventType === CustomerJourneyEventType.PRODUCT_RETURN) {
    return 'PLAUSIBLE';
  }
  if (eventType !== CustomerJourneyEventType.PRODUCT_PICKUP) {
    return 'NOT_CHECKED';
  }
  if (onHandQuantity === null) {
    // No stock record for this product at this store at all.
    return 'IMPLAUSIBLE';
  }
  return onHandQuantity >= requestedQuantity ? 'PLAUSIBLE' : 'IMPLAUSIBLE';
}

/** A freshly minted entry credential: the secret to hand out, and its digest. */
export interface MintedEntryToken {
  secret: string;
  tokenHash: string;
}

/**
 * Mint an entry credential. The secret is returned to the caller once and
 * never stored; only the digest is persisted, so reading the database can
 * never yield a usable token.
 */
export function mintEntryToken(): MintedEntryToken {
  const secret = randomBytes(ENTRY_TOKEN_SECRET_BYTES).toString('base64url');
  return { secret, tokenHash: hashEntryToken(secret) };
}

/** The digest stored for an entry credential: lowercase hex SHA-256. */
export function hashEntryToken(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/**
 * Compare two digests without leaking where they first differ. Lookup is by
 * digest so this matters less than it would for a direct comparison, but a
 * constant-time check costs nothing and removes the question.
 */
export function digestsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

/** Is this credential usable right now? */
export function entryTokenUsable(
  token: { status: string; expiresAt: Date },
  now: Date,
): { usable: boolean; reason?: 'ALREADY_USED' | 'REVOKED' | 'EXPIRED' } {
  if (token.status === 'REDEEMED') {
    return { usable: false, reason: 'ALREADY_USED' };
  }
  if (token.status === 'REVOKED') {
    return { usable: false, reason: 'REVOKED' };
  }
  if (token.expiresAt.getTime() <= now.getTime()) {
    return { usable: false, reason: 'EXPIRED' };
  }
  return { usable: true };
}
