import { Module, OnModuleInit } from '@nestjs/common';
import { InferenceAdapterRegistry } from '../inference/adapters/adapter.registry';
import { InferenceModule } from '../inference/inference.module';
import { PlatformModulesModule } from '../platform-modules/platform-modules.module';
import { VideoIngestModule } from '../video-ingest/video-ingest.module';
import { PickupAnalysisFrameDecoder } from './analysis/analysis-frames';
import { LocalPickupMediaAdapter } from './local-pickup-media.adapter';
import { PickupClassicalAdapter } from './pickup.adapter';
import { PickupDetectionConfig } from './pickup-detection.config';
import { PickupMediaPort } from './pickup-media.port';
import {
  PickupDetectionController,
  PickupValidationController,
} from './pickup-detection.controller';
import { PickupDetectionService } from './pickup-detection.service';
import { PickupDetectionWorker } from './pickup-detection.worker';
import { PickupValidationService } from './pickup-validation.service';
import { ReferenceImagesController } from './reference-images.controller';
import { ReferenceImagesService } from './reference-images.service';
import { ReferenceImportService } from './reference-import.service';
import { PickupReferenceLibrary } from './reference-library';

/**
 * Phase 10 MVP — controlled automatic product-pickup detection. The module
 * composes the EXISTING seams rather than growing new ones: analysis
 * frames come from the stored (screened, validated) media via ffmpeg;
 * artifacts persist through VideoAssetsService's idempotent extract/crop
 * contracts; the job lifecycle and vision-event conversion are Phase 9's
 * InferenceJobsService with a new registered adapter key. Detection is
 * classical CV (`classical-hsv-histogram+ncc`) — no filename or metadata
 * signal ever participates in identification.
 */
@Module({
  imports: [VideoIngestModule, InferenceModule, PlatformModulesModule],
  controllers: [
    PickupDetectionController,
    PickupValidationController,
    ReferenceImagesController,
  ],
  providers: [
    ReferenceImagesService,
    ReferenceImportService,
    PickupValidationService,
    PickupDetectionConfig,
    // Factory-constructed: the constructor's injectable command runner is a
    // TEST seam (default execFile), not a DI dependency — same idiom as the
    // ffmpeg extractor's factory in VideoIngestModule.
    {
      provide: PickupAnalysisFrameDecoder,
      useFactory: () => new PickupAnalysisFrameDecoder(),
    },
    // The ONLY place classical-v1 names the concrete local storage adapter
    // and decoder together: core services (detection, reference library,
    // reference images) consume the storage-key PORT alone, so an
    // object-store deployment or replacement decoder swaps this binding —
    // never a core edit. Mirrors the fusion module's PICKUP_MEDIA_DECODER.
    LocalPickupMediaAdapter,
    { provide: PickupMediaPort, useExisting: LocalPickupMediaAdapter },
    PickupReferenceLibrary,
    PickupClassicalAdapter,
    PickupDetectionService,
    PickupDetectionWorker,
  ],
  // Exported for pickup-fusion-v2 (shadow pipeline): the decoder, the v1
  // reference library (HSV+NCC stays one fusion signal), and the shared
  // analysis config. v1 itself is UNCHANGED — fusion only composes it.
  exports: [
    PickupAnalysisFrameDecoder,
    PickupReferenceLibrary,
    PickupDetectionConfig,
  ],
})
export class PickupDetectionModule implements OnModuleInit {
  constructor(
    private readonly registry: InferenceAdapterRegistry,
    private readonly adapter: PickupClassicalAdapter,
  ) {}

  onModuleInit(): void {
    // Makes `start(adapterKey: 'pickup-classical-v1')` resolvable — and the
    // recorded adapterKey on every pickup job honest about the method used.
    this.registry.register(this.adapter);
  }
}
