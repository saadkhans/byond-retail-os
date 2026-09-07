import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PickupDetectionModule } from '../pickup-detection/pickup-detection.module';
import { VideoIngestModule } from '../video-ingest/video-ingest.module';
import { LocalEmbeddingRuntime } from './local-embedding.runtime';
import { LocalModelRegistry } from './local-model-registry';
import {
  LOCAL_DETECTOR_RUNTIME,
  LOCAL_EMBEDDING_RUNTIME,
} from './local-vision-runtime.tokens';
import { LocalYoloDetectorRuntime } from './local-yolo-detector.runtime';
import { PythonEmbedWorkerRunner } from './python-embed-worker.runner';
import { PythonYoloWorkerRunner } from './python-yolo-worker.runner';

/**
 * LOCAL vision runtime — the ONLY module that names the concrete local
 * runtimes (safe model registry + confined Python workers: the
 * Ultralytics detector and, since Phase 24, the open_clip embedding
 * encoder). Consumers (pretrained-vision, pickup-fusion) inject the
 * LOCAL_DETECTOR_RUNTIME / LOCAL_EMBEDDING_RUNTIME tokens with the port
 * types alone; swapping a runtime rebinds a token here. Read-only by
 * construction: no table is written (pinned by shadow-mode.spec.ts).
 */
@Module({
  // VideoIngestModule exports the local storage adapter (its path seam
  // stays confined to the detector runtime); PickupDetectionModule
  // exports the confined ffmpeg rawvideo decoder.
  imports: [VideoIngestModule, PickupDetectionModule],
  providers: [
    LocalModelRegistry,
    // Factory-provided like FfmpegVideoFrameExtractor: the runners'
    // second constructor parameter is a test-only command seam (a plain
    // function), not a DI dependency, so Nest must not try to resolve it.
    {
      provide: PythonYoloWorkerRunner,
      useFactory: (config: ConfigService) => new PythonYoloWorkerRunner(config),
      inject: [ConfigService],
    },
    {
      provide: PythonEmbedWorkerRunner,
      useFactory: (config: ConfigService) => new PythonEmbedWorkerRunner(config),
      inject: [ConfigService],
    },
    LocalYoloDetectorRuntime,
    LocalEmbeddingRuntime,
    { provide: LOCAL_DETECTOR_RUNTIME, useExisting: LocalYoloDetectorRuntime },
    { provide: LOCAL_EMBEDDING_RUNTIME, useExisting: LocalEmbeddingRuntime },
  ],
  exports: [LOCAL_DETECTOR_RUNTIME, LOCAL_EMBEDDING_RUNTIME],
})
export class LocalVisionRuntimeModule {}
