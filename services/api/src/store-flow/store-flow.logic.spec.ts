import {
  CustomerJourneyEventType,
  StoreFlowAutonomyLevel,
  StoreFlowProjectionOutcome,
  VisionEventType,
} from '@prisma/client';
import { PROJECTION_REASON } from './store-flow.constants';
import {
  decideProjection,
  defaultPolicy,
  digestsMatch,
  EffectiveStoreFlowPolicy,
  entryTokenUsable,
  hashEntryToken,
  inventoryVerdict,
  mintEntryToken,
  resolvePolicy,
  visionEventTypeFor,
} from './store-flow.logic';

const policy = (
  overrides: Partial<EffectiveStoreFlowPolicy> = {},
): EffectiveStoreFlowPolicy => ({
  ...defaultPolicy(),
  ...overrides,
});

const pickup = (overrides: Record<string, unknown> = {}) => ({
  eventType: CustomerJourneyEventType.PRODUCT_PICKUP,
  productId: 'prod-1',
  quantity: 1,
  matchScore: 0.9,
  ...overrides,
});

describe('store-flow policy resolution', () => {
  const version = (id: string, level: StoreFlowAutonomyLevel) => ({
    id,
    autonomyLevel: level,
    autoApplyMinConfidence: 0.5,
    requireInventoryValidation: true,
    settleOnExit: true,
  });

  it('falls back to the built-in SHADOW default when nothing is configured', () => {
    const resolved = resolvePolicy([], 'store-1');
    expect(resolved.autonomyLevel).toBe(StoreFlowAutonomyLevel.SHADOW);
    expect(resolved.policyVersionId).toBeNull();
    expect(resolved.settleOnExit).toBe(false);
  });

  it('prefers a policy written for the store over the tenant default', () => {
    const resolved = resolvePolicy(
      [
        {
          locationId: null,
          version: version('v-tenant', StoreFlowAutonomyLevel.PROPOSE),
        },
        {
          locationId: 'store-1',
          version: version('v-store', StoreFlowAutonomyLevel.AUTO_APPLY),
        },
      ],
      'store-1',
    );
    expect(resolved.policyVersionId).toBe('v-store');
    expect(resolved.autonomyLevel).toBe(StoreFlowAutonomyLevel.AUTO_APPLY);
    expect(resolved.policyLocationId).toBe('store-1');
  });

  it('uses the tenant default at a store with no policy of its own', () => {
    const resolved = resolvePolicy(
      [
        {
          locationId: null,
          version: version('v-tenant', StoreFlowAutonomyLevel.PROPOSE),
        },
        {
          locationId: 'store-2',
          version: version('v-other', StoreFlowAutonomyLevel.AUTO_APPLY),
        },
      ],
      'store-1',
    );
    expect(resolved.policyVersionId).toBe('v-tenant');
  });

  it('ignores a policy row with no active version rather than treating it as permissive', () => {
    const resolved = resolvePolicy(
      [{ locationId: 'store-1', version: null }],
      'store-1',
    );
    expect(resolved.autonomyLevel).toBe(StoreFlowAutonomyLevel.SHADOW);
  });

  it('falls back to the tenant default when the store policy is half-configured', () => {
    const resolved = resolvePolicy(
      [
        { locationId: 'store-1', version: null },
        {
          locationId: null,
          version: version('v-tenant', StoreFlowAutonomyLevel.PROPOSE),
        },
      ],
      'store-1',
    );
    expect(resolved.policyVersionId).toBe('v-tenant');
  });
});

