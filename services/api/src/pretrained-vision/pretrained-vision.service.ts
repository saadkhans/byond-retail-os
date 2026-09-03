import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FusionRunScope, PretrainedVisionRunStatus } from '@prisma/client';
import {
  SafeFusionSummary,
  fusionFrameDimsFor,
  safeFusionSummary,
} from '../one-sku-bootstrap/one-sku-bootstrap.report';
import {
  NarrowedCandidates,
  PlanogramPriorResult,
  applyPlanogramPrior,
} from '../planogram/planogram.logic';
import { PlanogramService } from '../planogram/planogram.service';
import { PlatformModulesService } from '../platform-modules/platform-modules.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  AdapterAnalysisContext,
  ClassicalVisionAdapter,
  EmbeddingRetrievalAdapter,
  HandSignalAdapter,
  VisionProviderAdapter,
  YoloVisionAdapter,
} from './pretrained-vision.adapters';
import {
  ActionCandidate,
  EmbeddingCandidate,
  HandSignalSummary,
  ProviderEvidence,
  ProviderStatus,
  sanitizeProviderEvidence,
} from './pretrained-vision.types';

/**
 * Phase 19 — pretrained retail vision evaluation service.
 *
 * SHADOW-ONLY / LOCAL-ONLY: adapters never open a network connection,
 * every output is allowlist-sanitized before persistence or response,
 * and the only table this module writes is PretrainedVisionRun (pinned
 * by shadow-mode.spec.ts). The CLASSICAL fallback is always in the
 * registry and always READY — an enabled-but-unavailable pretrained
 * provider degrades to an UNAVAILABLE evidence envelope, never to a
 * pipeline failure. The planogram is applied as a SOFT prior over SKU
 * candidates; visual/planogram disagreement flags human review, never
 * automatic rejection. Nothing here mutates checkout, order, payment,
 * settlement, or inventory state.
 */

export interface PlanogramSection {
  configured: boolean;
  rackId: string | null;
  rackCode: string | null;
  version: number | null;
  cell: {
    cellCode: string;
    rowIndex: number;
    columnIndex: number;
    confidence: number;
  } | null;
  normalizedRackX: number | null;
  normalizedRackY: number | null;
  cellAssignmentConfidence: number | null;
  planogramCandidateSkus: string[];
  adjacentCellCandidateSkus: string[];
  rackCandidateSkus: string[];
  planogramMatchStatus: string;
  flags: string[];
  reviewRequired: boolean;
  candidates: { sku: string; score: number; planogramBoost: number }[];
}

export interface PretrainedComparisonReport {
  videoAssetId: string;
  providers: ProviderStatus[];
  classical: {
    topSku: string | null;
    topScore: number | null;
    policy: string;
    action: ActionCandidate;
  } | null;
  runs: {
    provider: string;
    status: string;
    synthetic: boolean;
    createdAt: Date;
    evidence: ProviderEvidence;
  }[];
  embeddingCandidates: EmbeddingCandidate[];
  handSignal: HandSignalSummary | null;
  planogram: PlanogramSection;
  fusionSuggestion: {
    sku: string | null;
    action: ActionCandidate;
    reviewRequired: boolean;
    notes: string[];
  };
  groundTruth: { eventKind: string; sku: string | null } | null;
  operatorCorrection: {
    verdict: string;
    expectedAction: string;
    expectedSku: string | null;
  } | null;
  improvementNotes: string[];
}

export interface PlanogramContextInput {
  locationId?: string | null;
  rackCode?: string | null;
  normalizedRackX?: number | null;
  normalizedRackY?: number | null;
}

