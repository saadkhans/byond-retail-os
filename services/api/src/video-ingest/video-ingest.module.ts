import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MulterModule } from '@nestjs/platform-express';
import { isEnvFlagEnabled } from '../config/env.validation';
import { InferenceModule } from '../inference/inference.module';
import { PlatformModulesModule } from '../platform-modules/platform-modules.module';
import { FfmpegVideoFrameExtractor } from './extraction/ffmpeg-extractor.adapter';
import { SimulatedVideoFrameExtractor } from './extraction/simulated-extractor.adapter';
import { VideoFrameExtractorPort } from './extraction/video-frame-extractor.port';
import { FrameTextRecognizerPort } from './recognition/frame-text-recognizer.port';
import { SimulatedFrameTextRecognizer } from './recognition/simulated-recognizer.adapter';
import { TesseractFrameTextRecognizer } from './recognition/tesseract-recognizer.adapter';
import { LocalVideoStorageAdapter } from './storage/local-video-storage.adapter';
import { VideoStoragePort } from './storage/video-storage.port';
import { TestMediaGateGuard } from './test-media-gate.guard';
import { DEFAULT_MAX_UPLOAD_BYTES } from './video-assets.service';
import { VideoAssetsController } from './video-assets.controller';
import { VideoAssetsRepository } from './video-assets.repository';
import { VideoAssetsService } from './video-assets.service';
import { VideoCropsController } from './video-crops.controller';

/**
 * Phase 10 — video ingestion & crop extraction MVP. Controlled TEST videos
 * only: local/dev storage behind a port, extraction behind a port (the
 * deterministic simulated extractor by default; the local system-binary
 * adapter only when the operator opted in via VIDEO_FFMPEG_ENABLED=true),
 * and crop artifacts feeding Phase 9 inference jobs by OPAQUE ID. No
 * production camera runtime, no streaming stack, no real model execution,
 * and no runtime media npm dependency.
 */
@Module({
  imports: [
    // Multipart uploads buffer in memory (no multer disk temp files with
    // uncontrolled names) and are size-capped at the transport layer; the
    // service re-checks the same limit and all content rules. EVERY parser
    // dimension is bounded — not just the file: unbounded non-file fields
    // or parts would otherwise exhaust the heap before DTO whitelisting
    // runs. The upload carries one file plus four optional short id fields,
    // so these caps are generous for the contract while denying abuse.
    MulterModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const configured = Number(config.get<string>('VIDEO_MAX_UPLOAD_BYTES'));
        const fileSize =
          Number.isInteger(configured) && configured > 0
            ? configured
            : DEFAULT_MAX_UPLOAD_BYTES;
        return {
          limits: {
            fileSize,
            files: 1,
            fields: 8,
            parts: 10,
            fieldSize: 2048,
            fieldNameSize: 128,
            headerPairs: 100,
          },
        };
      },
    }),
    InferenceModule,
    PlatformModulesModule,
  ],
  controllers: [VideoAssetsController, VideoCropsController],
  providers: [
    VideoAssetsService,
    VideoAssetsRepository,
    // The PRE-BUFFER upload gate. Nest instantiates route-level guards
    // through the declaring module's injector, so it must be a provider
    // here to receive ConfigService + the extractor/recognizer ports it
    // shares with the service. Registered on the upload route only.
    TestMediaGateGuard,
    SimulatedVideoFrameExtractor,
    LocalVideoStorageAdapter,
    // The port stays provider-neutral (bytes + keys only); the optional
    // system-binary extractor needs the CONCRETE local adapter for its
    // path capability, so both tokens resolve to one instance.
    { provide: VideoStoragePort, useExisting: LocalVideoStorageAdapter },
    // Extractor selection: the simulated adapter (default) declares
    // readsRealBytes=false, so the quarantine screening preview refuses to
    // serve from it (controlled 503) — placeholder frames must never stand
    // in for the real footage a screener is approving. Production (and any
    // deployment where uploads are actually screened) must therefore run
    // with VIDEO_FFMPEG_ENABLED=true.
    {
      provide: VideoFrameExtractorPort,
      inject: [
        ConfigService,
        SimulatedVideoFrameExtractor,
        LocalVideoStorageAdapter,
      ],
      useFactory: (
        config: ConfigService,
        simulated: SimulatedVideoFrameExtractor,
        localStorage: LocalVideoStorageAdapter,
      ) =>
        // ONE definition of "is this env flag on" for the whole codebase
        // (trimmed + case-folded, fail-closed on anything else) — the same
        // helper the service's policy gate reads its flag through, so no
        // two flags in this module can drift apart on spelling.
        isEnvFlagEnabled(config.get<string>('VIDEO_FFMPEG_ENABLED'))
          ? new FfmpegVideoFrameExtractor(localStorage)
          : simulated,
    },
    SimulatedFrameTextRecognizer,
    // Frame-text recognizer selection, mirroring the extractor factory:
    // the simulated adapter (default) declares readsRealPixels=false, so
    // the PRE-STORAGE frame screen refuses to treat its empty result as a
    // pass — uploads then fail closed (controlled 503) in EVERY environment;
    // there is no bypass. Uploads require VIDEO_OCR_ENABLED=true (and
    // VIDEO_FFMPEG_ENABLED=true).
    {
      provide: FrameTextRecognizerPort,
      inject: [ConfigService, SimulatedFrameTextRecognizer],
      useFactory: (
        config: ConfigService,
        simulated: SimulatedFrameTextRecognizer,
      ) =>
        // Same shared flag helper as the extractor factory above.
        isEnvFlagEnabled(config.get<string>('VIDEO_OCR_ENABLED'))
          ? new TesseractFrameTextRecognizer()
          : simulated,
    },
  ],
  // Exported for the Phase 10 pickup-detection module: artifact
  // persistence goes through VideoAssetsService's idempotent contracts
  // (never direct rows), asset reads through the repository, byte access
  // through the provider-neutral storage PORT, and the CONCRETE local
  // adapter only for the composition-layer media adapters that need its
  // path capability — the same capability the ffmpeg extractor uses. The
  // recognizer port is exported so REFERENCE-IMAGE uploads run the SAME
  // payment-data pixel screen as video frames before any byte becomes
  // durable.
  exports: [
    VideoAssetsService,
    VideoAssetsRepository,
    VideoStoragePort,
    LocalVideoStorageAdapter,
    FrameTextRecognizerPort,
  ],
})
export class VideoIngestModule {}
