import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import {
  PipelineConfig,
  buildPipelineConfig,
  resolveCameraSource,
} from './config/pipeline.config';
import { FrameSourceKind, TrackerKind, validateEnv } from './config/env.validation';
import { FrameSourcePort } from './tracking/frame-source.port';
import { TrackerPort } from './tracking/tracker.port';
import { SimulatedFrameSource } from './tracking/simulated-frame-source.adapter';
import { FfmpegFrameSource } from './tracking/ffmpeg-frame-source.adapter';
import { SimulatedTracker } from './tracking/simulated-tracker.adapter';
import { MotionTracker } from './tracking/motion-tracker.adapter';
import { TriggerPolicy } from './trigger/trigger.policy';
import { InferenceClientPort } from './jobs/inference-client.port';
import { HttpInferenceClient } from './jobs/http-inference-client';
import { TriggerQueue } from './jobs/trigger-queue';
import { PipelineService } from './pipeline/pipeline.service';
import { HealthController } from './health/health.controller';

export const PIPELINE_CONFIG = Symbol('PIPELINE_CONFIG');

/**
 * Composition root. Every adapter is selected here, from validated
 * configuration, and nothing downstream knows which one it got — the
 * pipeline service holds ports.
 *
 * Factories rather than class providers because each adapter needs
 * configuration at construction time, and because the API learned the
 * hard way that a provider which probes a runtime at module-construction
 * time turns a missing model into a service that will not boot. Nothing
 * here touches a camera, a binary, or the network.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
    }),
  ],
  controllers: [HealthController],
  providers: [
    {
      provide: PIPELINE_CONFIG,
      useFactory: (config: ConfigService): PipelineConfig =>
        buildPipelineConfig(config),
      inject: [ConfigService],
    },
    {
      provide: FrameSourcePort,
      useFactory: (config: PipelineConfig): FrameSourcePort =>
        config.frameSource === FrameSourceKind.Ffmpeg
          ? new FfmpegFrameSource(
              // Resolved here and handed straight in: the address lives in
              // the adapter's private field and nowhere else.
              resolveCameraSource(config.sourceEnvKey),
            )
          : new SimulatedFrameSource(),
      inject: [PIPELINE_CONFIG],
    },
    {
      provide: TrackerPort,
      useFactory: (config: PipelineConfig): TrackerPort =>
        config.tracker === TrackerKind.Simulated
          ? new SimulatedTracker(config.zones)
          : new MotionTracker(
              config.zones,
              config.motion.pixelDeltaThreshold,
              config.motion.cellActivationRatio,
            ),
      inject: [PIPELINE_CONFIG],
    },
    {
      provide: TriggerPolicy,
      useFactory: (config: PipelineConfig): TriggerPolicy =>
        new TriggerPolicy(config.trigger),
      inject: [PIPELINE_CONFIG],
    },
    {
      provide: InferenceClientPort,
      useFactory: (config: PipelineConfig): InferenceClientPort =>
        new HttpInferenceClient(
          config.api.baseUrl,
          config.api.token,
          config.api.timeoutMs,
        ),
      inject: [PIPELINE_CONFIG],
    },
    {
      provide: TriggerQueue,
      useFactory: (
        client: InferenceClientPort,
        config: PipelineConfig,
      ): TriggerQueue => new TriggerQueue(client, config.queue),
      inject: [InferenceClientPort, PIPELINE_CONFIG],
    },
    {
      provide: PipelineService,
      useFactory: (
        config: PipelineConfig,
        frameSource: FrameSourcePort,
        tracker: TrackerPort,
        policy: TriggerPolicy,
        queue: TriggerQueue,
      ): PipelineService =>
        new PipelineService(config, frameSource, tracker, policy, queue),
      inject: [
        PIPELINE_CONFIG,
        FrameSourcePort,
        TrackerPort,
        TriggerPolicy,
        TriggerQueue,
      ],
    },
  ],
})
export class AppModule {}
