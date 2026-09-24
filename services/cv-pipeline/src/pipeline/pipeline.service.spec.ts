import { Logger } from '@nestjs/common';
import { PipelineConfig } from '../config/pipeline.config';
import { FrameSourceKind, TrackerKind } from '../config/env.validation';
import {
  FrameResult,
  FrameSourceOptions,
  FrameSourcePort,
} from '../tracking/frame-source.port';
import { TrackerPort } from '../tracking/tracker.port';
import { SimulatedFrameSource } from '../tracking/simulated-frame-source.adapter';
import { MotionTracker } from '../tracking/motion-tracker.adapter';
import { TriggerPolicy } from '../trigger/trigger.policy';
import { TriggerQueue } from '../jobs/trigger-queue';
import {
  InferenceClientPort,
  InferenceJobRequest,
  SubmitOutcome,
  SubmitResult,
} from '../jobs/inference-client.port';
import { PipelineService } from './pipeline.service';

const ZONES = [
  { zoneCode: 'A1', box: { x: 0, y: 0, width: 1, height: 1 } },
];

function config(overrides: Partial<PipelineConfig> = {}): PipelineConfig {
  return {
    port: 3100,
    api: { baseUrl: 'http://127.0.0.1:3000', token: 'x'.repeat(20), timeoutMs: 1_000 },
    context: { locationId: 'loc_1', unitId: 'unit_1' },
    frameSource: FrameSourceKind.Simulated,
    tracker: TrackerKind.Motion,
    sourceEnvKey: null,
    frame: { width: 64, height: 48, intervalMs: 100, timeoutMs: 1_000 },
    motion: { pixelDeltaThreshold: 18, cellActivationRatio: 0.05 },
    zones: ZONES,
    trigger: {
      zoneCoverageThreshold: 0.05,
      motionRatioThreshold: 0.02,
      minDurationMs: 0,
      reArmQuietMs: 0,
      maxDurationMs: 15_000,
      rateLimitPerWindow: 100,
      rateLimitWindowMs: 60_000,
      exitQuietMs: 8_000,
    },
    queue: {
      capacity: 10,
      maxAttempts: 3,
      backoffBaseMs: 1_000,
      backoffMaxMs: 10_000,
    },
    ...overrides,
  };
}

class RecordingClient extends InferenceClientPort {
  readonly kind = 'recording';
  readonly seen: InferenceJobRequest[] = [];

  constructor(private readonly outcome: SubmitOutcome = 'ACCEPTED') {
    super();
  }

  submit(request: InferenceJobRequest): Promise<SubmitResult> {
    this.seen.push(request);
    return Promise.resolve({ outcome: this.outcome });
  }
}

/** A source that always fails, to exercise degradation. */
class FailingFrameSource extends FrameSourcePort {
  readonly kind = 'failing';
  readonly readsRealBytes = false;

  checkReady(): Promise<boolean> {
    return Promise.resolve(false);
  }

  sample(_options: FrameSourceOptions): Promise<FrameResult> {
    void _options;
    return Promise.resolve({ ok: false, code: 'SOURCE_CONNECT_FAILED' });
  }
}

/** A source that throws, to prove one bad cycle cannot kill the loop. */
class ThrowingFrameSource extends FrameSourcePort {
  readonly kind = 'throwing';
  readonly readsRealBytes = false;

  checkReady(): Promise<boolean> {
    return Promise.resolve(true);
  }

  sample(): Promise<FrameResult> {
    return Promise.reject(new Error('rtsp://camera.local/private went away'));
  }
}

function build(
  overrides: {
    pipelineConfig?: PipelineConfig;
    frameSource?: FrameSourcePort;
    tracker?: TrackerPort;
    client?: InferenceClientPort;
  } = {},
): { service: PipelineService; client: InferenceClientPort } {
  const pipelineConfig = overrides.pipelineConfig ?? config();
  const client = overrides.client ?? new RecordingClient();
  const queue = new TriggerQueue(client, pipelineConfig.queue);
  const service = new PipelineService(
    pipelineConfig,
    overrides.frameSource ?? new SimulatedFrameSource(),
    overrides.tracker ??
      new MotionTracker(
        pipelineConfig.zones,
        pipelineConfig.motion.pixelDeltaThreshold,
        pipelineConfig.motion.cellActivationRatio,
      ),
    new TriggerPolicy(pipelineConfig.trigger),
    queue,
  );
  return { service, client };
}

describe('PipelineService — the happy path end to end', () => {
  it('turns sampled frames into submitted inference jobs', async () => {
    const { service, client } = build();
    const recording = client as RecordingClient;

    for (let cycle = 0; cycle < 30; cycle += 1) {
      await service.runOnce();
    }

    expect(recording.seen.length).toBeGreaterThan(0);
    const metrics = service.metricsSnapshot();
    expect(metrics.framesSampled).toBe(30);
    expect(metrics.observations).toBe(29); // the first frame is a baseline
    expect(metrics.triggersEmitted).toBeGreaterThan(0);
    expect(metrics.queue.accepted).toBe(recording.seen.length);
  });

  it('stamps every job with the same run id', async () => {
    const { service, client } = build();
    const recording = client as RecordingClient;

    for (let cycle = 0; cycle < 30; cycle += 1) {
      await service.runOnce();
    }

    const runIds = new Set(
      recording.seen.map(
        (request) =>
          (request.inputDescriptor.provenance as { runId: string }).runId,
      ),
    );
    expect(runIds.size).toBe(1);
    expect([...runIds][0]).toBe(service.metricsSnapshot().runId);
  });

  it('marks jobs as not coming from real camera bytes when simulated', async () => {
    const { service, client } = build();
    const recording = client as RecordingClient;

    for (let cycle = 0; cycle < 30; cycle += 1) {
      await service.runOnce();
    }

    for (const request of recording.seen) {
      const provenance = request.inputDescriptor.provenance as {
        observedRealBytes: boolean;
      };
      expect(provenance.observedRealBytes).toBe(false);
    }
  });

  it('carries the store context onto every job', async () => {
    const { service, client } = build();
    const recording = client as RecordingClient;

    for (let cycle = 0; cycle < 30; cycle += 1) {
      await service.runOnce();
    }

    for (const request of recording.seen) {
      expect(request.locationId).toBe('loc_1');
      expect(request.unitId).toBe('unit_1');
    }
  });
});

