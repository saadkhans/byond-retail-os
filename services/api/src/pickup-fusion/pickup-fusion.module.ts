import { Body, Controller, Get, Module, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  RequireModule,
  RequirePermissions,
  TenantOnly,
} from '../auth/decorators/access-policy.decorators';
import { CurrentTenantId } from '../auth/decorators/request-context.decorators';
import { PickupDetectionModule } from '../pickup-detection/pickup-detection.module';
import { PlanogramModule } from '../planogram/planogram.module';
import { PlatformModulesModule } from '../platform-modules/platform-modules.module';
import { VideoIngestModule } from '../video-ingest/video-ingest.module';
import {
  ClassicalMotionEventDetector,
  GreedyIouTracker,
  MotionObjectDetector,
  YoloOnnxObjectDetector,
} from './adapters/event-detection';
import {
  PrismaContextSignalProvider,
  PrismaInventoryValidator,
  WeightedCandidateFusion,
} from './adapters/context-fusion-inventory';
import { TesseractOcrReader, ZxingBarcodeReader } from './adapters/text-signals';
import {
  ClassicalHsvNccMatcher,
  HogLabVisualRetriever,
} from './adapters/visual-signals';
import { ClipLocalVisualRetriever } from './adapters/clip-retriever';
import { ConfigService } from '@nestjs/config';
import type {
  LocalEmbeddingRuntimePort,
} from '../local-vision-runtime/local-vision-runtime.port';
import { LOCAL_EMBEDDING_RUNTIME } from '../local-vision-runtime/local-vision-runtime.tokens';
import { LocalVisionRuntimeModule } from '../local-vision-runtime/local-vision-runtime.module';
import { VisualRetriever } from './ports';
import { AnthropicVlmVerifier } from './adapters/vlm-verifier';
import { OllamaVlmVerifier } from './adapters/ollama-vlm';
import { LocalStorageMediaDecoder } from './adapters/storage-media-decoder';
import { ReindexReferenceIndexDto } from './dto/reindex-reference-index.dto';
import { PickupFusionService } from './pickup-fusion.service';
import {
  PICKUP_BARCODE_READER,
  PICKUP_CANDIDATE_FUSION,
  PICKUP_CLASSICAL_MATCHER,
  PICKUP_CONTEXT_PROVIDER,
  PICKUP_EVENT_DETECTOR,
  PICKUP_INVENTORY_VALIDATOR,
  PICKUP_MEDIA_DECODER,
  PICKUP_OBJECT_DETECTOR,
  PICKUP_OCR_READER,
  PICKUP_TX_RETRIEVER_FACTORY,
  PICKUP_VISUAL_RETRIEVER,
  TxScopedRetrieverFactory,
} from './pickup-fusion.tokens';
import { pickupVlmVerifierProvider } from './vlm-provider';
import { PickupAnalysisFrameDecoder } from '../pickup-detection/analysis/analysis-frames';
import { LocalVideoStorageAdapter } from '../video-ingest/storage/local-video-storage.adapter';
import { PrismaService } from '../prisma/prisma.service';

/** Shadow-run trigger + evidence read (both under the video-ingest gate). */
@ApiTags('video-ingest')
@ApiBearerAuth()
@TenantOnly()
@RequireModule('video-ingest')
@Controller('video-assets')
export class PickupFusionController {
  constructor(private readonly fusion: PickupFusionService) {}

  @Post(':id/fusion-run')
  @RequirePermissions('video-asset:process')
  @ApiOperation({
    summary:
      'Run pickup-fusion-v2 in SHADOW mode over this validated test video. ' +
      'Records a PickupFusionRun evidence row only — no vision events, no ' +
      'inventory writes, no billing coupling.',
  })
  run(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
  ): Promise<{ runId: string }> {
    return this.fusion.run(tenantId, id);
  }

  @Get(':id/fusion-evidence')
  @RequirePermissions('video-asset:read')
  @ApiOperation({
    summary:
      'Latest pickup-fusion-v2 evidence for this asset (per-stage results, ' +
      'timings, fused candidates, VLM exchange, policy, shadow comparison).',
  })
  async evidence(@CurrentTenantId() tenantId: string, @Param('id') id: string) {
    // Wrapped so "no run yet" serializes as {"run":null} instead of an
    // empty body the client cannot JSON-parse.
    return { run: await this.fusion.latestEvidence(tenantId, id) };
  }
}