describe('store-flow projection decision', () => {
  it('does nothing at all under SHADOW, whatever the observation', () => {
    const decision = decideProjection(pickup(), policy(), 'PLAUSIBLE');
    expect(decision.outcome).toBe(StoreFlowProjectionOutcome.SKIPPED);
    expect(decision.reasonCode).toBe(PROJECTION_REASON.SHADOW_MODE);
    expect(decision.createsVisionEvent).toBe(false);
    expect(decision.autoApproves).toBe(false);
  });

  it('proposes without applying under PROPOSE, even at full confidence', () => {
    const decision = decideProjection(
      pickup({ matchScore: 1 }),
      policy({ autonomyLevel: StoreFlowAutonomyLevel.PROPOSE }),
      'PLAUSIBLE',
    );
    expect(decision.outcome).toBe(StoreFlowProjectionOutcome.PROPOSED);
    expect(decision.createsVisionEvent).toBe(true);
    expect(decision.autoApproves).toBe(false);
  });

  it('applies a confident, inventory-validated pickup under AUTO_APPLY', () => {
    const decision = decideProjection(
      pickup({ matchScore: 0.8 }),
      policy({
        autonomyLevel: StoreFlowAutonomyLevel.AUTO_APPLY,
        autoApplyMinConfidence: 0.7,
      }),
      'PLAUSIBLE',
    );
    expect(decision.outcome).toBe(StoreFlowProjectionOutcome.AUTO_APPLIED);
    expect(decision.autoApproves).toBe(true);
    expect(decision.visionEventType).toBe(VisionEventType.PRODUCT_PICKUP);
  });

  it('never auto-applies below the configured confidence', () => {
    const decision = decideProjection(
      pickup({ matchScore: 0.69 }),
      policy({
        autonomyLevel: StoreFlowAutonomyLevel.AUTO_APPLY,
        autoApplyMinConfidence: 0.7,
      }),
      'PLAUSIBLE',
    );
    expect(decision.autoApproves).toBe(false);
    expect(decision.outcome).toBe(StoreFlowProjectionOutcome.PROPOSED);
    expect(decision.reasonCode).toBe(
      PROJECTION_REASON.BELOW_CONFIDENCE_THRESHOLD,
    );
  });

  it('never auto-applies an observation that carries no score at all', () => {
    const decision = decideProjection(
      pickup({ matchScore: null }),
      policy({ autonomyLevel: StoreFlowAutonomyLevel.AUTO_APPLY }),
      'PLAUSIBLE',
    );
    expect(decision.autoApproves).toBe(false);
    expect(decision.reasonCode).toBe(PROJECTION_REASON.NO_CONFIDENCE_RECORDED);
  });

  it('never auto-applies a confident proposal that inventory calls implausible', () => {
    const decision = decideProjection(
      pickup({ matchScore: 0.99 }),
      policy({
        autonomyLevel: StoreFlowAutonomyLevel.AUTO_APPLY,
        autoApplyMinConfidence: 0.5,
      }),
      'IMPLAUSIBLE',
    );
    expect(decision.autoApproves).toBe(false);
    expect(decision.reasonCode).toBe(PROJECTION_REASON.INVENTORY_IMPLAUSIBLE);
  });

  it('applies a confident proposal when inventory validation is switched off', () => {
    const decision = decideProjection(
      pickup({ matchScore: 0.99 }),
      policy({
        autonomyLevel: StoreFlowAutonomyLevel.AUTO_APPLY,
        autoApplyMinConfidence: 0.5,
        requireInventoryValidation: false,
      }),
      'IMPLAUSIBLE',
    );
    expect(decision.autoApproves).toBe(true);
  });

  it('sends an observation the pipeline itself flagged to a human', () => {
    const decision = decideProjection(
      pickup({ eventType: CustomerJourneyEventType.REVIEW_REQUIRED }),
      policy({ autonomyLevel: StoreFlowAutonomyLevel.AUTO_APPLY }),
      'PLAUSIBLE',
    );
    expect(decision.outcome).toBe(StoreFlowProjectionOutcome.REVIEW_REQUIRED);
    expect(decision.reasonCode).toBe(PROJECTION_REASON.PIPELINE_FLAGGED_REVIEW);
    expect(decision.createsVisionEvent).toBe(false);
  });

  it('sends a movement with no catalog product to a human rather than dropping it', () => {
    const decision = decideProjection(
      pickup({ productId: null }),
      policy({ autonomyLevel: StoreFlowAutonomyLevel.AUTO_APPLY }),
      'PLAUSIBLE',
    );
    expect(decision.outcome).toBe(StoreFlowProjectionOutcome.REVIEW_REQUIRED);
    expect(decision.reasonCode).toBe(PROJECTION_REASON.UNKNOWN_PRODUCT);
  });

  it.each([
    CustomerJourneyEventType.ENTRY,
    CustomerJourneyEventType.EXIT,
    CustomerJourneyEventType.SHELF_INTERACTION,
  ])('skips %s, which is not a product movement', (eventType) => {
    const decision = decideProjection(
      pickup({ eventType }),
      policy({ autonomyLevel: StoreFlowAutonomyLevel.AUTO_APPLY }),
      'PLAUSIBLE',
    );
    expect(decision.outcome).toBe(StoreFlowProjectionOutcome.SKIPPED);
    expect(decision.createsVisionEvent).toBe(false);
  });

  it('maps a return onto the vision return type', () => {
    const decision = decideProjection(
      pickup({ eventType: CustomerJourneyEventType.PRODUCT_RETURN }),
      policy({ autonomyLevel: StoreFlowAutonomyLevel.PROPOSE }),
      'PLAUSIBLE',
    );
    expect(decision.visionEventType).toBe(VisionEventType.PRODUCT_RETURN);
  });

  it('maps only product movements onto vision event types', () => {
    expect(visionEventTypeFor(CustomerJourneyEventType.ENTRY)).toBeNull();
    expect(visionEventTypeFor(CustomerJourneyEventType.PRODUCT_PICKUP)).toBe(
      VisionEventType.PRODUCT_PICKUP,
    );
  });
});

