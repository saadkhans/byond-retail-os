import { TrackingObservation } from '../tracking/tracking.types';
import {
  SuppressedTrigger,
  Trigger,
  TriggerEvidence,
  TriggerOutcome,
  TriggerPolicyConfig,
} from './trigger.types';

/**
 * TIER 2 — the trigger layer.
 *
 * A pure state machine over tracking observations. It is deliberately
 * pure: no clock of its own (every instant comes from the observation),
 * no I/O, no injected services. That is what makes the debounce and
 * rate-limit behaviour testable frame by frame, which matters because
 * these two rules are the only thing standing between a busy aisle and a
 * flooded inference queue.
 *
 * The shape of the machine, per zone:
 *
 *   IDLE --coverage >= threshold--> OPEN
 *   OPEN --still covered, < minDuration--> OPEN (accumulating evidence)
 *   OPEN --coverage drops, >= minDuration--> EMIT, then COOLING
 *   OPEN --maxDuration reached--> EMIT, then COOLING (still-open moments
 *                                  must not be held forever)
 *   COOLING --quiet for reArmQuietMs--> IDLE
 *
 * Whole-frame motion runs the same machine for SHELF_CHANGE without a
 * zone, and its falling edge — quiet for exitQuietMs after activity —
 * produces CUSTOMER_EXIT.
 */

/** Per-zone (or global) state for one moment in progress. */
interface MomentState {
  openedAt: Date | null;
  openedFrameIndex: number;
  lastActiveAt: Date | null;
  lastActiveFrameIndex: number;
  peakMotionRatio: number;
  peakZoneCoverage: number;
  peakPresenceConfidence: number;
  frameCount: number;
  /** When the moment closed, so re-arm can be measured from it. */
  cooledAt: Date | null;
  /** True once this moment has been emitted, so a max-duration emission
   *  is not repeated every frame while the zone stays covered. */
  emitted: boolean;
}

function freshMoment(): MomentState {
  return {
    openedAt: null,
    openedFrameIndex: 0,
    lastActiveAt: null,
    lastActiveFrameIndex: 0,
    peakMotionRatio: 0,
    peakZoneCoverage: 0,
    peakPresenceConfidence: 0,
    frameCount: 0,
    cooledAt: null,
    emitted: false,
  };
}

function evidenceOf(state: MomentState): TriggerEvidence {
  return {
    peakMotionRatio: state.peakMotionRatio,
    peakZoneCoverage: state.peakZoneCoverage,
    frameCount: state.frameCount,
    peakPresenceConfidence: state.peakPresenceConfidence,
  };
}

export class TriggerPolicy {
  private readonly zoneStates = new Map<string, MomentState>();
  private readonly sceneState: MomentState = freshMoment();

  /** Emission timestamps inside the current rate-limit window. */
  private readonly recentEmissions: number[] = [];

  /** Last instant the scene showed activity, for the exit rule. */
  private lastSceneActivityAt: Date | null = null;
  /** True once an exit has been emitted for the current quiet stretch, so
   *  a camera watching an empty aisle emits ONE exit, not one per frame. */
  private exitEmittedForQuietStretch = false;

  constructor(private readonly config: TriggerPolicyConfig) {}

  /** Drop all state. Used when a run restarts, so a gap in the stream
   *  cannot close a moment that began before it. */
  reset(): void {
    this.zoneStates.clear();
    Object.assign(this.sceneState, freshMoment());
    this.recentEmissions.length = 0;
    this.lastSceneActivityAt = null;
    this.exitEmittedForQuietStretch = false;
  }

