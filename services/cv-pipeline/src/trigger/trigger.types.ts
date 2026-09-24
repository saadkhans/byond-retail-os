/**
 * TIER-2 VOCABULARY — moments, not outcomes.
 *
 * A trigger says "something happened here, between these two instants,
 * and it is worth spending a heavy model on". It never says what was
 * taken. The API's inference job, fusion and review flow decide that.
 */

/**
 * The closed set of moments the trigger layer recognises. It mirrors the
 * examples ARCHITECTURE.md gives for the trigger tier — a hand entering a
 * shelf zone, a suspected shelf change, a customer exit — and adding to
 * it is a deliberate product decision, not an implementation detail.
 */
export const TRIGGER_KINDS = [
  'HAND_IN_ZONE',
  'SHELF_CHANGE',
  'CUSTOMER_EXIT',
] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

/**
 * Why a candidate moment was NOT turned into a job. Closed vocabulary so
 * the metrics snapshot can report suppression honestly instead of a
 * trigger simply vanishing.
 */
export const SUPPRESSION_REASONS = [
  'DEBOUNCED',
  'RATE_LIMITED',
  'BELOW_THRESHOLD',
] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

/** Numeric evidence for a trigger. Numbers only — no pixels, no paths,
 *  no identities — because this rides into a job descriptor that the API
 *  screens for exactly those things. */
export interface TriggerEvidence {
  /** Peak whole-frame motion across the moment. */
  peakMotionRatio: number;
  /** Peak coverage of the zone that triggered, when a zone did. */
  peakZoneCoverage: number;
  /** How many sampled frames the moment spanned. */
  frameCount: number;
  /** Peak presence confidence across the moment. */
  peakPresenceConfidence: number;
}

export interface Trigger {
  kind: TriggerKind;
  /** Configured zone code, when the moment was localised to one. */
  zoneCode?: string;
  startedAt: Date;
  endedAt: Date;
  /** Frame index where the moment began, for correlating with a run. */
  startFrameIndex: number;
  endFrameIndex: number;
  evidence: TriggerEvidence;
}

export interface SuppressedTrigger {
  kind: TriggerKind;
  zoneCode?: string;
  reason: SuppressionReason;
}

/** Everything one observation produced: zero or more emitted triggers and
 *  zero or more suppressions, so nothing is lost silently. */
export interface TriggerOutcome {
  emitted: Trigger[];
  suppressed: SuppressedTrigger[];
}

export interface TriggerPolicyConfig {
  /** Zone coverage at or above which a zone counts as being reached into. */
  zoneCoverageThreshold: number;
  /** Whole-frame motion at or above which the scene counts as active. */
  motionRatioThreshold: number;
  /**
   * A moment must stay active for at least this long before it is
   * emitted. Filters the single-frame flickers that a cheap tracker
   * produces on compression churn.
   */
  minDurationMs: number;
  /**
   * The scene must be quiet for this long before the same zone can
   * trigger again. This is the debounce: a shopper who stands with a hand
   * in a zone for ten seconds is ONE moment, not ten.
   */
  reArmQuietMs: number;
  /**
   * A moment that never ends must still be emitted eventually, or a
   * camera pointed at a busy aisle would never produce a job at all.
   */
  maxDurationMs: number;
  /** Token bucket: emissions allowed per window, across all zones. */
  rateLimitPerWindow: number;
  rateLimitWindowMs: number;
  /**
   * Whole-frame motion below this, for this long, after activity, reads
   * as the customer having left.
   */
  exitQuietMs: number;
}
