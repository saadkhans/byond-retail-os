import {
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { FusionRunScope, VideoAssetStatus } from '@prisma/client';
import { AuditActor } from '../common/audit/audit-log.service';
import { PickupDetectionService } from '../pickup-detection/pickup-detection.service';
import { PickupFusionService } from '../pickup-fusion/pickup-fusion.service';
import { PlatformModulesService } from '../platform-modules/platform-modules.service';
import { PretrainedVisionService } from '../pretrained-vision/pretrained-vision.service';
import { PrismaService } from '../prisma/prisma.service';
import { VideoAssetsRepository } from '../video-ingest/video-assets.repository';
import { VideoAssetsService } from '../video-ingest/video-assets.service';
import { sanitizeStoredRackFrameRegion } from '../video-ingest/video-asset-binding';
import {
  ClipLabReport,
  ClipLabStep,
  ClipLabStepResult,
  ClipLabStepStatus,
} from './clip-lab.types';

const CODE_PATTERN = /^[A-Z0-9_]{1,64}$/;

/** Classified code or a fixed fallback — never a message. */
function code(value: unknown, fallback: string): string {
  return typeof value === 'string' && CODE_PATTERN.test(value) ? value : fallback;
}

/** An HttpException becomes its status class; anything else STAGE_FAILED. */
function failureCode(error: unknown, fallback: string): string {
  if (error instanceof HttpException) {
    const status = error.getStatus();
    if (status === 409) return 'CONFLICT';
    if (status === 404) return 'NOT_FOUND';
    if (status === 403) return 'FORBIDDEN';
    if (status === 400) return 'BAD_REQUEST';
    if (status === 503) return 'STAGE_UNAVAILABLE';
  }
  return fallback;
}

type Viewer = { hasVideoAssetReadPermission?: boolean };

/**
 * Phase 22 — Clip Lab orchestration. Runs the existing stages in order
 * for ONE clip (validate → v1 detection → fusion v2 → pretrained
 * evaluation) using the planogram binding stored on the asset, and
 * assembles one report. Screening approval is NEVER performed here: it
 * is an audited human decision on the quarantine frames.
 */
@Injectable()
export class ClipLabService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly assets: VideoAssetsRepository,
    private readonly videoAssets: VideoAssetsService,
    private readonly detection: PickupDetectionService,
    private readonly fusion: PickupFusionService,
    private readonly pretrained: PretrainedVisionService,
    private readonly platformModules: PlatformModulesService,
  ) {}

  private async requireVideoBoundary(tenantId: string, viewer: Viewer): Promise<void> {
    if (viewer.hasVideoAssetReadPermission !== true) {
      throw new ForbiddenException('video-asset:read is required for Clip Lab');
    }
    if (!(await this.platformModules.isEnabledForTenant(tenantId, 'video-ingest'))) {
      throw new ForbiddenException('video-ingest module is not enabled for this tenant');
    }
  }

  async run(
    tenantId: string,
    videoAssetId: string,
    actor: AuditActor | undefined,
    viewer: Viewer,
  ): Promise<ClipLabReport> {
    await this.requireVideoBoundary(tenantId, viewer);
    const asset = await this.assets.findById(tenantId, videoAssetId);
    if (!asset) {
      throw new NotFoundException('Video asset not found');
    }
    const steps: ClipLabStepResult[] = [];
    const step = (
      name: ClipLabStep,
      status: ClipLabStepStatus,
      reasonCode: string | null,
      startedAt: number | null,
    ) => {
      steps.push({
        step: name,
        status,
        reasonCode: reasonCode === null ? null : code(reasonCode, 'STAGE_FAILED'),
        ms: startedAt === null ? null : Date.now() - startedAt,
      });
    };

    // ---- SCREENING (human decision; reported, never performed) --------
    let status: VideoAssetStatus = asset.status;
    if (status === VideoAssetStatus.QUARANTINED) {
      step('SCREENING', 'BLOCKED', 'SCREENING_APPROVAL_REQUIRED', null);
      return this.assemble(tenantId, videoAssetId, steps, null, viewer);
    }
    if (
      status === VideoAssetStatus.PENDING_MEDIA ||
      status === VideoAssetStatus.REJECTED ||
      status === VideoAssetStatus.FAILED
    ) {
      step('SCREENING', 'BLOCKED', `ASSET_${status}`, null);
      return this.assemble(tenantId, videoAssetId, steps, null, viewer);
    }
    step('SCREENING', 'OK', 'SCREENED', null);

    // ---- VALIDATE ----------------------------------------------------
    if (status === VideoAssetStatus.UPLOADED) {
      const startedAt = Date.now();
      try {
        const validated = await this.videoAssets.validate(tenantId, videoAssetId, actor);
        status = validated.status;
        if (status !== VideoAssetStatus.VALIDATED && status !== VideoAssetStatus.READY) {
          step('VALIDATE', 'FAILED', code(validated.errorCode, 'VALIDATION_FAILED'), startedAt);
          return this.assemble(tenantId, videoAssetId, steps, null, viewer);
        }
        step('VALIDATE', 'OK', null, startedAt);
      } catch (error) {
        step('VALIDATE', 'FAILED', failureCode(error, 'VALIDATION_FAILED'), startedAt);
        return this.assemble(tenantId, videoAssetId, steps, null, viewer);
      }
    } else {
      step('VALIDATE', 'SKIPPED', 'ALREADY_VALIDATED', null);
    }

    // ---- DETECTION (v1, idempotent; a NO_MOTION_EVENT does not stop) --
    {
      const startedAt = Date.now();
      try {
        const state = await this.detection.detectForAsset(tenantId, videoAssetId, {
          force: false,
        });
        if (state.job?.status === 'SUCCEEDED') {
          step('DETECTION', 'OK', null, startedAt);
        } else if (state.job?.status === 'FAILED') {
          step('DETECTION', 'FAILED', code(state.job.errorCode, 'DETECTION_FAILED'), startedAt);
        } else {
          step('DETECTION', 'FAILED', 'DETECTION_NOT_TERMINAL', startedAt);
        }
      } catch (error) {
        step('DETECTION', 'FAILED', failureCode(error, 'DETECTION_FAILED'), startedAt);
      }
    }

    // ---- FUSION v2 ---------------------------------------------------
    {
      const startedAt = Date.now();
      try {
        const { runId } = await this.fusion.run(tenantId, videoAssetId);
        const row = await this.prisma.pickupFusionRun.findFirst({
          where: { tenantId, id: runId },
          select: { policy: true },
        });
        step('FUSION', 'OK', row ? code(row.policy, 'COMPLETED') : 'COMPLETED', startedAt);
      } catch (error) {
        step('FUSION', 'FAILED', failureCode(error, 'FUSION_FAILED'), startedAt);
        return this.assemble(tenantId, videoAssetId, steps, null, viewer);
      }
    }

    // ---- PRETRAINED (uses the asset's stored binding) ------------------
    {
      const startedAt = Date.now();
      try {
        const report = await this.pretrained.evaluate(
          tenantId,
          videoAssetId,
          {},
          actor?.id,
          viewer,
        );
        step('PRETRAINED', 'OK', null, startedAt);
        return this.assemble(tenantId, videoAssetId, steps, report, viewer);
      } catch (error) {
        step('PRETRAINED', 'FAILED', failureCode(error, 'PRETRAINED_FAILED'), startedAt);
        return this.assemble(tenantId, videoAssetId, steps, null, viewer);
      }
    }
  }

  /** Read-only: the same report shape from what is already stored. */
  async report(tenantId: string, videoAssetId: string, viewer: Viewer): Promise<ClipLabReport> {
    await this.requireVideoBoundary(tenantId, viewer);
    const asset = await this.assets.findById(tenantId, videoAssetId);
    if (!asset) {
      throw new NotFoundException('Video asset not found');
    }
    const steps: ClipLabStepResult[] = [];
    if (asset.status === VideoAssetStatus.QUARANTINED) {
      steps.push({ step: 'SCREENING', status: 'BLOCKED', reasonCode: 'SCREENING_APPROVAL_REQUIRED', ms: null });
    } else if (
      asset.status === VideoAssetStatus.VALIDATED ||
      asset.status === VideoAssetStatus.READY ||
      asset.status === VideoAssetStatus.UPLOADED
    ) {
      steps.push({ step: 'SCREENING', status: 'OK', reasonCode: 'SCREENED', ms: null });
    } else {
      steps.push({ step: 'SCREENING', status: 'BLOCKED', reasonCode: `ASSET_${asset.status}`, ms: null });
    }
    steps.push({
      step: 'VALIDATE',
      status:
        asset.status === VideoAssetStatus.VALIDATED || asset.status === VideoAssetStatus.READY
          ? 'OK'
          : 'NOT_RUN',
      reasonCode: null,
      ms: null,
    });
    const detection = await this.detection.getState(tenantId, videoAssetId);
    steps.push({
      step: 'DETECTION',
      status:
        detection.job?.status === 'SUCCEEDED'
          ? 'OK'
          : detection.job?.status === 'FAILED'
            ? 'FAILED'
            : 'NOT_RUN',
      reasonCode: detection.job?.status === 'FAILED' ? code(detection.job.errorCode, 'DETECTION_FAILED') : null,
      ms: null,
    });
    const fusionRow = await this.prisma.pickupFusionRun.findFirst({
      where: { tenantId, videoAssetId, runScope: FusionRunScope.WHOLE_CLIP },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { policy: true },
    });
    steps.push({
      step: 'FUSION',
      status: fusionRow ? 'OK' : 'NOT_RUN',
      reasonCode: fusionRow ? code(fusionRow.policy, 'COMPLETED') : null,
      ms: null,
    });
    let report: Awaited<ReturnType<PretrainedVisionService['report']>> | null = null;
    if (fusionRow) {
      try {
        report = await this.pretrained.report(tenantId, videoAssetId, {}, viewer);
      } catch {
        report = null;
      }
    }
    steps.push({
      step: 'PRETRAINED',
      status: report && report.runs.length > 0 ? 'OK' : 'NOT_RUN',
      reasonCode: null,
      ms: null,
    });
    return this.assemble(tenantId, videoAssetId, steps, report, viewer);
  }

  private async assemble(
    tenantId: string,
    videoAssetId: string,
    steps: ClipLabStepResult[],
    report: Awaited<ReturnType<PretrainedVisionService['report']>> | null,
    _viewer: Viewer,
  ): Promise<ClipLabReport> {
    const asset = await this.assets.findById(tenantId, videoAssetId);
    if (!asset) {
      throw new NotFoundException('Video asset not found');
    }
    const truth = await this.prisma.videoGroundTruth.findFirst({
      where: { tenantId, videoAssetId },
      select: {
        eventKind: true,
        actualTimestampMs: true,
        product: { select: { sku: true } },
      },
    });
    const fusionRow = await this.prisma.pickupFusionRun.findFirst({
      where: { tenantId, videoAssetId, runScope: FusionRunScope.WHOLE_CLIP },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { evidence: true },
    });
    const evidence = (fusionRow?.evidence ?? null) as {
      fused?: { sku?: unknown; fusedScore?: unknown }[];
      planogramScope?: { excludedProductCount?: unknown } | null;
    } | null;
    const fused = Array.isArray(evidence?.fused) ? evidence.fused : [];
    const items = fused
      .filter((row) => typeof row.sku === 'string' && typeof row.fusedScore === 'number')
      .slice(0, 5)
      .map((row) => ({
        sku: row.sku as string,
        score: Math.round((row.fusedScore as number) * 1000) / 1000,
      }));
    const scope = evidence?.planogramScope ?? null;
    const planogram = report?.planogram ?? null;
    const why = new Set<string>();
    for (const note of report?.improvementNotes ?? []) why.add(code(note, 'NOTE'));
    for (const note of report?.fusionSuggestion.notes ?? []) why.add(code(note, 'NOTE'));
    const detectorRun = report?.runs.find(
      (row) => row.provider !== 'CLASSICAL' && row.evidence.availability === 'READY',
    );
    for (const note of detectorRun?.evidence.notes ?? []) why.add(code(note, 'NOTE'));
    if (scope) why.add('PLANOGRAM_SCOPED_CANDIDATES');
    for (const row of steps) {
      if (row.status === 'FAILED' || row.status === 'BLOCKED') {
        why.add(`${row.step}_${row.reasonCode ?? row.status}`.slice(0, 64));
      }
    }
    return {
      asset: {
        id: asset.id,
        name: asset.originalFilename,
        status: asset.status,
        store: asset.location ? { id: asset.location.id, name: asset.location.name, code: asset.location.code } : null,
        rackCode: asset.planogramRackCode ?? null,
        rackFrameRegion: sanitizeStoredRackFrameRegion(asset.rackFrameRegion),
        groundTruth: truth
          ? {
              eventKind: truth.eventKind,
              sku: truth.product?.sku ?? null,
              actualTimestampMs: truth.actualTimestampMs ?? null,
            }
          : null,
      },
      steps,
      suggestion: report
        ? {
            sku: report.fusionSuggestion.sku,
            action: report.fusionSuggestion.action,
            // Phase 20 gate: Clip Lab never relaxes review.
            reviewRequired: true,
            notes: report.fusionSuggestion.notes,
          }
        : null,
      planogram: planogram
        ? {
            configured: planogram.configured,
            rackCode: planogram.rackCode,
            bindingSource: planogram.bindingSource,
            cell: planogram.cell?.cellCode ?? null,
            coordinateSource: planogram.coordinateSource,
            matchStatus: planogram.planogramMatchStatus,
            expectedSkus: planogram.planogramCandidateSkus,
            flags: planogram.flags,
          }
        : null,
      candidates: {
        scoped: scope !== null,
        excludedProductCount:
          typeof scope?.excludedProductCount === 'number' ? scope.excludedProductCount : 0,
        items,
      },
      providers: (report?.providers ?? []).map((provider) => ({
        provider: provider.provider,
        availability: provider.availability,
        reasonCode: provider.reasonCode,
        modelId: provider.runtime?.modelId ?? null,
      })),
      why: [...why].filter((row) => CODE_PATTERN.test(row)),
      links: {
        videoAssetPage: `/video-assets/${asset.id}`,
        pretrainedPage: '/pretrained-vision',
      },
    };
  }
}