  /**
   * Feed one observation. Returns everything it produced — emitted
   * triggers and suppressed candidates alike, so the caller's metrics can
   * distinguish "quiet camera" from "camera whose triggers are all being
   * dropped", which look identical if suppression is silent.
   */
  observe(observation: TrackingObservation): TriggerOutcome {
    const emitted: Trigger[] = [];
    const suppressed: SuppressedTrigger[] = [];
    const now = observation.capturedAt;

    for (const zone of observation.zones) {
      const state = this.stateForZone(zone.zoneCode);
      const active = zone.coverage >= this.config.zoneCoverageThreshold;
      this.advance(state, observation, active, zone.coverage);
      const decision = this.settle(state, now, active);
      if (decision === 'emit') {
        this.publish(
          {
            kind: 'HAND_IN_ZONE',
            zoneCode: zone.zoneCode,
            startedAt: state.openedAt ?? now,
            endedAt: state.lastActiveAt ?? now,
            startFrameIndex: state.openedFrameIndex,
            endFrameIndex: state.lastActiveFrameIndex,
            evidence: evidenceOf(state),
          },
          now,
          emitted,
          suppressed,
        );
        state.emitted = true;
      } else if (decision === 'too-short') {
        suppressed.push({
          kind: 'HAND_IN_ZONE',
          zoneCode: zone.zoneCode,
          reason: 'BELOW_THRESHOLD',
        });
      } else if (decision === 'debounced') {
        suppressed.push({
          kind: 'HAND_IN_ZONE',
          zoneCode: zone.zoneCode,
          reason: 'DEBOUNCED',
        });
      }
    }

    const sceneActive =
      observation.motionRatio >= this.config.motionRatioThreshold;
    if (sceneActive) {
      this.lastSceneActivityAt = now;
      this.exitEmittedForQuietStretch = false;
    }
    this.advance(this.sceneState, observation, sceneActive, 0);
    const sceneDecision = this.settle(this.sceneState, now, sceneActive);
    if (sceneDecision === 'emit') {
      this.publish(
        {
          kind: 'SHELF_CHANGE',
          startedAt: this.sceneState.openedAt ?? now,
          endedAt: this.sceneState.lastActiveAt ?? now,
          startFrameIndex: this.sceneState.openedFrameIndex,
          endFrameIndex: this.sceneState.lastActiveFrameIndex,
          evidence: evidenceOf(this.sceneState),
        },
        now,
        emitted,
        suppressed,
      );
      this.sceneState.emitted = true;
    } else if (sceneDecision === 'too-short') {
      suppressed.push({ kind: 'SHELF_CHANGE', reason: 'BELOW_THRESHOLD' });
    } else if (sceneDecision === 'debounced') {
      suppressed.push({ kind: 'SHELF_CHANGE', reason: 'DEBOUNCED' });
    }

    const exit = this.exitTrigger(observation, sceneActive);
    if (exit !== null) {
      this.publish(exit, now, emitted, suppressed);
      this.exitEmittedForQuietStretch = true;
    }

    return { emitted, suppressed };
  }

  private stateForZone(zoneCode: string): MomentState {
    const existing = this.zoneStates.get(zoneCode);
    if (existing !== undefined) {
      return existing;
    }
    const created = freshMoment();
    this.zoneStates.set(zoneCode, created);
    return created;
  }

  /** Accumulate evidence while a moment is active. */
  private advance(
    state: MomentState,
    observation: TrackingObservation,
    active: boolean,
    coverage: number,
  ): void {
    if (!active) {
      return;
    }
    if (state.openedAt === null) {
      state.openedAt = observation.capturedAt;
      state.openedFrameIndex = observation.frameIndex;
      state.frameCount = 0;
      state.peakMotionRatio = 0;
      state.peakZoneCoverage = 0;
      state.peakPresenceConfidence = 0;
      state.emitted = false;
    }
    state.lastActiveAt = observation.capturedAt;
    state.lastActiveFrameIndex = observation.frameIndex;
    state.frameCount += 1;
    state.peakMotionRatio = Math.max(
      state.peakMotionRatio,
      observation.motionRatio,
    );
    state.peakZoneCoverage = Math.max(state.peakZoneCoverage, coverage);
    state.peakPresenceConfidence = Math.max(
      state.peakPresenceConfidence,
      observation.presence.confidence,
    );
  }

