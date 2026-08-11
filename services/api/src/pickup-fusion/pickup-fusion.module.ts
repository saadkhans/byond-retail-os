import { Body, Controller, Get, Module, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  RequireModule,
  RequirePermissions,
  TenantOnly,
} from '../auth/decorators/access-policy.decorators';
import { CurrentTenantId } from '../auth/decorators/request-context.decorators';
import { PickupDetectionModule } from '../pickup-detection/pickup-detection.module';
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
import { AnthropicVlmVerifier } from './adapters/vlm-verifier';
import { OllamaVlmVerifier } from './adapters/ollama-vlm';
import { PrismaService } from '../prisma/prisma.service';
import { PickupFusionService } from './pickup-fusion.service';

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
  constructor(
    private readonly fusion: PickupFusionService,
    private readonly retriever: HogLabVisualRetriever,
    private readonly prisma: PrismaService,
  ) {}

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
      'Ensure (or with {"rebuild":true} fully rebuild) the visual ' +
      'reference-embedding index for the current embedding model.',
  })
  async reindex(
    @CurrentTenantId() tenantId: string,
    @Body() body: { rebuild?: boolean },
  ) {
    if (body?.rebuild === true) {
      await this.prisma.productReferenceEmbedding.deleteMany({
        where: { tenantId, modelKey: this.retriever.embeddingModelKey },
      });
    }
    const result = await this.retriever.ensureIndex(tenantId);
    return {
      modelKey: this.retriever.embeddingModelKey,
      modelVersion: this.retriever.embeddingModelVersion,
      rebuilt: body?.rebuild === true,
      ...result,
    };
  }
}

/**
 * pickup-fusion-v2 — versioned, adapter-based multimodal recognition in
 * SHADOW mode. pickup-classical-v1 (the pickup-detection module) remains
 * untouched as baseline and fallback; this module only ADDS adapters and
 * an evidence trail.
 */
@Module({
  imports: [VideoIngestModule, PickupDetectionModule, PlatformModulesModule],
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
    PrismaInventoryValidator,
    PickupFusionService,
  ],
})
export class PickupFusionModule {}
