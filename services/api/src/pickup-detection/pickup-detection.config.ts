import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isEnvFlagEnabled } from '../config/env.validation';

/**
 * Phase 10 pickup-detection MVP configuration. All knobs are env-driven
 * with safe defaults; parsing is fail-closed to the default (never a
 * silent zero — mirrors the video-ingest config style).
 */

export const DEFAULT_ANALYSIS_FPS = 5;
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.62;
export const DEFAULT_ANALYSIS_WIDTH = 192;

function boundedNumber(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = Number(raw);
  return Number.isFinite(value) && value >= min && value <= max
    ? value
    : fallback;
}

@Injectable()
export class PickupDetectionConfig {
  /** Master switch for the automatic worker AND the manual run endpoint. */
  readonly enabled: boolean;

  /** Analysis sampling rate (frames per second of source time). */
  readonly analysisFps: number;

  /** Downscaled analysis width; height follows the source aspect. */
  readonly analysisWidth: number;

  /**
   * Recognition confidence below this claims NOTHING: the event records
   * UNKNOWN_PRODUCT with productId null (requirement: an uncertain match
   * is never presented as an identification).
   */
  readonly confidenceThreshold: number;

  constructor(config: ConfigService) {
    this.enabled = isEnvFlagEnabled(
      config.get<string>('PICKUP_DETECTION_ENABLED'),
    );
    this.analysisFps = boundedNumber(
      config.get<string>('PICKUP_ANALYSIS_FPS'),
      DEFAULT_ANALYSIS_FPS,
      1,
      15,
    );
    this.analysisWidth = DEFAULT_ANALYSIS_WIDTH;
    this.confidenceThreshold = boundedNumber(
      config.get<string>('PICKUP_CONFIDENCE_THRESHOLD'),
      DEFAULT_CONFIDENCE_THRESHOLD,
      0,
      1,
    );
  }
}
