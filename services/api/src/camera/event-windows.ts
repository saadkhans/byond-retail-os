import { AnalysisFrame, AnalysisGeometry } from '../pickup-detection/analysis/pickup-analyzer';

/**
 * Phase 12 — MVP event-window extraction for the camera replay runtime.
 *
 * Deliberately heuristic (frame-difference motion scoring inside the
 * source's shelf zone), NOT an ML tracker: the windows only nominate
 * moments worth sending through the existing pickup/fusion pipeline. No
 * face recognition, no identity tracking — the score is a mean absolute
 * grayscale difference and nothing else.
 *
 * Everything here is pure and unit-testable with synthetic frames.
 */

export interface MotionSample {
  timestampMs: number;
  /** Mean absolute grayscale difference vs the previous frame (0..255). */
  motionScore: number;
}

export interface EventWindow {
  startMs: number;
  peakMs: number;
  endMs: number;
  /** Uncalibrated 0..1 ranking signal normalized from the peak score —
   *  never a probability. */
  confidence: number;
}

export interface EventWindowConfig {
  /** Motion floor (mean abs grayscale diff, 0..255) a sample must reach. */
  minScore: number;
  /** A candidate shorter than this is discarded as flicker. */
  minDurationMs: number;
  /** A new window may not start within this span of the previous end. */
  cooldownMs: number;
}

/** Defaults tuned for ~2fps replay of shelf clips: an event must hold
 *  motion for at least two samples and events closer than a second are
 *  one physical interaction. */
export const DEFAULT_EVENT_WINDOW_CONFIG: EventWindowConfig = {
  minScore: 8,
  minDurationMs: 400,
  cooldownMs: 1000,
};

/** Confidence normalization: peak at 4× the floor (or above) saturates
 *  to 1. Ranking signal only — documented uncalibrated. */
const CONFIDENCE_SATURATION_MULTIPLIER = 4;

/** 'zone-r2c3' → grid cell (row 2, col 3) of the 3×3 shelf grid used by
 *  shelfZoneFor in pickup-fusion/primitives. Unknown formats → null
 *  (full-frame scoring). */
export function parseShelfZone(
  zone: string | null | undefined,
): { row: number; col: number } | null {
  if (!zone) {
    return null;
  }
  const match = /^zone-r([1-3])c([1-3])$/.exec(zone.trim());
  if (!match) {
    return null;
  }
  return { row: Number(match[1]), col: Number(match[2]) };
}

/**
 * Mean absolute grayscale difference between two same-geometry frames,
 * restricted to one 3×3 grid cell when `zone` names one. Returns 0 for
 * degenerate regions.
 */
export function motionScoreBetween(
  previous: AnalysisFrame,
  current: AnalysisFrame,
  geometry: AnalysisGeometry,
  zone: { row: number; col: number } | null,
): number {
  const cellWidth = Math.floor(geometry.width / 3);
  const cellHeight = Math.floor(geometry.height / 3);
  const x0 = zone ? (zone.col - 1) * cellWidth : 0;
  const y0 = zone ? (zone.row - 1) * cellHeight : 0;
  const x1 = zone ? Math.min(geometry.width, x0 + cellWidth) : geometry.width;
  const y1 = zone ? Math.min(geometry.height, y0 + cellHeight) : geometry.height;
  let total = 0;
  let samples = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const offset = (y * geometry.width + x) * 3;
      const grayPrevious =
        (previous.rgb[offset] +
          previous.rgb[offset + 1] +
          previous.rgb[offset + 2]) /
        3;
      const grayCurrent =
        (current.rgb[offset] +
          current.rgb[offset + 1] +
          current.rgb[offset + 2]) /
        3;
      total += Math.abs(grayCurrent - grayPrevious);
      samples += 1;
    }
  }
  return samples === 0 ? 0 : total / samples;
}

/** Frame stream → per-sample motion scores (sample 0 scores 0 — there is
 *  no previous frame to differ against). */
export function motionSamples(
  frames: AnalysisFrame[],
  geometry: AnalysisGeometry,
  zone: { row: number; col: number } | null,
): MotionSample[] {
  return frames.map((frame, index) => ({
    timestampMs: frame.timestampMs,
    motionScore:
      index === 0
        ? 0
        : motionScoreBetween(frames[index - 1], frame, geometry, zone),
  }));
}

/**
 * Contiguous samples at/above the motion floor become one candidate
 * window; candidates shorter than `minDurationMs` are discarded, and a
 * candidate may not START within `cooldownMs` of the previous accepted
 * window's end (two bursts inside the cooldown are one interaction).
 */
export function extractEventWindows(
  samples: MotionSample[],
  config: EventWindowConfig = DEFAULT_EVENT_WINDOW_CONFIG,
): EventWindow[] {
  const windows: EventWindow[] = [];
  let open: { startMs: number; endMs: number; peakMs: number; peak: number } | null =
    null;
  const close = () => {
    if (!open) {
      return;
    }
    const lastEnd = windows.length
      ? windows[windows.length - 1].endMs
      : Number.NEGATIVE_INFINITY;
    const longEnough = open.endMs - open.startMs >= config.minDurationMs;
    const outsideCooldown = open.startMs >= lastEnd + config.cooldownMs;
    if (longEnough && outsideCooldown) {
      windows.push({
        startMs: open.startMs,
        peakMs: open.peakMs,
        endMs: open.endMs,
        confidence: Math.min(
          1,
          open.peak / (config.minScore * CONFIDENCE_SATURATION_MULTIPLIER),
        ),
      });
    }
    open = null;
  };
  for (const sample of samples) {
    if (sample.motionScore >= config.minScore) {
      if (!open) {
        open = {
          startMs: sample.timestampMs,
          endMs: sample.timestampMs,
          peakMs: sample.timestampMs,
          peak: sample.motionScore,
        };
      } else {
        open.endMs = sample.timestampMs;
        if (sample.motionScore > open.peak) {
          open.peak = sample.motionScore;
          open.peakMs = sample.timestampMs;
        }
      }
    } else {
      close();
    }
  }
  close();
  return windows;
}