@Injectable()
export class PretrainedVisionService {
  private readonly adapters: VisionProviderAdapter[];

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly platformModules: PlatformModulesService,
    private readonly planograms: PlanogramService,
  ) {
    const providerConfig = (
      this.config.get<string>('CV_PRETRAINED_PROVIDER') ?? 'classical'
    ).toLowerCase();
    const stubMode = this.config.get<string>('CV_PRETRAINED_STUB_MODE') === 'true';
    const yoloEnabled =
      providerConfig === 'yolo_local' || providerConfig === 'hybrid';
    const embeddingEnabled =
      providerConfig === 'embeddings_local' || providerConfig === 'hybrid';
    const handEnabled = providerConfig === 'hybrid';
    // CLASSICAL is ALWAYS registered first — the fallback can never be
    // configured away.
    this.adapters = [
      new ClassicalVisionAdapter(),
      new YoloVisionAdapter(yoloEnabled, stubMode),
      new HandSignalAdapter(handEnabled, stubMode),
      new EmbeddingRetrievalAdapter(embeddingEnabled, stubMode),
    ];
  }

  providerStatuses(): ProviderStatus[] {
    return this.adapters.map((adapter) => adapter.status());
  }

  /** Same boundary as the video-asset read routes (Codex precedent from
   *  the one-SKU bootstrap report): everything this module serves is
   *  video-derived evidence. */
  private async requireVideoBoundary(
    tenantId: string,
    viewer: { hasVideoAssetReadPermission?: boolean },
  ): Promise<void> {
    const allowed =
      viewer.hasVideoAssetReadPermission === true &&
      (await this.platformModules.isEnabledForTenant(tenantId, 'video-ingest'));
    if (!allowed) {
      throw new ForbiddenException(
        'pretrained vision evaluation requires the video-ingest module ' +
          'and video-asset:read — its evidence is video-derived',
      );
    }
  }

  private async loadClipContext(tenantId: string, videoAssetId: string) {
    const asset = await this.prisma.videoAsset.findFirst({
      where: { tenantId, id: videoAssetId, deletedAt: null },
      select: { id: true, width: true, height: true, locationId: true },
    });
    if (!asset) {
      throw new NotFoundException('video asset not found');
    }
    const run = await this.prisma.pickupFusionRun.findFirst({
      where: { tenantId, videoAssetId, runScope: FusionRunScope.WHOLE_CLIP },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, createdAt: true, policy: true, evidence: true },
    });
    const truth = await this.prisma.videoGroundTruth.findFirst({
      where: { tenantId, videoAssetId },
      select: { eventKind: true, product: { select: { sku: true } } },
    });
    const correction = await this.prisma.pilotObservationReview.findFirst({
      where: { tenantId, journeyEvent: { videoAssetId } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { verdict: true, expectedAction: true, expectedSku: true },
    });
    const referenceSkus = await this.prisma.product.findMany({
      where: { tenantId, referenceImages: { some: {} } },
      select: { id: true, sku: true },
      orderBy: [{ sku: 'asc' }],
      take: 50,
    });
    const native =
      asset.width && asset.height
        ? { width: asset.width, height: asset.height }
        : null;
    const classical = run
      ? safeFusionSummary(run, truth?.product?.sku ?? null, fusionFrameDimsFor(native))
      : null;
    return {
      asset,
      run,
      truth,
      correction,
      classical,
      analysisDims: fusionFrameDimsFor(native),
      referenceSkus: referenceSkus.map((row) => ({
        productId: row.id,
        sku: row.sku,
      })),
    };
  }

  private async planogramSection(
    tenantId: string,
    assetLocationId: string | null,
    input: PlanogramContextInput,
    visualCandidates: { sku: string; score: number }[],
  ): Promise<{ section: PlanogramSection; prior: PlanogramPriorResult }> {
    const locationId = input.locationId ?? assetLocationId;
    let narrowed:
      | (NarrowedCandidates & {
          rackId: string;
          rackCode: string;
          version: number;
        })
      | null = null;
    if (locationId && input.rackCode) {
      narrowed = await this.planograms.narrowCandidates(tenantId, {
        locationId,
        rackCode: input.rackCode,
        normalizedRackX: input.normalizedRackX ?? null,
        normalizedRackY: input.normalizedRackY ?? null,
      });
    }
    const prior = applyPlanogramPrior(visualCandidates, narrowed);
    return {
      prior,
      section: {
        configured: narrowed !== null,
        rackId: narrowed?.rackId ?? null,
        rackCode: narrowed?.rackCode ?? null,
        version: narrowed?.version ?? null,
        cell: narrowed?.cell
          ? {
              cellCode: narrowed.cell.cellCode,
              rowIndex: narrowed.cell.rowIndex,
              columnIndex: narrowed.cell.columnIndex,
              confidence: narrowed.cell.confidence,
            }
          : null,
        normalizedRackX: input.normalizedRackX ?? null,
        normalizedRackY: input.normalizedRackY ?? null,
        cellAssignmentConfidence: narrowed?.cell?.confidence ?? null,
        planogramCandidateSkus: narrowed?.cellSkus ?? [],
        adjacentCellCandidateSkus: narrowed?.adjacentSkus ?? [],
        rackCandidateSkus: narrowed?.rackSkus ?? [],
        planogramMatchStatus: prior.matchStatus,
        flags: prior.flags,
        reviewRequired: prior.reviewRequired,
        candidates: prior.candidates.slice(0, 10),
      },
    };
  }

  private assembleReport(input: {
    videoAssetId: string;
    classical: SafeFusionSummary | null;
    runs: {
      provider: string;
      status: string;
      createdAt: Date;
      evidence: ProviderEvidence;
    }[];
    planogram: PlanogramSection;
    prior: PlanogramPriorResult;
    truth: { eventKind: string; product: { sku: string } | null } | null;
    correction: {
      verdict: string;
      expectedAction: string;
      expectedSku: string | null;
    } | null;
  }): PretrainedComparisonReport {
    const classicalAction: ActionCandidate =
      input.classical?.detectedKind === 'PICKUP'
        ? 'PICKUP'
        : input.classical?.detectedKind === 'RETURN'
          ? 'RETURN'
          : 'UNKNOWN';
    const byProvider = new Map(
      input.runs.map((run) => [run.provider, run]),
    );
    const detectorRun = byProvider.get('YOLO_LOCAL');
    const handRun = byProvider.get('HAND_SIGNAL_LOCAL');
    const embeddingRun = byProvider.get('EMBEDDING_LOCAL');
    const embeddingCandidates =
      embeddingRun?.evidence.embeddingCandidates ?? [];
    const handSignal = handRun?.evidence.handSignal ?? null;

    // Final fusion SUGGESTION (advisory only — never applied anywhere):
    // planogram-boosted top candidate + the strongest available action
    // signal. UNKNOWN or any disagreement stays review-required.
    const suggestedSku = input.prior.candidates.length
      ? input.prior.candidates[0].sku
      : null;
    const detectorAction =
      detectorRun?.evidence.features?.actionCandidate ?? null;
    const suggestedAction: ActionCandidate =
      detectorAction && detectorAction !== 'UNKNOWN'
        ? detectorAction
        : classicalAction;
    const suggestionNotes: string[] = [];
    let reviewRequired = input.prior.reviewRequired;
    if (suggestedAction === 'UNKNOWN') {
      reviewRequired = true;
      suggestionNotes.push('ACTION_UNRESOLVED');
    }
    if (
      detectorAction &&
      detectorAction !== 'UNKNOWN' &&
      classicalAction !== 'UNKNOWN' &&
      detectorAction !== classicalAction
    ) {
      reviewRequired = true;
      suggestionNotes.push('DETECTOR_CLASSICAL_ACTION_DISAGREEMENT');
    }
    if (reviewRequired) {
      suggestionNotes.push('STILL_NEEDS_REVIEW');
    }

    // Operator-facing improvement rollup — classified codes only.
    const improvementNotes: string[] = [];
    const pretrainedReady = [detectorRun, handRun, embeddingRun].some(
      (run) => run && run.evidence.availability === 'READY',
    );
    if (detectorRun?.evidence.detections.length) {
      improvementNotes.push('PRODUCT_DETECTED');
    }
    if (
      handSignal?.handPresent &&
      (detectorRun?.evidence.features?.occlusionScore ?? 0) > 0.3
    ) {
      improvementNotes.push('HAND_COVERED_PRODUCT');
    }
    const classicalSharpness = input.classical?.selectedCrop?.sharpness ?? null;
    const detectorSharpness =
      detectorRun?.evidence.features?.sharpnessScore ?? null;
    if (
      classicalSharpness !== null &&
      detectorSharpness !== null &&
      detectorSharpness > classicalSharpness
    ) {
      improvementNotes.push('CROP_IMPROVED');
    }
    if (
      embeddingCandidates.length &&
      input.classical?.topSku &&
      embeddingCandidates[0].sku !== input.classical.topSku
    ) {
      improvementNotes.push('SKU_CANDIDATE_CHANGED');
    }
    if (!pretrainedReady || improvementNotes.length === 0) {
      improvementNotes.push('NO_IMPROVEMENT_OVER_CLASSICAL');
    }
    if (reviewRequired) {
      improvementNotes.push('STILL_NEEDS_REVIEW');
    }

    return {
      videoAssetId: input.videoAssetId,
      providers: this.providerStatuses(),
      classical: input.classical
        ? {
            topSku: input.classical.topSku,
            topScore: input.classical.topScore,
            policy: input.classical.policy,
            action: classicalAction,
          }
        : null,
      runs: input.runs.map((run) => ({
        provider: run.provider,
        status: run.status,
        synthetic: run.evidence.synthetic,
        createdAt: run.createdAt,
        evidence: run.evidence,
      })),
      embeddingCandidates,
      handSignal,
      planogram: input.planogram,
      fusionSuggestion: {
        sku: suggestedSku,
        action: suggestedAction,
        reviewRequired,
        notes: [...new Set(suggestionNotes)],
      },
      groundTruth: input.truth
        ? {
            eventKind: input.truth.eventKind,
            sku: input.truth.product?.sku ?? null,
          }
        : null,
      operatorCorrection: input.correction
        ? {
            verdict: input.correction.verdict,
            expectedAction: input.correction.expectedAction,
            expectedSku: input.correction.expectedSku,
          }
        : null,
      improvementNotes: [...new Set(improvementNotes)],
    };
  }

  /** Visual SKU candidates for the planogram prior: embedding retrieval
   *  first (richest), classical top as the floor. */
  private visualCandidates(
    classical: SafeFusionSummary | null,
    runs: { provider: string; evidence: ProviderEvidence }[],
  ): { sku: string; score: number }[] {
    const embedding = runs.find((run) => run.provider === 'EMBEDDING_LOCAL');
    const fromEmbedding = (
      embedding?.evidence.embeddingCandidates ?? []
    ).map((row) => ({ sku: row.sku, score: row.similarity }));
    if (fromEmbedding.length) {
      return fromEmbedding;
    }
    return classical?.topSku
      ? [{ sku: classical.topSku, score: classical.topScore ?? 0 }]
      : [];
  }

  /**
   * Run every registered adapter over the clip's persisted classical
   * context, persist one tenant-scoped PretrainedVisionRun per adapter,
   * and return the side-by-side comparison report. An unavailable or
   * throwing adapter records its envelope and the evaluation CONTINUES —
   * the classical fallback is never blocked by a pretrained failure.
   */
  async evaluate(
    tenantId: string,
    videoAssetId: string,
    input: PlanogramContextInput,
    actorId: string | undefined,
    viewer: { hasVideoAssetReadPermission?: boolean },
  ): Promise<PretrainedComparisonReport> {
    await this.requireVideoBoundary(tenantId, viewer);
    const ctx = await this.loadClipContext(tenantId, videoAssetId);
    if (!ctx.run) {
      throw new ConflictException(
        'run fusion on this clip first — pretrained evaluation compares ' +
          'against the classical baseline',
      );
    }
    const adapterContext: AdapterAnalysisContext = {
      videoAssetId,
      classical: ctx.classical,
      analysisDims: ctx.analysisDims,
      referenceSkus: ctx.referenceSkus,
    };
    const evidences: ProviderEvidence[] = this.adapters.map((adapter) => {
      try {
        return adapter.analyze(adapterContext);
      } catch {
        // Never a raw error message — a classified envelope only.
        return sanitizeProviderEvidence({
          provider: adapter.provider,
          availability: 'UNAVAILABLE',
          reasonCode: 'ADAPTER_ERROR',
          synthetic: false,
          notes: ['ADAPTER_ERROR'],
        });
      }
    });

    const visual = this.visualCandidates(
      ctx.classical,
      evidences.map((evidence) => ({
        provider: evidence.provider,
        evidence,
      })),
    );
    const { section, prior } = await this.planogramSection(
      tenantId,
      ctx.asset.locationId,
      input,
      visual,
    );

    const persisted: {
      provider: string;
      status: string;
      createdAt: Date;
      evidence: ProviderEvidence;
    }[] = [];
    for (const evidence of evidences) {
      if (evidence.availability === 'DISABLED') {
        continue; // nothing ran — nothing to record
      }
      const row = await this.prisma.pretrainedVisionRun.create({
        data: {
          tenantId,
          videoAssetId,
          provider: evidence.provider,
          status:
            evidence.availability === 'READY'
              ? evidence.reasonCode === 'ADAPTER_ERROR'
                ? PretrainedVisionRunStatus.FAILED
                : PretrainedVisionRunStatus.COMPLETED
              : evidence.reasonCode === 'ADAPTER_ERROR'
                ? PretrainedVisionRunStatus.FAILED
                : PretrainedVisionRunStatus.PROVIDER_UNAVAILABLE,
          planogramRackId: section.rackId,
          planogramVersion: section.version,
          evidence: evidence as object,
          createdById: actorId ?? null,
        },
      });
      persisted.push({
        provider: evidence.provider,
        status: row.status,
        createdAt: row.createdAt,
        evidence,
      });
    }

    return this.assembleReport({
      videoAssetId,
      classical: ctx.classical,
      runs: persisted,
      planogram: section,
      prior,
      truth: ctx.truth,
      correction: ctx.correction,
    });
  }

  /** Rebuild the comparison from the LATEST stored run per provider —
   *  read-only; same video boundary as evaluate. */
  async report(
    tenantId: string,
    videoAssetId: string,
    input: PlanogramContextInput,
    viewer: { hasVideoAssetReadPermission?: boolean },
  ): Promise<PretrainedComparisonReport> {
    await this.requireVideoBoundary(tenantId, viewer);
    const ctx = await this.loadClipContext(tenantId, videoAssetId);
    const rows = await this.prisma.pretrainedVisionRun.findMany({
      where: { tenantId, videoAssetId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 50,
    });
    const latestByProvider = new Map<
      string,
      { provider: string; status: string; createdAt: Date; evidence: ProviderEvidence }
    >();
    for (const row of rows) {
      if (!latestByProvider.has(row.provider)) {
        latestByProvider.set(row.provider, {
          provider: row.provider,
          status: row.status,
          createdAt: row.createdAt,
          // Stored evidence was sanitized on the way IN; sanitize again
          // on the way OUT so even a hand-edited row cannot leak.
          evidence: sanitizeProviderEvidence(
            row.evidence as Parameters<typeof sanitizeProviderEvidence>[0],
          ),
        });
      }
    }
    const runs = [...latestByProvider.values()];
    const visual = this.visualCandidates(
      ctx.classical,
      runs.map((run) => ({ provider: run.provider, evidence: run.evidence })),
    );
    const { section, prior } = await this.planogramSection(
      tenantId,
      ctx.asset.locationId,
      input,
      visual,
    );
    return this.assembleReport({
      videoAssetId,
      classical: ctx.classical,
      runs,
      planogram: section,
      prior,
      truth: ctx.truth,
      correction: ctx.correction,
    });
  }
}
