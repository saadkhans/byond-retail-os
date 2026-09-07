import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FusionRunScope, PretrainedVisionRunStatus } from '@prisma/client';
import type { LocalDetectorRuntimePort } from '../local-vision-runtime/local-vision-runtime.port';
import { LOCAL_DETECTOR_RUNTIME } from '../local-vision-runtime/local-vision-runtime.tokens';
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
  NormalizedBox,
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
  /** WHERE this section came from — never mixed:
   *  SCORED_AT_EVALUATION = the immutable snapshot stored with the run;
   *  CURRENT_ACTIVE = live lookup (no stored snapshot exists);
   *  NOT_CONFIGURED = no planogram context at all. */
  source: 'SCORED_AT_EVALUATION' | 'CURRENT_ACTIVE' | 'NOT_CONFIGURED';
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
  /** WHO supplied the rack coordinates the cell was resolved from:
   *  OPERATOR = typed in with the request; DETECTOR = the center of the
   *  event product a READY, non-synthetic detector localized, mapped
   *  through `rackFrameRegion`; NONE = no coordinates (rack fallback). */
  coordinateSource: PlanogramCoordinateSource;
  /** Where the rack sits in the ANALYSIS frame (normalized), used for the
   *  DETECTOR mapping; null when the whole frame is the rack. */
  rackFrameRegion: RackFrameRegion | null;
  cellAssignmentConfidence: number | null;
  planogramCandidateSkus: string[];
  adjacentCellCandidateSkus: string[];
  rackCandidateSkus: string[];
  planogramMatchStatus: string;
  flags: string[];
  reviewRequired: boolean;
  candidates: { sku: string; score: number; planogramBoost: number }[];
  /** Phase 22 — where the rack context came from: REQUEST = typed with
   *  this call; ASSET = the clip's stored planogram binding (set at
   *  upload); NONE = no rack context. */
  bindingSource: PlanogramBindingSource;
}

export type PlanogramBindingSource = 'REQUEST' | 'ASSET' | 'NONE';

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

export type PlanogramCoordinateSource = 'OPERATOR' | 'DETECTOR' | 'NONE';

/** Normalized rectangle (0..1, top-left origin) of the ANALYSIS frame
 *  that the planogram rack occupies. Frame the rack tightly and leave it
 *  out (= whole frame). */
export interface RackFrameRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const WHOLE_FRAME_REGION: RackFrameRegion = {
  x: 0,
  y: 0,
  width: 1,
  height: 1,
};

export interface PlanogramContextInput {
  locationId?: string | null;
  rackCode?: string | null;
  normalizedRackX?: number | null;
  normalizedRackY?: number | null;
  rackFrameRegion?: RackFrameRegion | null;
}