/** Fusion operations: local-VLM readiness + embedding-index maintenance. */
@ApiTags('video-ingest')
@ApiBearerAuth()
@TenantOnly()
@RequireModule('video-ingest')
@Controller('pickup-fusion')
export class FusionOpsController {
  constructor(private readonly fusion: PickupFusionService) {}

  @Get('vlm-readiness')
  @RequirePermissions('video-asset:read')
  @ApiOperation({
    summary:
      'Local VLM readiness: provider/mode/model config, server ' +
      'reachability, and model availability (Ollama /api/tags).',
  })
  vlmReadiness() {
    return this.fusion.vlmReadiness();
  }

  @Post('reference-index/reindex')
  @RequirePermissions('catalog:manage')
  @ApiOperation({
    summary:
      'Ensure (or with {"rebuild":true} atomically rebuild) the visual ' +
      'reference-embedding index for the current embedding model. A ' +
      'rebuild swaps in one transaction — readers keep the old index ' +
      'until commit, and a failure leaves it intact.',
  })
  reindex(
    @CurrentTenantId() tenantId: string,
    @Body() body: ReindexReferenceIndexDto,
  ) {
    return this.fusion.reindexReferenceIndex(tenantId, body?.rebuild === true);
  }
}

/**
 * Phase 24 — keyed retrieval provider selection (PICKUP_RETRIEVAL_PROVIDER):
 * hog_lab (default) keeps the dependency-free index; clip_local binds the
 * local open_clip embedding retriever. The service injects the
 * PICKUP_VISUAL_RETRIEVER token only. An unavailable clip_local runtime is
 * reported honestly (not-ready adapter, empty signal) — never a silent
 * switch back to HOG. Exported for tests.
 */
export function retrievalProviderFrom(config: ConfigService): 'hog_lab' | 'clip_local' {
  const configured = (config.get<string>('PICKUP_RETRIEVAL_PROVIDER') ?? 'hog_lab')
    .trim()
    .toLowerCase();
  return configured === 'clip_local' ? 'clip_local' : 'hog_lab';
}

/** Builds the retriever for one Prisma client (the request-scoped one or a
 *  transaction) according to the configured provider. Exported for tests. */
export function buildVisualRetriever(
  provider: 'hog_lab' | 'clip_local',
  prisma: PrismaService,
  storage: LocalVideoStorageAdapter,
  decoder: PickupAnalysisFrameDecoder,
  embeddingRuntime: LocalEmbeddingRuntimePort | null,
  modelVersion: string,
): VisualRetriever {
  if (provider === 'clip_local' && embeddingRuntime !== null) {
    return new ClipLocalVisualRetriever(prisma, storage, decoder, embeddingRuntime, modelVersion);
  }
  return new HogLabVisualRetriever(prisma, storage, decoder);
}

/**
 * pickup-fusion-v2 — versioned, adapter-based multimodal recognition in
 * SHADOW mode. pickup-classical-v1 (the pickup-detection module) remains
 * untouched as baseline and fallback; this module only ADDS adapters and
 * an evidence trail.
 */
