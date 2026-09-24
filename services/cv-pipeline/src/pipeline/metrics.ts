import { FrameSourceErrorCode } from '../tracking/frame-source.port';
import { SuppressionReason, TriggerKind } from '../trigger/trigger.types';
import { QueueCounters } from '../jobs/trigger-queue';

/**
 * The operational snapshot.
 *
 * Every field is a NUMBER or a value from a closed vocabulary. No paths,
 * no URLs, no messages, no identifiers a reader could aim a request at.
 * That constraint is what lets the metrics endpoint be cheap to expose:
 * the worst an unauthorised reader learns is how busy a camera is.
 *
 * The counters are chosen so that "quiet" and "broken" cannot be confused.
 * A pipeline emitting nothing because the aisle is empty and one emitting
 * nothing because every trigger is rate-limited look identical from
 * `triggersEmitted` alone — so suppressions are counted by reason, and
 * frame failures by code.
 */
export interface PipelineMetrics {
  runId: string;
  running: boolean;
  framesSampled: number;
  framesFailed: number;
  observations: number;
  triggersEmitted: number;
  triggersSuppressed: number;
  suppressionsByReason: Record<SuppressionReason, number>;
  triggersByKind: Record<TriggerKind, number>;
  frameErrorsByCode: Record<string, number>;
  lastFrameErrorCode: FrameSourceErrorCode | null;
  descriptorsBlockedByMediaPolicy: number;
  queue: QueueCounters;
}

export class MetricsRecorder {
  private framesSampled = 0;
  private framesFailed = 0;
  private observations = 0;
  private triggersEmitted = 0;
  private triggersSuppressed = 0;
  private descriptorsBlocked = 0;
  private lastFrameErrorCode: FrameSourceErrorCode | null = null;

  private readonly suppressionsByReason: Record<SuppressionReason, number> = {
    DEBOUNCED: 0,
    RATE_LIMITED: 0,
    BELOW_THRESHOLD: 0,
  };

  private readonly triggersByKind: Record<TriggerKind, number> = {
    HAND_IN_ZONE: 0,
    SHELF_CHANGE: 0,
    CUSTOMER_EXIT: 0,
  };

  private readonly frameErrorsByCode: Record<string, number> = {};

  constructor(private readonly runId: string) {}

  recordFrame(): void {
    this.framesSampled += 1;
  }

  recordFrameFailure(code: FrameSourceErrorCode): void {
    this.framesFailed += 1;
    this.lastFrameErrorCode = code;
    this.frameErrorsByCode[code] = (this.frameErrorsByCode[code] ?? 0) + 1;
  }

  recordObservation(): void {
    this.observations += 1;
  }

  recordEmitted(kind: TriggerKind): void {
    this.triggersEmitted += 1;
    this.triggersByKind[kind] += 1;
  }

  recordSuppressed(reason: SuppressionReason): void {
    this.triggersSuppressed += 1;
    this.suppressionsByReason[reason] += 1;
  }

  recordMediaPolicyBlock(): void {
    this.descriptorsBlocked += 1;
  }

  snapshot(running: boolean, queue: QueueCounters): PipelineMetrics {
    return {
      runId: this.runId,
      running,
      framesSampled: this.framesSampled,
      framesFailed: this.framesFailed,
      observations: this.observations,
      triggersEmitted: this.triggersEmitted,
      triggersSuppressed: this.triggersSuppressed,
      suppressionsByReason: { ...this.suppressionsByReason },
      triggersByKind: { ...this.triggersByKind },
      frameErrorsByCode: { ...this.frameErrorsByCode },
      lastFrameErrorCode: this.lastFrameErrorCode,
      descriptorsBlockedByMediaPolicy: this.descriptorsBlocked,
      queue,
    };
  }
}