  /**
   * Decide what to do with a moment now that this frame has been folded
   * in. Returns the outcome so the caller builds the trigger with the
   * right kind and zone; this method owns only the timing rules.
   */
  private settle(
    state: MomentState,
    now: Date,
    active: boolean,
  ): 'emit' | 'too-short' | 'debounced' | 'none' {
    if (state.openedAt === null) {
      // Not in a moment. Let the re-arm timer run down.
      if (
        state.cooledAt !== null &&
        now.getTime() - state.cooledAt.getTime() >= this.config.reArmQuietMs
      ) {
        state.cooledAt = null;
      }
      return 'none';
    }

    const openMs = now.getTime() - state.openedAt.getTime();

    if (active) {
      // Still open. Emit only if it has run past the ceiling, so a
      // permanently-busy zone still produces jobs.
      if (!state.emitted && openMs >= this.config.maxDurationMs) {
        return this.gateByReArm(state, now);
      }
      return 'none';
    }

    // Falling edge: the moment just closed.
    const duration =
      (state.lastActiveAt ?? state.openedAt).getTime() -
      state.openedAt.getTime();
    const alreadyEmitted = state.emitted;
    const closed = this.close(state, now);
    if (alreadyEmitted) {
      // Its max-duration emission already happened; closing is silent.
      return 'none';
    }
    if (duration < this.config.minDurationMs) {
      return 'too-short';
    }
    return closed;
  }

  /** Close a moment and return whether the re-arm window allows emitting. */
  private close(
    state: MomentState,
    now: Date,
  ): 'emit' | 'debounced' {
    const gate = this.gateByReArm(state, now);
    state.cooledAt = now;
    state.openedAt = null;
    return gate;
  }

  /**
   * The debounce. A zone that emitted recently stays quiet until it has
   * been still for `reArmQuietMs` — otherwise one shopper lingering at a
   * shelf becomes a stream of identical jobs.
   */
  private gateByReArm(
    state: MomentState,
    now: Date,
  ): 'emit' | 'debounced' {
    if (state.cooledAt === null) {
      return 'emit';
    }
    const quietMs = now.getTime() - state.cooledAt.getTime();
    return quietMs >= this.config.reArmQuietMs ? 'emit' : 'debounced';
  }

  /**
   * The rate limit, applied at the moment of publication so it covers
   * every kind uniformly. A token bucket over a sliding window: cheaper
   * than a queue, and it degrades the way an operator expects — the first
   * N moments in a window get through and the rest are recorded as
   * suppressed rather than silently lost.
   */
  private publish(
    trigger: Trigger,
    now: Date,
    emitted: Trigger[],
    suppressed: SuppressedTrigger[],
  ): void {
    const windowStart = now.getTime() - this.config.rateLimitWindowMs;
    while (
      this.recentEmissions.length > 0 &&
      this.recentEmissions[0] <= windowStart
    ) {
      this.recentEmissions.shift();
    }
    if (this.recentEmissions.length >= this.config.rateLimitPerWindow) {
      suppressed.push({
        kind: trigger.kind,
        zoneCode: trigger.zoneCode,
        reason: 'RATE_LIMITED',
      });
      return;
    }
    this.recentEmissions.push(now.getTime());
    emitted.push(trigger);
  }

  /**
   * CUSTOMER_EXIT: the scene was active, then went quiet for long enough
   * that whoever was there has gone. Emitted once per quiet stretch.
   */
  private exitTrigger(
    observation: TrackingObservation,
    sceneActive: boolean,
  ): Trigger | null {
    if (sceneActive || this.exitEmittedForQuietStretch) {
      return null;
    }
    const lastActivity = this.lastSceneActivityAt;
    if (lastActivity === null) {
      // Nothing has happened yet in this run; an empty aisle at startup
      // is not an exit.
      return null;
    }
    const quietMs = observation.capturedAt.getTime() - lastActivity.getTime();
    if (quietMs < this.config.exitQuietMs) {
      return null;
    }
    return {
      kind: 'CUSTOMER_EXIT',
      startedAt: lastActivity,
      endedAt: observation.capturedAt,
      startFrameIndex: observation.frameIndex,
      endFrameIndex: observation.frameIndex,
      evidence: {
        peakMotionRatio: observation.motionRatio,
        peakZoneCoverage: 0,
        frameCount: 1,
        peakPresenceConfidence: observation.presence.confidence,
      },
    };
  }
}
