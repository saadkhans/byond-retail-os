import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PickupDetectionModule } from '../pickup-detection/pickup-detection.module';
import { VideoIngestModule } from '../video-ingest/video-ingest.module';
import { LocalModelRegistry } from './local-model-registry';
import { LOCAL_DETECTOR_RUNTIME } from './local-vision-runtime.tokens';
import { LocalYoloDetectorRuntime } from './local-yolo-detector.runtime';
import { PythonYoloWorkerRunner } from './python-yolo-worker.runner';

/**
 * LOCAL vision runtime — the ONLY module that names the concrete local
 * detector runtime (safe model registry + confined Python/Ultralytics
 * worker). Consumers (pretrained-vision) inject the
 * LOCAL_DETECTOR_RUNTIME token with the port type alone; swapping the
 * runtime rebinds the token here. Read-only by construction: no table is
 * written (pinned by shadow-mode.spec.ts).
 */
@Module({
  // VideoIngestModule exports the local storage adapter (its path seam
  // stays confined to the detector runtime); PickupDetectionModule
  // exports the confined ffmpeg rawvideo decoder.
  imports: [VideoIngestModule, PickupDetectionModule],
  providers: [
    LocalModelRegistry,
    // Factory-provided like FfmpegVideoFrameExtractor: the runner's
    // second constructor parameter is a test-only command seam (a plain
    // function), not a DI dependency, so Nest must not try to resolve it.
    {
      provide: PythonYoloWorkerRunner,
      useFactory: (config: ConfigService) => new PythonYoloWorkerRunner(config),
      inject: [ConfigService],
    },
    LocalYoloDetectorRuntime,
    { provide: LOCAL_DETECTOR_RUNTIME, useExisting: LocalYoloDetectorRuntime },
  ],
  exports: [LOCAL_DETECTOR_RUNTIME],
})
export class LocalVisionRuntimeModule {}
