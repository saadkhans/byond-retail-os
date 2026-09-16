import { Injectable } from '@nestjs/common';
import { RgbFrame } from './frame-source.port';
import { TrackerPort } from './tracker.port';
import {
  ShelfZone,
  TrackingObservation,
  clampUnit,
} from './tracking.types';

/**
 * DETERMINISTIC tracker — the default, and the reason CI needs neither
 * ffmpeg nor model weights.
 *
 * It ignores the frame's pixels entirely and derives its numbers from the
 * frame INDEX through a fixed, documented pattern. That is a feature: a
 * test can assert an exact trigger sequence, and an operator surface can
 * tell real tracking from a rehearsal by `readsRealBytes` on the source
 * plus `kind` here.
 *
 * The pattern is a periodic "approach, dwell, withdraw" at one zone at a
 * time, cycling through the configured zones, with quiet frames between
 * visits so the trigger layer's debounce and re-arm logic is exercised.
 */
@Injectable()
export class SimulatedTracker extends TrackerPort {
  readonly kind = 'simulated';

  /** Frames in one visit cycle: 2 quiet, 3 rising, 3 dwell, 2 falling. */
  private static readonly CYCLE_LENGTH = 10;

  constructor(private readonly zones: ShelfZone[]) {
    super();
  }

  reset(): void {
    // Stateless: the pattern is a pure function of the frame index, so a
    // reset has nothing to forget and a reconnect replays identically.
  }

  observe(frame: RgbFrame, frameIndex: number): TrackingObservation | null {
    if (frameIndex <= 0) {
      // Match the real trackers: the first frame of a run is a baseline,
      // never an observation, so a run always starts quiet.
      return null;
    }
    const phase = frameIndex % SimulatedTracker.CYCLE_LENGTH;
    const intensity = SimulatedTracker.intensityForPhase(phase);
    const activeZone =
      this.zones.length === 0
        ? null
        : this.zones[
            Math.floor(frameIndex / SimulatedTracker.CYCLE_LENGTH) %
              this.zones.length
          ];

    return {
      frameIndex,
      capturedAt: frame.capturedAt,
      motionRatio: clampUnit(intensity * 0.4),
      motionRegions:
        activeZone && intensity > 0
          ? [{ box: activeZone.box, intensity: clampUnit(intensity) }]
          : [],
      presence: {
        personLikely: intensity > 0.2,
        handLikely: intensity > 0.5,
        confidence: clampUnit(intensity),
      },
      zones: this.zones.map((zone) => ({
        zoneCode: zone.zoneCode,
        occupied: zone === activeZone && intensity > 0.5,
        coverage: zone === activeZone ? clampUnit(intensity) : 0,
      })),
    };
  }

  /** 0 while quiet, ramping to 1 across the dwell, then back down. */
  private static intensityForPhase(phase: number): number {
    if (phase < 2) {
      return 0;
    }
    if (phase < 5) {
      return (phase - 1) / 4;
    }
    if (phase < 8) {
      return 1;
    }
    return (SimulatedTracker.CYCLE_LENGTH - phase) / 4;
  }
}