@Module({
  // PlanogramModule: READ-ONLY rack lookup for Phase 22 candidate scoping.
  // LocalVisionRuntimeModule: the LOCAL_EMBEDDING_RUNTIME port for the
  // clip_local retriever (Phase 24).
  imports: [
    VideoIngestModule,
    PickupDetectionModule,
    PlatformModulesModule,
    PlanogramModule,
    LocalVisionRuntimeModule,
  ],
  controllers: [PickupFusionController, FusionOpsController],
  providers: [
    MotionObjectDetector,
    GreedyIouTracker,
    ClassicalMotionEventDetector,
    YoloOnnxObjectDetector,
    ZxingBarcodeReader,
    TesseractOcrReader,
    HogLabVisualRetriever,
    ClassicalHsvNccMatcher,
    PrismaContextSignalProvider,
    WeightedCandidateFusion,
    AnthropicVlmVerifier,
    OllamaVlmVerifier,
    // Keyed port selection (PICKUP_VLM_PROVIDER) — the service injects
    // the PICKUP_VLM_VERIFIER token, never a concrete vendor.
    pickupVlmVerifierProvider,
    PrismaInventoryValidator,
    LocalStorageMediaDecoder,
    // Every fusion stage reaches the service as a PORT bound here — the
    // ONLY place (with vlm-provider) that names concrete adapters. Media
    // decoding included: the storage-key port keeps the local-only
    // internalPathFor confined to its adapter.
    { provide: PICKUP_MEDIA_DECODER, useExisting: LocalStorageMediaDecoder },
    { provide: PICKUP_EVENT_DETECTOR, useExisting: ClassicalMotionEventDetector },
    { provide: PICKUP_OBJECT_DETECTOR, useExisting: YoloOnnxObjectDetector },
    { provide: PICKUP_BARCODE_READER, useExisting: ZxingBarcodeReader },
    { provide: PICKUP_OCR_READER, useExisting: TesseractOcrReader },
    // Keyed retrieval provider (PICKUP_RETRIEVAL_PROVIDER, Phase 24). The
    // clip_local retriever's index generation label is the encoder's
    // manifest version, read once from the runtime status at boot; an
    // unavailable runtime yields 'unknown' and an honest not-ready adapter.
    {
      provide: PICKUP_VISUAL_RETRIEVER,
      inject: [
        ConfigService,
        PrismaService,
        LocalVideoStorageAdapter,
        PickupAnalysisFrameDecoder,
        LOCAL_EMBEDDING_RUNTIME,
      ],
      useFactory: async (
        config: ConfigService,
        prisma: PrismaService,
        storage: LocalVideoStorageAdapter,
        decoder: PickupAnalysisFrameDecoder,
        embeddingRuntime: LocalEmbeddingRuntimePort,
      ): Promise<VisualRetriever> => {
        const provider = retrievalProviderFrom(config);
        const version =
          provider === 'clip_local'
            ? ((await embeddingRuntime.status()).model?.version ?? 'unknown')
            : 'unknown';
        return buildVisualRetriever(provider, prisma, storage, decoder, embeddingRuntime, version);
      },
    },
    { provide: PICKUP_CLASSICAL_MATCHER, useExisting: ClassicalHsvNccMatcher },
    { provide: PICKUP_CONTEXT_PROVIDER, useExisting: PrismaContextSignalProvider },
    { provide: PICKUP_CANDIDATE_FUSION, useExisting: WeightedCandidateFusion },
    { provide: PICKUP_INVENTORY_VALIDATOR, useExisting: PrismaInventoryValidator },
    // The atomic index rebuild reconstructs through the transaction that
    // deleted the old generation; tx clients cannot travel through DI, so
    // the module hands the service a factory instead of a class import.
    // The factory builds the SAME provider kind as the request-scoped
    // retriever so a rebuild never mixes index generations.
    {
      provide: PICKUP_TX_RETRIEVER_FACTORY,
      inject: [
        ConfigService,
        LocalVideoStorageAdapter,
        PickupAnalysisFrameDecoder,
        LOCAL_EMBEDDING_RUNTIME,
        PICKUP_VISUAL_RETRIEVER,
      ],
      useFactory:
        (
          config: ConfigService,
          storage: LocalVideoStorageAdapter,
          decoder: PickupAnalysisFrameDecoder,
          embeddingRuntime: LocalEmbeddingRuntimePort,
          requestScoped: VisualRetriever,
        ): TxScopedRetrieverFactory =>
        (tx: PrismaService) =>
          buildVisualRetriever(
            retrievalProviderFrom(config),
            tx,
            storage,
            decoder,
            embeddingRuntime,
            requestScoped.embeddingModelVersion,
          ),
    },
    PickupFusionService,
  ],
  // Phase 12: the camera replay runtime drives fusion (and reuses the
  // storage-key media decoder) — service and adapter only, never the VLM
  // verifier or its token.
  exports: [PickupFusionService, LocalStorageMediaDecoder],
})
export class PickupFusionModule {}