describe('inventory validation of a proposal', () => {
  it('calls a pickup plausible when the store holds enough stock', () => {
    expect(
      inventoryVerdict(CustomerJourneyEventType.PRODUCT_PICKUP, 3, 2),
    ).toBe('PLAUSIBLE');
  });

  it('calls a pickup implausible when the store holds too little', () => {
    expect(
      inventoryVerdict(CustomerJourneyEventType.PRODUCT_PICKUP, 1, 2),
    ).toBe('IMPLAUSIBLE');
  });

  it('calls a pickup implausible when the store does not stock the product at all', () => {
    expect(
      inventoryVerdict(CustomerJourneyEventType.PRODUCT_PICKUP, null, 1),
    ).toBe('IMPLAUSIBLE');
  });

  it('always allows a return, which puts stock back', () => {
    expect(
      inventoryVerdict(CustomerJourneyEventType.PRODUCT_RETURN, null, 5),
    ).toBe('PLAUSIBLE');
  });

  it('does not check anything that is not a product movement', () => {
    expect(inventoryVerdict(CustomerJourneyEventType.ENTRY, 0, 1)).toBe(
      'NOT_CHECKED',
    );
  });
});

describe('store entry credentials', () => {
  it('returns a secret and stores only its digest', () => {
    const minted = mintEntryToken();
    expect(minted.secret).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(minted.secret.length).toBeGreaterThanOrEqual(32);
    expect(minted.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(minted.tokenHash).not.toContain(minted.secret);
    expect(hashEntryToken(minted.secret)).toBe(minted.tokenHash);
  });

  it('mints a different secret every time', () => {
    const seen = new Set(
      Array.from({ length: 50 }, () => mintEntryToken().secret),
    );
    expect(seen.size).toBe(50);
  });

  it('matches digests without leaking length differences', () => {
    const a = hashEntryToken('one');
    expect(digestsMatch(a, hashEntryToken('one'))).toBe(true);
    expect(digestsMatch(a, hashEntryToken('two'))).toBe(false);
    expect(digestsMatch(a, 'short')).toBe(false);
  });

  const now = new Date('2026-09-16T12:00:00Z');

  it('accepts an unused credential inside its window', () => {
    expect(
      entryTokenUsable(
        { status: 'ISSUED', expiresAt: new Date('2026-09-16T12:01:00Z') },
        now,
      ),
    ).toEqual({ usable: true });
  });

  it('refuses a credential that has already been redeemed', () => {
    expect(
      entryTokenUsable(
        { status: 'REDEEMED', expiresAt: new Date('2026-09-16T12:01:00Z') },
        now,
      ),
    ).toEqual({ usable: false, reason: 'ALREADY_USED' });
  });

  it('refuses a revoked credential', () => {
    expect(
      entryTokenUsable(
        { status: 'REVOKED', expiresAt: new Date('2026-09-16T12:01:00Z') },
        now,
      ),
    ).toEqual({ usable: false, reason: 'REVOKED' });
  });

  it('refuses a credential at the instant it expires, not a moment later', () => {
    expect(entryTokenUsable({ status: 'ISSUED', expiresAt: now }, now)).toEqual({
      usable: false,
      reason: 'EXPIRED',
    });
  });
});