describe('PipelineService — degradation', () => {
  it('keeps running and counts frame failures by code', async () => {
    const { service, client } = build({ frameSource: new FailingFrameSource() });

    for (let cycle = 0; cycle < 5; cycle += 1) {
      await service.runOnce();
    }

    const metrics = service.metricsSnapshot();
    expect(metrics.framesFailed).toBe(5);
    expect(metrics.framesSampled).toBe(0);
    expect(metrics.frameErrorsByCode.SOURCE_CONNECT_FAILED).toBe(5);
    expect(metrics.lastFrameErrorCode).toBe('SOURCE_CONNECT_FAILED');
    expect((client as RecordingClient).seen).toHaveLength(0);
  });

  it('survives a throwing frame source without leaking its message', async () => {
    const errors: string[] = [];
    const spy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation((message: unknown) => {
        errors.push(String(message));
      });

    const { service } = build({ frameSource: new ThrowingFrameSource() });
    await expect(service.runOnce()).resolves.toBeUndefined();
    await expect(service.runOnce()).resolves.toBeUndefined();

    expect(errors.length).toBeGreaterThan(0);
    // The thrown message quoted a camera address. Only the error CLASS
    // may reach a log.
    for (const line of errors) {
      expect(line).not.toContain('camera.local');
      expect(line).toContain('Error');
    }
    spy.mockRestore();
  });

  it('holds tracking up when the API rejects everything', async () => {
    const { service } = build({ client: new RecordingClient('REJECTED') });

    for (let cycle = 0; cycle < 30; cycle += 1) {
      await service.runOnce();
    }

    const metrics = service.metricsSnapshot();
    expect(metrics.framesSampled).toBe(30);
    expect(metrics.triggersEmitted).toBeGreaterThan(0);
    expect(metrics.queue.rejected).toBeGreaterThan(0);
    // Nothing accumulates: a rejected descriptor is dropped, not retried.
    expect(metrics.queue.depth).toBe(0);
  });

  it('bounds the queue when the API is unreachable', async () => {
    const pipelineConfig = config({
      queue: {
        capacity: 3,
        maxAttempts: 2,
        backoffBaseMs: 60_000,
        backoffMaxMs: 60_000,
      },
    });
    const { service } = build({
      pipelineConfig,
      client: new RecordingClient('UNAVAILABLE'),
    });

    for (let cycle = 0; cycle < 60; cycle += 1) {
      await service.runOnce();
    }

    const metrics = service.metricsSnapshot();
    expect(metrics.queue.depth).toBeLessThanOrEqual(3);
    expect(metrics.framesSampled).toBe(60);
    // Degradation is visible rather than silent.
    expect(
      metrics.queue.droppedForCapacity + metrics.queue.droppedForAttempts,
    ).toBeGreaterThan(0);
  });
});

describe('PipelineService — metrics honesty', () => {
  it('distinguishes a quiet camera from a suppressed one', async () => {
    // Rate limit of one: the camera is busy, but almost nothing is sent.
    // `triggersEmitted` alone would look like a quiet aisle.
    const pipelineConfig = config({
      trigger: { ...config().trigger, rateLimitPerWindow: 1 },
    });
    const { service } = build({ pipelineConfig });

    for (let cycle = 0; cycle < 40; cycle += 1) {
      await service.runOnce();
    }

    const metrics = service.metricsSnapshot();
    expect(metrics.triggersSuppressed).toBeGreaterThan(0);
    expect(metrics.suppressionsByReason.RATE_LIMITED).toBeGreaterThan(0);
  });

  it('exposes only numbers and closed-vocabulary codes', async () => {
    const { service } = build();
    await service.runOnce();
    const metrics = service.metricsSnapshot();

    // The run id is a UUID and the only free-form string; everything else
    // is a number, a boolean, or a code. Nothing here is an address.
    const serialised = JSON.stringify(metrics);
    expect(serialised).not.toMatch(/https?:\/\//);
    expect(serialised).not.toMatch(/rtsp:/);
    expect(typeof metrics.runId).toBe('string');
    expect(typeof metrics.framesSampled).toBe('number');
  });

  it('stops cleanly and reports that it stopped', () => {
    const { service } = build();
    service.start();
    expect(service.metricsSnapshot().running).toBe(true);
    service.stop();
    expect(service.metricsSnapshot().running).toBe(false);
  });

  it('is idempotent on repeated starts', () => {
    const { service } = build();
    service.start();
    const runId = service.metricsSnapshot().runId;
    service.start();
    expect(service.metricsSnapshot().runId).toBe(runId);
    service.stop();
  });
});
