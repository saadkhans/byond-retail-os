import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MulterModule } from '@nestjs/platform-express';
import { InferenceModule } from '../inference/inference.module';
import { PlatformModulesModule } from '../platform-modules/platform-modules.module';
import { FfmpegVideoFrameExtractor } from './extraction/ffmpeg-extractor.adapter';
import { SimulatedVideoFrameExtractor } from './extraction/simulated-extractor.adapter';
import { VideoFrameExtractorPort } from './extraction/video-frame-extractor.port';
import { LocalVideoStorageAdapter } from './storage/local-video-storage.adapter';
import { VideoStoragePort } from './storage/video-storage.port';
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
    SimulatedVideoFrameExtractor,
    LocalVideoStorageAdapter,
    // The port stays provider-neutral (bytes + keys only); the optional
    // system-binary extractor needs the CONCRETE local adapter for its
    // path capability, so both tokens resolve to one instance.
    { provide: VideoStoragePort, useExisting: LocalVideoStorageAdapter },
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
        config.get<string>('VIDEO_FFMPEG_ENABLED')?.toLowerCase() === 'true'
          ? new FfmpegVideoFrameExtractor(localStorage)
          : simulated,
    },
  ],
})
export class VideoIngestModule {}
