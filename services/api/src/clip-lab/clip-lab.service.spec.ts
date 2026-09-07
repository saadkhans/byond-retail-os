import { ForbiddenException } from '@nestjs/common';
import { ClipLabService } from './clip-lab.service';

/**
 * Phase 22 — Clip Lab orchestration: the stages run in order with the
 * asset's stored binding, a NO_MOTION_EVENT detection does not stop the
 * run, screening approval is never performed, and the report carries
 * classified codes only.
 */
type Row = Record<string, unknown>;

function buildHarness(options: {
  status?: string;
  rackCode?: string | null;
  detection?: Row;
  detectionThrows?: Error;
  fusionThrows?: Error;
  pretrainedThrows?: Error;
  videoIngestEnabled?: boolean;
  fusionEvidence?: Row;
} = {}) {
  const asset = {
    id: 'va-1',
    originalFilename: 'clip.mp4',
    status: options.status ?? 'VALIDATED',
    location: { id: 'store-1', name: 'Pickup Lab', code: 'PICKUP-LAB' },
    locationId: 'store-1',
    unitId: null,
    deviceId: null,
    sessionId: null,
    planogramRackCode: options.rackCode === undefined ? 'SHELF-2X2' : options.rackCode,
    rackFrameRegion: { x: 0, y: 0, width: 1, height: 1 },
  };
  const prisma = {
    videoGroundTruth: {
      findFirst: jest.fn(async () => ({
        eventKind: 'PICKUP',
        actualTimestampMs: 4400,
        product: { sku: 'WATER-BOTTLE-500ML' },
      })),
    },
    pickupFusionRun: {
      findFirst: jest.fn(async () => ({
        policy: 'NEEDS_HUMAN_REVIEW',
        evidence: options.fusionEvidence ?? {
          fused: [
            { sku: 'WATER-BOTTLE-500ML', fusedScore: 0.2385 },
            { sku: 'SKU-LIME-GREEN', fusedScore: 0.2178 },
          ],
          planogramScope: { rackCode: 'SHELF-2X2', rackVersion: 1, scopedProductCount: 2, excludedProductCount: 8 },
          // Junk a hand-edited row could carry — must never reach the report.
          storageKey: 'tenant/x/original.mp4',
          stderr: 'Traceback (most recent call last)',
        },
      })),
    },
  };
  const assets = { findById: jest.fn(async () => asset) };
  const videoAssets = {
    validate: jest.fn(async () => ({ ...asset, status: 'VALIDATED', errorCode: null })),
  };
  const detection = {
    detectForAsset: jest.fn(async () => {
      if (options.detectionThrows) throw options.detectionThrows;
      return (
        options.detection ?? {
          enabled: true,
          job: { id: 'job-1', status: 'SUCCEEDED', errorCode: null },
          detection: {},
        }
      );
    }),
    getState: jest.fn(async () => options.detection ?? { enabled: true, job: { status: 'SUCCEEDED', errorCode: null }, detection: {} }),
  };
  const fusion = {
    run: jest.fn(async () => {
      if (options.fusionThrows) throw options.fusionThrows;
      return { runId: 'run-1' };
    }),
  };
  const pretrainedReport = {
    videoAssetId: 'va-1',
    providers: [
      { provider: 'CLASSICAL', availability: 'READY', reasonCode: null, runtime: null },
      { provider: 'YOLO_LOCAL', availability: 'READY', reasonCode: null, runtime: { modelId: 'yolov8n-coco' } },
    ],
    classical: { topSku: 'WATER-BOTTLE-500ML', topScore: 0.24, policy: 'NEEDS_HUMAN_REVIEW', action: 'RETURN' },
    runs: [
      {
        provider: 'YOLO_LOCAL',
        status: 'COMPLETED',
        synthetic: false,
        createdAt: new Date(),
        evidence: { availability: 'READY', notes: ['PRODUCT_COUNT_DECREASED', 'EVENT_PRODUCT_LOCALIZED'] },
      },
    ],
    embeddingCandidates: [],
    handSignal: null,
    planogram: {
      configured: true,
      rackCode: 'SHELF-2X2',
      bindingSource: 'ASSET',
      cell: { cellCode: 'B1', rowIndex: 1, columnIndex: 0, confidence: 0.61 },
      coordinateSource: 'DETECTOR',
      planogramMatchStatus: 'MATCH',
      planogramCandidateSkus: ['WATER-BOTTLE-500ML'],
      flags: [],
    },
    fusionSuggestion: { sku: 'WATER-BOTTLE-500ML', action: 'PICKUP', reviewRequired: true, notes: ['PRETRAINED_GATE_NOT_APPROVED'] },
    groundTruth: { eventKind: 'PICKUP', sku: 'WATER-BOTTLE-500ML' },
    operatorCorrection: null,
    improvementNotes: ['PRODUCT_DETECTED', 'DETECTION_COVERAGE_IMPROVED'],
  };
  const pretrained = {
    evaluate: jest.fn(async () => {
      if (options.pretrainedThrows) throw options.pretrainedThrows;
      return pretrainedReport;
    }),
    report: jest.fn(async () => pretrainedReport),
  };
  const platformModules = {
    isEnabledForTenant: jest.fn(async () => options.videoIngestEnabled ?? true),
  };
  const service = new ClipLabService(
    prisma as never,
    assets as never,
    videoAssets as never,
    detection as never,
    fusion as never,
    pretrained as never,
    platformModules as never,
  );
  return { service, assets, videoAssets, detection, fusion, pretrained, prisma };
}