/** Rack coordinates actually used for cell resolution, with provenance. */
export interface ResolvedRackCoordinates {
  normalizedRackX: number | null;
  normalizedRackY: number | null;
  source: PlanogramCoordinateSource;
  rackFrameRegion: RackFrameRegion | null;
  flags: string[];
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** Allowlist rebuild of a rack frame region: finite 0..1 numbers with a
 *  positive extent, or null (whole frame). Exported for tests. */
export function sanitizeRackFrameRegion(raw: unknown): RackFrameRegion | null {
  const region = raw as Partial<RackFrameRegion> | null | undefined;
  if (!region || typeof region !== 'object') {
    return null;
  }
  const values = [region.x, region.y, region.width, region.height];
  if (
    !values.every((value) => typeof value === 'number' && Number.isFinite(value))
  ) {
    return null;
  }
  const x = clamp01(region.x as number);
  const y = clamp01(region.y as number);
  const width = clamp01(region.width as number);
  const height = clamp01(region.height as number);
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

/**
 * Map the CENTER of an event product box (analysis-frame normalized)
 * onto rack-normalized coordinates through the rack frame region:
 * rx = (cx - region.x) / region.width (same for y). A center outside the
 * region is NOT coerced onto the rack — null. Exported for tests.
 */
export function mapEventBoxToRack(
  eventBox: NormalizedBox,
  region: RackFrameRegion | null,
): { normalizedRackX: number; normalizedRackY: number } | null {
  const rect = region ?? WHOLE_FRAME_REGION;
  const cx = eventBox.x + eventBox.width / 2;
  const cy = eventBox.y + eventBox.height / 2;
  if (
    cx < rect.x ||
    cx > rect.x + rect.width ||
    cy < rect.y ||
    cy > rect.y + rect.height
  ) {
    return null;
  }
  return {
    normalizedRackX: Math.round(clamp01((cx - rect.x) / rect.width) * 1000) / 1000,
    normalizedRackY: Math.round(clamp01((cy - rect.y) / rect.height) * 1000) / 1000,
  };
}

/**
 * The event product box a report may derive rack coordinates from: the
 * first READY, NON-synthetic, non-classical run whose features carry an
 * eventBox (the detector's localized vanished / appeared product). Lab
 * stubs and the classical baseline never steer the planogram cell.
 */
export function detectorEventBox(
  runs: { provider: string; evidence: ProviderEvidence }[],
): NormalizedBox | null {
  for (const run of runs) {
    if (
      run.provider !== 'CLASSICAL' &&
      run.evidence.availability === 'READY' &&
      run.evidence.synthetic === false &&
      run.evidence.features?.eventBox
    ) {
      return run.evidence.features.eventBox;
    }
  }
  return null;
}

@Injectable()
export class PretrainedVisionService {
  private readonly adapters: VisionProviderAdapter[];

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly platformModules: PlatformModulesService,
    private readonly planograms: PlanogramService,
    // The LOCAL detector runtime PORT (bound by local-vision-runtime).
    // Optional: without a binding the detector slot reports
    // UNAVAILABLE / LOCAL_RUNTIME_NOT_INSTALLED exactly as before.
    @Optional()
    @Inject(LOCAL_DETECTOR_RUNTIME)
    detectorRuntime?: LocalDetectorRuntimePort,
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
      new YoloVisionAdapter(yoloEnabled, stubMode, detectorRuntime ?? null),
      new HandSignalAdapter(handEnabled, stubMode),
      new EmbeddingRetrievalAdapter(embeddingEnabled, stubMode),
    ];
  }

