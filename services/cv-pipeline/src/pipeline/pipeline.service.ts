import { randomUUID } from 'node:crypto';
import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { PipelineConfig } from '../config/pipeline.config';
import { FrameSourcePort } from '../tracking/frame-source.port';
import { TrackerPort } from '../tracking/tracker.port';
import { TriggerPolicy } from '../trigger/trigger.policy';
import { TriggerQueue } from '../jobs/trigger-queue';
import { buildJobRequest } from '../jobs/job-request.builder';
import { MetricsRecorder, PipelineMetrics } from './metrics';

/**
 * The loop that ties the three tiers together.
 *
 *   sample a downscaled frame  (tier 1, frame source)
 *     -> observe it            (tier 1, tracker)
 *     -> decide if it matters  (tier 2, trigger policy)
 *     -> enqueue a job         (bounded queue)
 *     -> drain toward the API  (tier 3 lives there, not here)
 *
 * WHAT THIS SERVICE NEVER DOES: decide a product, write to a basket,
 * touch inventory, or store a frame. Those belong to the API, and the
 * boundary is not a convention — `no-commerce-effect.spec.ts` greps this
 * package for the write vocabulary the API's own shadow-mode guards use.
 *
 * SAMPLING IS SELF-PACING. A fixed interval with a slow source would let
 * overlapping samples pile up, so the next sample is scheduled only after
 * the previous one completes, and the interval is a floor on the gap
 * rather than a promise about the rate.
 */
@Injectable()
export class PipelineService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(PipelineService.name);
  private readonly runId = randomUUID();
  private readonly metrics = new MetricsRecorder(this.runId);

  private running = false;
  private stopping = false;
  private timer: NodeJS.Timeout | null = null;
  private frameIndex = 0;
  /** Position within a file-backed development source. A live camera
   *  ignores it; without it a file source returns frame zero forever. */
  private seekMs = 0;
  private degraded = false;

  constructor(
    private readonly config: PipelineConfig,
    private readonly frameSource: FrameSourcePort,
    private readonly tracker: TrackerPort,
    private readonly policy: TriggerPolicy,
    private readonly queue: TriggerQueue,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const ready = await this.frameSource.checkReady();
    if (!ready) {
      // Not fatal. A pipeline that refuses to start because a camera is
      // unplugged also refuses to report that the camera is unplugged.
      this.logger.warn(
        `Frame source "${this.frameSource.kind}" is not ready; the loop will ` +
          'start and report frame failures until it is.',
      );
    }
    this.start();
  }

  onApplicationShutdown(): void {
    this.stop();
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.stopping = false;
    this.tracker.reset();
    this.policy.reset();
    this.logger.log(
      `Tracking run ${this.runId} started ` +
        `(source=${this.frameSource.kind}, tracker=${this.tracker.kind}, ` +
        `realBytes=${this.frameSource.readsRealBytes}, ` +
        `zones=${this.config.zones.length})`,
    );
    this.scheduleNext(0);
  }

  stop(): void {
    this.stopping = true;
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  metricsSnapshot(): PipelineMetrics {
    return this.metrics.snapshot(this.running, this.queue.counters());
  }

  /**
   * ONE full cycle: sample, observe, decide, enqueue, drain.
   *
   * Public and self-contained so the loop is not the only way to run it.
   * A scheduler-driven loop that can only be exercised through timers is
   * a loop whose failure handling never gets tested, and the failure
   * handling is the part that matters here.
   *
   * Never throws: an unhandled rejection would kill the loop and, with
   * it, the store's only source of tracking.
   */
  async runOnce(): Promise<void> {
    try {
      await this.sampleAndProcess();
      await this.queue.drain(Date.now());
    } catch (error) {
      // Class only. An error message from a frame source or an HTTP client
      // can carry the camera address or the request URL.
      this.logger.error(
        `Tracking cycle failed (${errorClass(error)}); continuing.`,
      );
    }
  }

  private async tick(): Promise<void> {
    if (this.stopping) {
      return;
    }
    const started = Date.now();
    await this.runOnce();
    if (!this.stopping) {
      const elapsed = Date.now() - started;
      this.scheduleNext(Math.max(0, this.config.frame.intervalMs - elapsed));
    }
  }

  private async sampleAndProcess(): Promise<void> {
    const result = await this.frameSource.sample({
      width: this.config.frame.width,
      height: this.config.frame.height,
      timeoutMs: this.config.frame.timeoutMs,
      seekMs: this.seekMs,
    });

    if (!result.ok) {
      this.metrics.recordFrameFailure(result.code);
      // A gap in the stream must not be diffed against a frame from
      // before it — that reads as a scene full of motion.
      this.tracker.reset();
      return;
    }

    this.metrics.recordFrame();
    this.seekMs += this.config.frame.intervalMs;
    this.frameIndex += 1;

    const observation = this.tracker.observe(result.frame, this.frameIndex);
    if (observation === null) {
      // The first frame of a run is a baseline, not an observation.
      return;
    }
    this.metrics.recordObservation();

    const outcome = this.policy.observe(observation);
    for (const suppression of outcome.suppressed) {
      this.metrics.recordSuppressed(suppression.reason);
    }

    for (const trigger of outcome.emitted) {
      this.metrics.recordEmitted(trigger.kind);
      const built = buildJobRequest(trigger, {
        locationId: this.config.context.locationId,
        unitId: this.config.context.unitId,
        deviceId: this.config.context.deviceId,
        runId: this.runId,
        trackerKind: this.tracker.kind,
        readsRealBytes: this.frameSource.readsRealBytes,
      });

      if (!built.ok) {
        // Fail closed: the descriptor is dropped, and the PATH — never the
        // value — is logged so the bug is findable.
        this.metrics.recordMediaPolicyBlock();
        this.logger.error(
          `Trigger descriptor blocked by the media policy at "${built.path}"; ` +
            'the trigger was dropped.',
        );
        continue;
      }

      const madeRoom = this.queue.offer(built.request, trigger, Date.now());
      if (!madeRoom && !this.degraded) {
        this.degraded = true;
        this.logger.warn(
          'Trigger queue is at capacity; dropping the oldest pending ' +
            'submissions. Tracking continues.',
        );
      } else if (madeRoom && this.degraded) {
        this.degraded = false;
        this.logger.log('Trigger queue recovered below capacity.');
      }
    }
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopping) {
      return;
    }
    this.timer = setTimeout(() => {
      void this.tick();
    }, delayMs);
    // Do not hold the process open for the next tick: shutdown should be
    // able to drain and exit without waiting out an interval.
    this.timer.unref?.();
  }
}

/** The constructor name of a thrown value, or a fixed fallback. Never the
 *  message — messages quote inputs. */
function errorClass(error: unknown): string {
  if (error instanceof Error) {
    return error.name;
  }
  return typeof error;
}