const VIEWER = { hasVideoAssetReadPermission: true };
const ACTOR = { id: 'u-1', email: 'admin@byond.local' };

describe('ClipLabService.run (Phase 22)', () => {
  it('enforces the video-asset read boundary before touching anything', async () => {
    const { service, assets } = buildHarness();
    await expect(
      service.run('tenant-1', 'va-1', ACTOR, { hasVideoAssetReadPermission: false }),
    ).rejects.toThrow(ForbiddenException);
    const noModule = buildHarness({ videoIngestEnabled: false });
    await expect(noModule.service.run('tenant-1', 'va-1', ACTOR, VIEWER)).rejects.toThrow(
      ForbiddenException,
    );
    expect(assets.findById).not.toHaveBeenCalled();
  });

  it('a QUARANTINED clip is BLOCKED on screening and NO stage runs (approval stays human)', async () => {
    const { service, videoAssets, detection, fusion, pretrained } = buildHarness({ status: 'QUARANTINED' });
    const report = await service.run('tenant-1', 'va-1', ACTOR, VIEWER);
    expect(report.steps).toEqual([
      { step: 'SCREENING', status: 'BLOCKED', reasonCode: 'SCREENING_APPROVAL_REQUIRED', ms: null },
    ]);
    expect(videoAssets.validate).not.toHaveBeenCalled();
    expect(detection.detectForAsset).not.toHaveBeenCalled();
    expect(fusion.run).not.toHaveBeenCalled();
    expect(pretrained.evaluate).not.toHaveBeenCalled();
    expect(report.suggestion).toBeNull();
    expect(report.why).toContain('SCREENING_SCREENING_APPROVAL_REQUIRED');
  });

  it('an UPLOADED clip is validated first, then detection → fusion → pretrained with the asset binding', async () => {
    const { service, videoAssets, detection, fusion, pretrained } = buildHarness({ status: 'UPLOADED' });
    const report = await service.run('tenant-1', 'va-1', ACTOR, VIEWER);
    expect(videoAssets.validate).toHaveBeenCalledWith('tenant-1', 'va-1', ACTOR);
    expect(report.steps.map((row) => [row.step, row.status])).toEqual([
      ['SCREENING', 'OK'],
      ['VALIDATE', 'OK'],
      ['DETECTION', 'OK'],
      ['FUSION', 'OK'],
      ['PRETRAINED', 'OK'],
    ]);
    const order = [
      (videoAssets.validate as jest.Mock).mock.invocationCallOrder[0],
      (detection.detectForAsset as jest.Mock).mock.invocationCallOrder[0],
      (fusion.run as jest.Mock).mock.invocationCallOrder[0],
      (pretrained.evaluate as jest.Mock).mock.invocationCallOrder[0],
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The pretrained stage is asked with an EMPTY request: the binding
    // stored on the asset supplies the rack context.
    expect(pretrained.evaluate).toHaveBeenCalledWith('tenant-1', 'va-1', {}, 'u-1', VIEWER);
    expect(report.asset.rackCode).toBe('SHELF-2X2');
    expect(report.suggestion).toEqual({
      sku: 'WATER-BOTTLE-500ML',
      action: 'PICKUP',
      reviewRequired: true,
      notes: ['PRETRAINED_GATE_NOT_APPROVED'],
    });
    expect(report.planogram).toEqual(
      expect.objectContaining({ cell: 'B1', coordinateSource: 'DETECTOR', matchStatus: 'MATCH', bindingSource: 'ASSET' }),
    );
    expect(report.candidates).toEqual({
      scoped: true,
      excludedProductCount: 8,
      items: [
        { sku: 'WATER-BOTTLE-500ML', score: 0.239 },
        { sku: 'SKU-LIME-GREEN', score: 0.218 },
      ],
    });
    expect(report.why).toEqual(
      expect.arrayContaining(['PRODUCT_DETECTED', 'PLANOGRAM_SCOPED_CANDIDATES', 'PRODUCT_COUNT_DECREASED']),
    );
  });

  it('a NO_MOTION_EVENT detection is recorded FAILED and the run continues', async () => {
    const { service, fusion, pretrained } = buildHarness({
      detection: { enabled: true, job: { id: 'job-1', status: 'FAILED', errorCode: 'NO_MOTION_EVENT' }, detection: null },
    });
    const report = await service.run('tenant-1', 'va-1', ACTOR, VIEWER);
    expect(report.steps.find((row) => row.step === 'DETECTION')).toEqual(
      expect.objectContaining({ status: 'FAILED', reasonCode: 'NO_MOTION_EVENT' }),
    );
    expect(fusion.run).toHaveBeenCalled();
    expect(pretrained.evaluate).toHaveBeenCalled();
    expect(report.why).toContain('DETECTION_NO_MOTION_EVENT');
  });

  it('a fusion failure stops before the pretrained stage and never leaks the error text', async () => {
    const { service, pretrained } = buildHarness({
      fusionThrows: new Error('ffmpeg exploded at C:\\tools\\ffmpeg.exe'),
    });
    const report = await service.run('tenant-1', 'va-1', ACTOR, VIEWER);
    expect(report.steps.find((row) => row.step === 'FUSION')).toEqual(
      expect.objectContaining({ status: 'FAILED', reasonCode: 'FUSION_FAILED' }),
    );
    expect(report.steps.some((row) => row.step === 'PRETRAINED')).toBe(false);
    expect(pretrained.evaluate).not.toHaveBeenCalled();
    expect(JSON.stringify(report)).not.toContain('ffmpeg');
  });

  it('never leaks stored junk: no storage key, stderr, or path in the report', async () => {
    const { service } = buildHarness();
    const report = await service.run('tenant-1', 'va-1', ACTOR, VIEWER);
    const json = JSON.stringify(report);
    for (const needle of ['storageKey', 'original.mp4', 'Traceback', 'stderr']) {
      expect(json).not.toContain(needle);
    }
    expect(report.providers).toEqual([
      { provider: 'CLASSICAL', availability: 'READY', reasonCode: null, modelId: null },
      { provider: 'YOLO_LOCAL', availability: 'READY', reasonCode: null, modelId: 'yolov8n-coco' },
    ]);
  });
});

describe('ClipLabService.report (Phase 22, read-only)', () => {
  it('rebuilds the same shape from stored results without running any stage', async () => {
    const { service, videoAssets, detection, fusion, pretrained } = buildHarness();
    const report = await service.report('tenant-1', 'va-1', VIEWER);
    expect(videoAssets.validate).not.toHaveBeenCalled();
    expect(detection.detectForAsset).not.toHaveBeenCalled();
    expect(fusion.run).not.toHaveBeenCalled();
    expect(pretrained.evaluate).not.toHaveBeenCalled();
    expect(pretrained.report).toHaveBeenCalledWith('tenant-1', 'va-1', {}, VIEWER);
    expect(report.steps.map((row) => [row.step, row.status])).toEqual([
      ['SCREENING', 'OK'],
      ['VALIDATE', 'OK'],
      ['DETECTION', 'OK'],
      ['FUSION', 'OK'],
      ['PRETRAINED', 'OK'],
    ]);
    expect(report.candidates.scoped).toBe(true);
  });
});