  async providerStatuses(): Promise<ProviderStatus[]> {
    const statuses: ProviderStatus[] = [];
    for (const adapter of this.adapters) {
      statuses.push(await adapter.status());
    }
    return statuses;
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

  /**
   * Phase 22: a clip bound to a planogram rack at upload supplies the
   * rack context itself. Explicit request values win (the operator can
   * always override); the stored binding fills what the request omits.
   */
  private applyAssetBinding(
    input: PlanogramContextInput,
    asset: { planogramRackCode: string | null; rackFrameRegion: unknown },
  ): { input: PlanogramContextInput; bindingSource: PlanogramBindingSource } {
    const requestRack = input.rackCode ?? null;
    const assetRack = asset.planogramRackCode ?? null;
    const rackCode = requestRack ?? assetRack;
    const rackFrameRegion =
      input.rackFrameRegion ??
      (requestRack === null ? sanitizeRackFrameRegion(asset.rackFrameRegion) : null);
    return {
      input: { ...input, rackCode, rackFrameRegion },
      bindingSource: requestRack ? 'REQUEST' : assetRack ? 'ASSET' : 'NONE',
    };
  }

  private async loadClipContext(tenantId: string, videoAssetId: string) {
    const asset = await this.prisma.videoAsset.findFirst({
      where: { tenantId, id: videoAssetId, deletedAt: null },
      select: {
        id: true,
        width: true,
        height: true,
        locationId: true,
        planogramRackCode: true,
        rackFrameRegion: true,
      },
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
    };
  }

  /**
   * The store a clip's planogram context is allowed to come from
   * (Codex-class P1: wrong-store contamination). A clip captured in a
   * store can ONLY be scored against that store's planograms — an
   * explicit locationId must match it. Only a store-less clip may take
   * an explicit (tenant-validated) location.
   */
  private async resolvePlanogramLocation(
    tenantId: string,
    asset: { locationId: string | null },
    input: PlanogramContextInput,
  ): Promise<string | null> {
    if (asset.locationId) {
      if (input.locationId && input.locationId !== asset.locationId) {
        throw new BadRequestException(
          'this clip was captured in a different store — planogram ' +
            'context must use the clip’s own store',
        );
      }
      return asset.locationId;
    }
    if (input.locationId) {
      const location = await this.prisma.location.findFirst({
        where: { tenantId, id: input.locationId },
        select: { id: true },
      });
      if (!location) {
        throw new NotFoundException('Store not found in this tenant');
      }
      return input.locationId;
    }
    return null;
  }

  private async resolveNarrowing(
    tenantId: string,
    asset: { locationId: string | null },
    input: PlanogramContextInput,
    coordinates?: { normalizedRackX: number | null; normalizedRackY: number | null },
  ) {
    const locationId = await this.resolvePlanogramLocation(
      tenantId,
      asset,
      input,
    );
    if (!locationId || !input.rackCode) {
      return null;
    }
    const point = coordinates ?? {
      normalizedRackX: input.normalizedRackX ?? null,
      normalizedRackY: input.normalizedRackY ?? null,
    };
    return this.planograms.narrowCandidates(tenantId, {
      locationId,
      rackCode: input.rackCode,
      normalizedRackX: point.normalizedRackX,
      normalizedRackY: point.normalizedRackY,
    });
  }

  /** Operator coordinates as given (source OPERATOR when any was typed). */
  private operatorCoordinates(input: PlanogramContextInput): ResolvedRackCoordinates {
    const x = input.normalizedRackX ?? null;
    const y = input.normalizedRackY ?? null;
    return {
      normalizedRackX: x,
      normalizedRackY: y,
      source: x !== null || y !== null ? 'OPERATOR' : 'NONE',
      rackFrameRegion: sanitizeRackFrameRegion(input.rackFrameRegion),
      flags: [],
    };
  }

  /**
   * Detector-supplied rack coordinates (Phase 21): only when the operator
   * typed none, a planogram context exists, and a READY non-synthetic
   * detector localized the event product. Its center maps through the
   * rack frame region (default: the whole frame); a center outside the
   * region yields NO coordinates and the EVENT_OUTSIDE_RACK_REGION flag.
   */
  private detectorCoordinates(
    operator: ResolvedRackCoordinates,
    runs: { provider: string; evidence: ProviderEvidence }[],
  ): ResolvedRackCoordinates | null {
    if (operator.source === 'OPERATOR') {
      return null;
    }
    const eventBox = detectorEventBox(runs);
    if (!eventBox) {
      return null;
    }
    const mapped = mapEventBoxToRack(eventBox, operator.rackFrameRegion);
    if (!mapped) {
      return { ...operator, flags: ['EVENT_OUTSIDE_RACK_REGION'] };
    }
    return {
      normalizedRackX: mapped.normalizedRackX,
      normalizedRackY: mapped.normalizedRackY,
      source: 'DETECTOR',
      rackFrameRegion: operator.rackFrameRegion,
      flags: [],
    };
  }

  /**
   * The embedding candidate scope (Codex-class P1: no blind cap). Built
   * in priority order — planogram cell → adjacent → rack → classical top
   * — then the FULL tenant reference library (reference-ready products,
   * id/sku only, no alphabetical truncation: the correct SKU can never
   * fall outside the search space by ordering). Output candidate lists
   * stay bounded by the sanitizer AFTER ranking.
   */
  private async resolveReferenceScope(
    tenantId: string,
    narrowed: NarrowedCandidates | null,
    classicalTopSku: string | null,
  ): Promise<{ productId: string; sku: string }[]> {
    const referenceReady = await this.prisma.product.findMany({
      where: { tenantId, referenceImages: { some: {} } },
      select: { id: true, sku: true },
      orderBy: [{ sku: 'asc' }],
    });
    const bySku = new Map(referenceReady.map((row) => [row.sku, row]));
    // Classical top SKU joins the scope even without reference images —
    // the comparison must be able to rank the classical hypothesis.
    if (classicalTopSku && !bySku.has(classicalTopSku)) {
      const product = await this.prisma.product.findFirst({
        where: { tenantId, sku: classicalTopSku },
        select: { id: true, sku: true },
      });
      if (product) {
        bySku.set(product.sku, product);
      }
    }
    const prioritized: { productId: string; sku: string }[] = [];
    const seen = new Set<string>();
    const push = (sku: string) => {
      const row = bySku.get(sku);
      if (row && !seen.has(row.sku)) {
        seen.add(row.sku);
        prioritized.push({ productId: row.id, sku: row.sku });
      }
    };
    for (const sku of narrowed?.cellSkus ?? []) {
      push(sku);
    }
    for (const sku of narrowed?.adjacentSkus ?? []) {
      push(sku);
    }
    for (const sku of narrowed?.rackSkus ?? []) {
      push(sku);
    }
    if (classicalTopSku) {
      push(classicalTopSku);
    }
    for (const row of bySku.values()) {
      if (!seen.has(row.sku)) {
        seen.add(row.sku);
        prioritized.push({ productId: row.id, sku: row.sku });
      }
    }
    return prioritized;
  }

  private buildPlanogramSection(
    narrowed:
      | (NarrowedCandidates & {
          rackId: string;
          rackCode: string;
          version: number;
        })
      | null,
    coordinates: ResolvedRackCoordinates,
    visualCandidates: { sku: string; score: number }[],
    source: PlanogramSection['source'],
    bindingSource: PlanogramBindingSource = 'NONE',
  ): PlanogramSection {
    const prior: PlanogramPriorResult = applyPlanogramPrior(
      visualCandidates,
      narrowed,
    );
    return {
      source: narrowed === null && source !== 'SCORED_AT_EVALUATION'
        ? 'NOT_CONFIGURED'
        : source,
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
      normalizedRackX: coordinates.normalizedRackX,
      normalizedRackY: coordinates.normalizedRackY,
      coordinateSource: narrowed === null ? 'NONE' : coordinates.source,
      rackFrameRegion: coordinates.rackFrameRegion,
      cellAssignmentConfidence: narrowed?.cell?.confidence ?? null,
      planogramCandidateSkus: narrowed?.cellSkus ?? [],
      adjacentCellCandidateSkus: narrowed?.adjacentSkus ?? [],
      rackCandidateSkus: narrowed?.rackSkus ?? [],
      planogramMatchStatus: prior.matchStatus,
      flags: [...new Set([...prior.flags, ...coordinates.flags])],
      reviewRequired: prior.reviewRequired,
      candidates: prior.candidates.slice(0, 10),
      bindingSource: narrowed === null ? 'NONE' : bindingSource,
    };
  }

  /** Allowlist rebuild of a STORED scored-planogram snapshot on its way
   *  OUT — even a hand-edited row cannot leak or change shape. */
  private sanitizeStoredPlanogramSection(raw: unknown): PlanogramSection | null {
    const section = raw as Partial<PlanogramSection> | null | undefined;
    if (!section || typeof section !== 'object') {
      return null;
    }
    const skuList = (value: unknown) =>
      (Array.isArray(value) ? value : [])
        .filter((sku): sku is string => typeof sku === 'string')
        .slice(0, 64);
    const codeList = (value: unknown) =>
      (Array.isArray(value) ? value : [])
        .filter(
          (code): code is string =>
            typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code),
        )
        .slice(0, 16);
    const num01 = (value: unknown) =>
      typeof value === 'number' && Number.isFinite(value)
        ? Math.min(1, Math.max(0, value))
        : null;
    return {
      // A stored snapshot is BY DEFINITION the scored evidence.
      source: 'SCORED_AT_EVALUATION',
      configured: section.configured === true,
      rackId: typeof section.rackId === 'string' ? section.rackId : null,
      rackCode: typeof section.rackCode === 'string' ? section.rackCode : null,
      version:
        typeof section.version === 'number' && Number.isInteger(section.version)
          ? section.version
          : null,
      cell:
        section.cell &&
        typeof section.cell === 'object' &&
        typeof section.cell.cellCode === 'string'
          ? {
              cellCode: section.cell.cellCode,
              rowIndex: Number(section.cell.rowIndex) || 0,
              columnIndex: Number(section.cell.columnIndex) || 0,
              confidence: num01(section.cell.confidence) ?? 0,
            }
          : null,
      normalizedRackX: num01(section.normalizedRackX),
      normalizedRackY: num01(section.normalizedRackY),
      coordinateSource:
        section.coordinateSource === 'OPERATOR' ||
        section.coordinateSource === 'DETECTOR'
          ? section.coordinateSource
          : 'NONE',
      rackFrameRegion: sanitizeRackFrameRegion(section.rackFrameRegion),
      bindingSource:
        section.bindingSource === 'REQUEST' || section.bindingSource === 'ASSET'
          ? section.bindingSource
          : 'NONE',
      cellAssignmentConfidence: num01(section.cellAssignmentConfidence),
      planogramCandidateSkus: skuList(section.planogramCandidateSkus),
      adjacentCellCandidateSkus: skuList(section.adjacentCellCandidateSkus),
      rackCandidateSkus: skuList(section.rackCandidateSkus),
      planogramMatchStatus:
        typeof section.planogramMatchStatus === 'string' &&
        /^[A-Z_]{1,40}$/.test(section.planogramMatchStatus)
          ? section.planogramMatchStatus
          : 'UNKNOWN_CELL',
      flags: codeList(section.flags),
      reviewRequired: section.reviewRequired === true,
      candidates: (Array.isArray(section.candidates) ? section.candidates : [])
        .filter(
          (row): row is { sku: string; score: number; planogramBoost: number } =>
            !!row &&
            typeof (row as { sku?: unknown }).sku === 'string' &&
            typeof (row as { score?: unknown }).score === 'number',
        )
        .map((row) => ({
          sku: row.sku,
          score: row.score,
          planogramBoost:
            typeof row.planogramBoost === 'number' ? row.planogramBoost : 0,
        }))
        .slice(0, 10),
    };
  }

  private async assembleReport(input: {
    videoAssetId: string;
    classical: SafeFusionSummary | null;
    runs: {
      provider: string;
      status: string;
      createdAt: Date;
      evidence: ProviderEvidence;
    }[];
    planogram: PlanogramSection;
    truth: { eventKind: string; product: { sku: string } | null } | null;
    correction: {
      verdict: string;
      expectedAction: string;
      expectedSku: string | null;
    } | null;
  }): Promise<PretrainedComparisonReport> {
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
    // Report-level hand signal: the dedicated hand provider when it has
    // one, otherwise the detector's own (a hand-capable YOLO model under
    // CV_PRETRAINED_PROVIDER=yolo_local is the documented way to get
    // hands without MediaPipe) - never silently "no hand" while the
    // detector evidence carries contact.
    const handSignal =
      handRun?.evidence.handSignal ??
      detectorRun?.evidence.handSignal ??
      null;

    // Final fusion SUGGESTION (advisory only — never applied anywhere):
    // planogram-boosted top candidate + the strongest available action
    // signal. UNKNOWN or any disagreement stays review-required.
    const suggestedSku = input.planogram.candidates.length
      ? input.planogram.candidates[0].sku
      : null;
    const detectorAction =
      detectorRun?.evidence.features?.actionCandidate ?? null;
    const suggestedAction: ActionCandidate =
      detectorAction && detectorAction !== 'UNKNOWN'
        ? detectorAction
        : classicalAction;
    const suggestionNotes: string[] = [];
    let reviewRequired = input.planogram.reviewRequired;
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
    // The classical stage found no event (or never ran) and a READY,
    // non-synthetic detector proposes one: the suggestion carries the
    // detector's action, labeled as detector-only — still review-gated.
    if (
      classicalAction === 'UNKNOWN' &&
      detectorAction &&
      detectorAction !== 'UNKNOWN' &&
      detectorRun?.evidence.availability === 'READY' &&
      detectorRun.evidence.synthetic === false
    ) {
      reviewRequired = true;
      suggestionNotes.push('DETECTOR_ONLY_EVENT');
    }
    // HARD GATE (Phase 20): real (non-synthetic) pretrained evidence is
    // advisory until confidence thresholds and gates are explicitly
    // approved in a later phase — every such suggestion stays
    // review-required regardless of agreement or planogram match.
    const realPretrainedContributed = [detectorRun, handRun, embeddingRun].some(
      (run) =>
        run !== undefined &&
        run.evidence.availability === 'READY' &&
        run.evidence.synthetic === false,
    );
    if (realPretrainedContributed) {
      reviewRequired = true;
      suggestionNotes.push('PRETRAINED_GATE_NOT_APPROVED');
    }
    if (reviewRequired) {
      suggestionNotes.push('STILL_NEEDS_REVIEW');
    }

    // Operator-facing improvement rollup — classified codes only.
    const improvementNotes: string[] = [];
    const pretrainedReady = [detectorRun, handRun, embeddingRun].some(
      (run) => run && run.evidence.availability === 'READY',
    );
    // A hand-capable model can legitimately return only HAND rows -
    // "product detected" needs an actual product label.
    if (
      detectorRun?.evidence.detections.some(
        (row) => row.label === 'PRODUCT' || row.label === 'PRODUCT_IN_HAND',
      )
    ) {
      improvementNotes.push('PRODUCT_DETECTED');
    }
    // Detection coverage: the classical baseline yields at most one
    // selected crop frame; a detector that saw the product in at least
    // two more sampled frames improved the evidence timeline.
    const classicalProductFrames = input.classical?.selectedCrop ? 1 : 0;
    const detectorProductFrames = new Set(
      (detectorRun?.evidence.detections ?? [])
        .filter((row) => row.label === 'PRODUCT' || row.label === 'PRODUCT_IN_HAND')
        .map((row) => row.timestampMs),
    ).size;
    if (
      detectorRun?.evidence.availability === 'READY' &&
      detectorProductFrames >= classicalProductFrames + 2
    ) {
      improvementNotes.push('DETECTION_COVERAGE_IMPROVED');
    }
    // Hand contact is a signal the classical pipeline never produces.
    const detectorContactMs = detectorRun?.evidence.handSignal?.contactDurationMs ?? null;
    if (
      detectorRun?.evidence.availability === 'READY' &&
      detectorContactMs !== null &&
      detectorContactMs > 0
    ) {
      improvementNotes.push('HAND_CONTACT_OBSERVED');
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
      providers: await this.providerStatuses(),
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
    rawInput: PlanogramContextInput,
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
    const bound = this.applyAssetBinding(rawInput, ctx.asset);
    const input = bound.input;
    // Planogram narrowing FIRST: it validates the store binding (a
    // mismatched location rejects BEFORE anything runs or persists) and
    // its tiers seed the embedding candidate scope.
    const narrowed = await this.resolveNarrowing(tenantId, ctx.asset, input);
    const referenceSkus = await this.resolveReferenceScope(
      tenantId,
      narrowed,
      ctx.classical?.topSku ?? null,
    );
    const adapterContext: AdapterAnalysisContext = {
      tenantId,
      videoAssetId,
      classical: ctx.classical,
      analysisDims: ctx.analysisDims,
      referenceSkus,
    };
    // Sequential on purpose: a local runtime owns the GPU/CPU for the
    // duration of a clip, and a throwing OR rejecting adapter degrades
    // to a classified envelope — never a raw error message.
    const evidences: ProviderEvidence[] = [];
    for (const adapter of this.adapters) {
      try {
        evidences.push(await adapter.analyze(adapterContext));
      } catch {
        evidences.push(
          sanitizeProviderEvidence({
            provider: adapter.provider,
            availability: 'UNAVAILABLE',
            reasonCode: 'ADAPTER_ERROR',
            synthetic: false,
            notes: ['ADAPTER_ERROR'],
          }),
        );
      }
    }

    const runsForVisual = evidences.map((evidence) => ({
      provider: evidence.provider,
      evidence,
    }));
    const visual = this.visualCandidates(ctx.classical, runsForVisual);
    // Detector-supplied rack coordinates: when the operator typed none
    // and a READY non-synthetic detector localized the event product,
    // narrowing is RE-RUN with its mapped center before persisting (the
    // adapters' reference scope above deliberately used the rack-level
    // narrowing — it only orders candidates, never excludes any).
    let coordinates = this.operatorCoordinates(input);
    let scoredNarrowing = narrowed;
    const fromDetector = this.detectorCoordinates(coordinates, runsForVisual);
    if (fromDetector) {
      coordinates = fromDetector;
      if (fromDetector.source === 'DETECTOR' && narrowed !== null) {
        scoredNarrowing = await this.resolveNarrowing(tenantId, ctx.asset, input, {
          normalizedRackX: fromDetector.normalizedRackX,
          normalizedRackY: fromDetector.normalizedRackY,
        });
      }
    }
    const section = this.buildPlanogramSection(
      scoredNarrowing,
      coordinates,
      visual,
      'SCORED_AT_EVALUATION',
      bound.bindingSource,
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
          // The EXACT scored planogram snapshot — immutable evidence a
          // later planogram publish can never rewrite.
          planogramEvidence: section as unknown as object,
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
      truth: ctx.truth,
      correction: ctx.correction,
    });
  }

  /** Rebuild the comparison from the LATEST stored run per provider —
   *  read-only; same video boundary as evaluate. */
  async report(
    tenantId: string,
    videoAssetId: string,
    rawInput: PlanogramContextInput,
    viewer: { hasVideoAssetReadPermission?: boolean },
  ): Promise<PretrainedComparisonReport> {
    await this.requireVideoBoundary(tenantId, viewer);
    const ctx = await this.loadClipContext(tenantId, videoAssetId);
    const bound = this.applyAssetBinding(rawInput, ctx.asset);
    const input = bound.input;
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
    // VERSION SAFETY: when a stored scored-planogram snapshot exists,
    // the report shows EXACTLY it — publishing a new planogram version
    // never rewrites what an old run was scored against. Only when no
    // snapshot exists does the report compute a (clearly labeled)
    // CURRENT_ACTIVE section from live data.
    const storedSnapshotRow = rows.find(
      (row) => row.planogramEvidence !== null,
    );
    const storedSection = storedSnapshotRow
      ? this.sanitizeStoredPlanogramSection(storedSnapshotRow.planogramEvidence)
      : null;
    let section = storedSection;
    if (!section) {
      let coordinates = this.operatorCoordinates(input);
      let narrowed = await this.resolveNarrowing(tenantId, ctx.asset, input);
      const fromDetector = this.detectorCoordinates(coordinates, runs);
      if (fromDetector) {
        coordinates = fromDetector;
        if (fromDetector.source === 'DETECTOR' && narrowed !== null) {
          narrowed = await this.resolveNarrowing(tenantId, ctx.asset, input, {
            normalizedRackX: fromDetector.normalizedRackX,
            normalizedRackY: fromDetector.normalizedRackY,
          });
        }
      }
      section = this.buildPlanogramSection(
        narrowed,
        coordinates,
        visual,
        'CURRENT_ACTIVE',
        bound.bindingSource,
      );
    }
    return this.assembleReport({
      videoAssetId,
      classical: ctx.classical,
      runs,
      planogram: section,
      truth: ctx.truth,
      correction: ctx.correction,
    });
  }
}
