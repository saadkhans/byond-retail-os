import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  LocalDetectorResult,
  LocalDetectorRuntimePort,
  LocalDetectorStatus,
  LocalModelDescriptor,
} from '../local-vision-runtime/local-vision-runtime.port';
import { PlanogramService } from '../planogram/planogram.service';
import { PlatformModulesService } from '../platform-modules/platform-modules.service';
import { PrismaService } from '../prisma/prisma.service';
import { PretrainedVisionService } from './pretrained-vision.service';

const TENANT = 'tenant-1';
const OTHER_TENANT = 'tenant-2';
const VIEWER = { hasVideoAssetReadPermission: true };

type Row = Record<string, unknown>;

function fusionEvidence(over: Row = {}): Row {
  return {
    detector: {
      yoloReady: false,
      events: [{ kind: 'PICKUP', startMs: 800, peakMs: 1500, endMs: 2200 }],
    },
    cropArtifactId: 'artifact-auto-1',
    crops: [
      {
        phase: 'peak',
        timestampMs: 1500,
        box: { x: 120, y: 80, width: 160, height: 200 },
        quality: { sharpness: 22, occlusion: 0.08, brightness: 120 },
        selected: true,
      },
    ],
    fused: [{ sku: 'SKU-A', fusedScore: 0.66 }],
    vlm: { invoked: false },
    barcode: { results: [{ value: 'LEAKED-BARCODE' }], matchedSku: null },
    ocr: { rawText: 'LEAKED-OCR-TEXT', normalizedText: 'leaked', status: 'OK' },
    stages: [{ note: 'C:/videos/raw/secret.mp4' }],
    ...over,
  };
}

interface HarnessOptions {
  provider?: string;
  stubMode?: boolean;
  videoIngestModuleEnabled?: boolean;
  asset?: Row | null;
  fusionRun?: Row | null;
  truth?: Row | null;
  correction?: Row | null;
  referenceProducts?: { id: string; sku: string }[];
  /** Catalog products WITHOUT reference images (classical-top lookup). */
  catalogProducts?: { id: string; sku: string }[];
  /** Locations that exist in TENANT (default ['store-1']). */
  tenantLocations?: string[];
  narrowed?: Row | null;
  /** Fake LOCAL detector runtime port bound to the YOLO slot. */
  detectorRuntime?: LocalDetectorRuntimePort;
}

function buildHarness(options: HarnessOptions = {}) {
  const storedRuns: Row[] = [];
  let seq = 0;
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const prisma: any = {
    videoAsset: {
      findFirst: jest.fn(async (args: { where: { tenantId: string } }) =>
        args.where.tenantId === TENANT
          ? (options.asset ?? {
              id: 'va-1',
              width: 1920,
              height: 1080,
              locationId: 'store-1',
            })
          : null,
      ),
    },
    pickupFusionRun: {
      findFirst: jest.fn(async () =>
        options.fusionRun !== undefined
          ? options.fusionRun
          : {
              id: 'fusion-1',
              createdAt: new Date('2026-09-03T09:00:00Z'),
              policy: 'AUTO_PROPOSE',
              evidence: fusionEvidence(),
            },
      ),
    },
    videoGroundTruth: {
      findFirst: jest.fn(async () =>
        options.truth !== undefined
          ? options.truth
          : { eventKind: 'PICKUP', product: { sku: 'SKU-A' } },
      ),
    },
    pilotObservationReview: {
      findFirst: jest.fn(async () => options.correction ?? null),
    },
    location: {
      findFirst: jest.fn(async (args: { where: { tenantId: string; id: string } }) =>
        args.where.tenantId === TENANT &&
        (options.tenantLocations ?? ['store-1']).includes(args.where.id)
          ? { id: args.where.id }
          : null,
      ),
    },
    product: {
      findMany: jest.fn(async () =>
        (options.referenceProducts ?? [
          { id: 'prod-a', sku: 'SKU-A' },
          { id: 'prod-b', sku: 'SKU-B' },
        ]).map((row) => ({ id: row.id, sku: row.sku })),
      ),
      findFirst: jest.fn(async (args: { where: { sku?: string } }) =>
        (options.catalogProducts ?? []).find(
          (row) => row.sku === args.where.sku,
        ) ?? null,
      ),
    },
    pretrainedVisionRun: {
      create: jest.fn(async (args: { data: Row }) => {
        const row = {
          id: `pvr-${(seq += 1)}`,
          createdAt: new Date('2026-09-03T09:05:00Z'),
          ...args.data,
        };
        storedRuns.push(row);
        return row;
      }),
      findMany: jest.fn(async (args: { where: { tenantId: string } }) =>
        args.where.tenantId === TENANT ? [...storedRuns].reverse() : [],
      ),
    },
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const config = {
    get: jest.fn((key: string) =>
      key === 'CV_PRETRAINED_PROVIDER'
        ? (options.provider ?? 'classical')
        : key === 'CV_PRETRAINED_STUB_MODE'
          ? options.stubMode
            ? 'true'
            : 'false'
          : undefined,
    ),
  };
  const platformModules = {
    isEnabledForTenant: jest.fn(
      async () => options.videoIngestModuleEnabled ?? true,
    ),
  };
  const planograms = {
    narrowCandidates: jest.fn(async () => options.narrowed ?? null),
  };
  const service = new PretrainedVisionService(
    prisma as unknown as PrismaService,
    config as unknown as ConfigService,
    platformModules as unknown as PlatformModulesService,
    planograms as unknown as PlanogramService,
    options.detectorRuntime,
  );
  return { service, prisma, planograms, platformModules, storedRuns };
}

// ------------------------------------------------ local runtime fakes

const MODEL: LocalModelDescriptor = {
  modelId: 'yolo-retail-lab-v1',
  task: 'DETECT',
  runtime: 'ULTRALYTICS',
  format: 'PT',
  version: '1',
  inputSize: 640,
  classCount: 3,
  roleClassCounts: { PRODUCT: 1, HAND: 1, PERSON: 1, OBJECT: 0 },
};

function readyStatus(over: Partial<LocalDetectorStatus> = {}): LocalDetectorStatus {
  return {
    availability: 'READY',
    reasonCode: null,
    model: MODEL,
    device: 'CUDA',
    runtimeVersion: '8.3.40',
    ...over,
  };
}

/** Product visible in the first frames, a hand grabs it mid-clip, then
 *  the product is gone — a pickup-shaped timeline over 6 sampled frames. */
function pickupResult(over: Partial<LocalDetectorResult> = {}): LocalDetectorResult {
  const product = {
    role: 'PRODUCT' as const,
    classIndex: 0,
    confidence: 0.82,
    box: { x: 0.4, y: 0.4, width: 0.2, height: 0.25 },
  };
  const hand = {
    role: 'HAND' as const,
    classIndex: 1,
    confidence: 0.7,
    box: { x: 0.45, y: 0.5, width: 0.12, height: 0.12 },
  };
  const person = {
    role: 'PERSON' as const,
    classIndex: 2,
    confidence: 0.9,
    box: { x: 0.1, y: 0.1, width: 0.5, height: 0.8 },
  };
  return {
    status: 'OK',
    reasonCode: null,
    model: MODEL,
    device: 'CUDA',
    analysisDims: { width: 640, height: 360 },
    sampledFps: 2,
    frames: [
      { frameIndex: 0, timestampMs: 0, detections: [product, person] },
      { frameIndex: 1, timestampMs: 500, detections: [product, person] },
      { frameIndex: 2, timestampMs: 1000, detections: [product, hand, person] },
      { frameIndex: 3, timestampMs: 1500, detections: [product, hand, person] },
      { frameIndex: 4, timestampMs: 2000, detections: [hand, person] },
      { frameIndex: 5, timestampMs: 2500, detections: [person] },
    ],
    elapsedMs: 1234,
    ...over,
  };
}

function fakeRuntime(input: {
  status?: LocalDetectorStatus | (() => Promise<LocalDetectorStatus>);
  detect?: LocalDetectorResult | (() => Promise<LocalDetectorResult>);
}): LocalDetectorRuntimePort & { detect: jest.Mock; status: jest.Mock } {
  const status = input.status ?? readyStatus();
  const detect = input.detect ?? pickupResult();
  return {
    status: jest.fn(typeof status === 'function' ? status : async () => status),
    detect: jest.fn(typeof detect === 'function' ? detect : async () => detect),
  };
}

describe('PretrainedVisionService — provider selection', () => {
  it('classical config keeps ONLY the always-ready classical fallback', async () => {
    const { service } = buildHarness({ provider: 'classical' });
    const statuses = await service.providerStatuses();
    expect(statuses.find((s) => s.provider === 'CLASSICAL')?.availability).toBe(
      'READY',
    );
    for (const provider of ['YOLO_LOCAL', 'HAND_SIGNAL_LOCAL', 'EMBEDDING_LOCAL']) {
      expect(
        statuses.find((s) => s.provider === provider)?.availability,
      ).toBe('DISABLED');
    }
  });

  it('enabled slots without local runtimes report UNAVAILABLE, never break', async () => {
    const { service } = buildHarness({ provider: 'hybrid', stubMode: false });
    const statuses = await service.providerStatuses();
    expect(statuses.find((s) => s.provider === 'YOLO_LOCAL')).toMatchObject({
      availability: 'UNAVAILABLE',
      reasonCode: 'LOCAL_RUNTIME_NOT_INSTALLED',
    });
  });

  it('an invalid provider value degrades safely to classical-only', async () => {
    const { service } = buildHarness({ provider: 'bogus-provider' });
    const statuses = await service.providerStatuses();
    expect(statuses.find((s) => s.provider === 'CLASSICAL')?.availability).toBe(
      'READY',
    );
    expect(
      statuses.filter((s) => s.availability === 'DISABLED'),
    ).toHaveLength(3);
  });

  it('stub mode marks enabled slots READY and labels them stubMode', async () => {
    const { service } = buildHarness({ provider: 'hybrid', stubMode: true });
    const yolo = (await service.providerStatuses()).find(
      (s) => s.provider === 'YOLO_LOCAL',
    );
    expect(yolo).toMatchObject({ availability: 'READY', stubMode: true });
  });
});

describe('PretrainedVisionService.evaluate', () => {
  it('enforces the video-asset read boundary (403 without permission)', async () => {
    const { service } = buildHarness();
    await expect(
      service.evaluate(TENANT, 'va-1', {}, 'user-1', {}),
    ).rejects.toThrow(ForbiddenException);
  });

  it('enforces the boundary when the tenant lacks video-ingest', async () => {
    const { service } = buildHarness({ videoIngestModuleEnabled: false });
    await expect(
      service.evaluate(TENANT, 'va-1', {}, 'user-1', VIEWER),
    ).rejects.toThrow(ForbiddenException);
  });

  it('is tenant-isolated: another tenant cannot evaluate this clip', async () => {
    const { service } = buildHarness();
    await expect(
      service.evaluate(OTHER_TENANT, 'va-1', {}, 'user-1', VIEWER),
    ).rejects.toThrow(NotFoundException);
  });

  it('requires the classical baseline (409 without a fusion run)', async () => {
    const { service, storedRuns } = buildHarness({ fusionRun: null });
    await expect(
      service.evaluate(TENANT, 'va-1', {}, 'user-1', VIEWER),
    ).rejects.toThrow(ConflictException);
    expect(storedRuns).toHaveLength(0);
  });

  it('classical fallback works alone: one COMPLETED run, comparison intact', async () => {
    const { service, storedRuns } = buildHarness({ provider: 'classical' });
    const report = await service.evaluate(TENANT, 'va-1', {}, 'user-1', VIEWER);
    expect(storedRuns).toHaveLength(1);
    expect(storedRuns[0]).toMatchObject({
      tenantId: TENANT,
      provider: 'CLASSICAL',
      status: 'COMPLETED',
    });
    expect(report.classical).toMatchObject({
      topSku: 'SKU-A',
      action: 'PICKUP',
    });
    expect(report.groundTruth).toEqual({ eventKind: 'PICKUP', sku: 'SKU-A' });
    expect(report.improvementNotes).toContain('NO_IMPROVEMENT_OVER_CLASSICAL');
  });

  it('an UNAVAILABLE provider records its envelope and never fails the evaluation', async () => {
    const { service, storedRuns } = buildHarness({
      provider: 'hybrid',
      stubMode: false,
    });
    const report = await service.evaluate(TENANT, 'va-1', {}, 'user-1', VIEWER);
    const unavailable = storedRuns.filter(
      (row) => row.status === 'PROVIDER_UNAVAILABLE',
    );
    expect(unavailable.length).toBe(3);
    // The classical baseline still completed.
    expect(report.classical?.topSku).toBe('SKU-A');
    expect(
      report.runs.find((run) => run.provider === 'CLASSICAL')?.status,
    ).toBe('COMPLETED');
  });

  it('hybrid stub mode produces synthetic evidence with tenant-scoped embedding candidates', async () => {
    const { service } = buildHarness({ provider: 'hybrid', stubMode: true });
    const report = await service.evaluate(TENANT, 'va-1', {}, 'user-1', VIEWER);
    const embedding = report.runs.find(
      (run) => run.provider === 'EMBEDDING_LOCAL',
    );
    expect(embedding?.synthetic).toBe(true);
    // Candidates come ONLY from the tenant's reference library.
    for (const candidate of report.embeddingCandidates) {
      expect(['SKU-A', 'SKU-B']).toContain(candidate.sku);
    }
    expect(report.handSignal?.handPresent).toBe(true);
    const yolo = report.runs.find((run) => run.provider === 'YOLO_LOCAL');
    expect(['PICKUP', 'RETURN', 'FALSE_TOUCH', 'UNKNOWN']).toContain(
      yolo?.evidence.features?.actionCandidate,
    );
    expect(yolo?.evidence.notes).toContain('STUB_SYNTHETIC_OUTPUT');
  });

  it('a disabled embedding provider yields a safe unavailable/empty state', async () => {
    const { service } = buildHarness({ provider: 'classical' });
    const report = await service.evaluate(TENANT, 'va-1', {}, 'user-1', VIEWER);
    expect(report.embeddingCandidates).toEqual([]);
    expect(
      report.providers.find((s) => s.provider === 'EMBEDDING_LOCAL')
        ?.availability,
    ).toBe('DISABLED');
  });

  it('never leaks paths, raw OCR/barcode text, media, or model internals', async () => {
    const { service, storedRuns } = buildHarness({
      provider: 'hybrid',
      stubMode: true,
    });
    const report = await service.evaluate(TENANT, 'va-1', {}, 'user-1', VIEWER);
    const serialized = JSON.stringify({ report, storedRuns });
    for (const needle of [
      'LEAKED-OCR-TEXT',
      'LEAKED-BARCODE',
      'secret.mp4',
      'C:/videos',
      'rtsp:',
      'storageKey',
    ]) {
      expect(serialized).not.toContain(needle);
    }
  });

  it('preserves ground truth and operator correction without overwriting them', async () => {
    const { service, prisma } = buildHarness({
      correction: {
        verdict: 'WRONG_SKU',
        expectedAction: 'PICKUP',
        expectedSku: 'SKU-B',
      },
    });
    const report = await service.evaluate(TENANT, 'va-1', {}, 'user-1', VIEWER);
    expect(report.operatorCorrection).toEqual({
      verdict: 'WRONG_SKU',
      expectedAction: 'PICKUP',
      expectedSku: 'SKU-B',
    });
    // Pretrained evaluation only ever WRITES its own run table — reviews
    // and ground truth are read-only here.
    expect(prisma.pretrainedVisionRun.create).toHaveBeenCalled();
    expect(prisma.videoGroundTruth.findFirst).toHaveBeenCalled();
  });
});

describe('PretrainedVisionService — planogram integration', () => {
  const narrowedFixture = {
    rackId: 'rack-1',
    rackCode: 'R1',
    version: 3,
    cell: { rowIndex: 1, columnIndex: 2, cellCode: 'B3', confidence: 1 },
    matchableCell: true,
    cellSkus: ['SKU-B'],
    adjacentSkus: ['SKU-C'],
    rackSkus: ['SKU-B', 'SKU-C', 'SKU-D'],
    usedRackFallback: false,
  };

  it('narrows SKU candidates with the planogram as a SOFT prior', async () => {
    const { service, planograms } = buildHarness({
      narrowed: narrowedFixture,
    });
    const report = await service.evaluate(
      TENANT,
      'va-1',
      { locationId: 'store-1', rackCode: 'R1', normalizedRackX: 0.62, normalizedRackY: 0.38 },
      'user-1',
      VIEWER,
    );
    expect(planograms.narrowCandidates).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ locationId: 'store-1', rackCode: 'R1' }),
    );
    expect(report.planogram.configured).toBe(true);
    expect(report.planogram.version).toBe(3);
    expect(report.planogram.planogramCandidateSkus).toEqual(['SKU-B']);
    // Visual top (SKU-A) is OUTSIDE the confident cell's expectation:
    // review, never rejection — the visual SKU stays the top candidate.
    expect(report.planogram.planogramMatchStatus).toBe('OUT_OF_PLANOGRAM');
    expect(report.planogram.reviewRequired).toBe(true);
    expect(report.fusionSuggestion.reviewRequired).toBe(true);
    expect(report.fusionSuggestion.sku).toBe('SKU-A');
    // The stored run records the planogram VERSION it was scored against.
  });

  it('records the planogram version on every stored run (version safety)', async () => {
    const { service, storedRuns } = buildHarness({ narrowed: narrowedFixture });
    await service.evaluate(
      TENANT,
      'va-1',
      { locationId: 'store-1', rackCode: 'R1' },
      'user-1',
      VIEWER,
    );
    expect(storedRuns[0]).toMatchObject({
      planogramRackId: 'rack-1',
      planogramVersion: 3,
    });
  });

  it('reports PLANOGRAM_NOT_CONFIGURED without blocking anything', async () => {
    const { service } = buildHarness({ narrowed: null });
    const report = await service.evaluate(
      TENANT,
      'va-1',
      { locationId: 'store-1', rackCode: 'R1' },
      'user-1',
      VIEWER,
    );
    expect(report.planogram.configured).toBe(false);
    expect(report.planogram.planogramMatchStatus).toBe(
      'PLANOGRAM_NOT_CONFIGURED',
    );
    expect(report.classical?.topSku).toBe('SKU-A');
  });
});

describe('PretrainedVisionService.report', () => {
  it('rebuilds the comparison from the latest stored runs (read-only)', async () => {
    const { service, prisma } = buildHarness({ provider: 'classical' });
    await service.evaluate(TENANT, 'va-1', {}, 'user-1', VIEWER);
    (prisma.pretrainedVisionRun.create as jest.Mock).mockClear();
    const report = await service.report(TENANT, 'va-1', {}, VIEWER);
    expect(report.runs.length).toBe(1);
    expect(prisma.pretrainedVisionRun.create).not.toHaveBeenCalled();
  });

  it('is tenant-isolated: tenant B reads none of tenant A evidence', async () => {
    const { service } = buildHarness();
    await service.evaluate(TENANT, 'va-1', {}, 'user-1', VIEWER);
    await expect(
      service.report(OTHER_TENANT, 'va-1', {}, VIEWER),
    ).rejects.toThrow(NotFoundException);
  });
});

describe('PretrainedVisionService — planogram store binding (P1)', () => {
  it('rejects a planogram location that differs from the clip store, with NO side effects', async () => {
    const { service, storedRuns, planograms } = buildHarness();
    await expect(
      service.evaluate(
        TENANT,
        'va-1',
        { locationId: 'store-2', rackCode: 'R1' },
        'user-1',
        VIEWER,
      ),
    ).rejects.toThrow(/own store/);
    expect(storedRuns).toHaveLength(0);
    expect(planograms.narrowCandidates).not.toHaveBeenCalled();
  });

  it('uses the clip store when locationId is omitted', async () => {
    const { service, planograms } = buildHarness({
      narrowed: {
        rackId: 'rack-1',
        rackCode: 'R1',
        version: 1,
        cell: null,
        matchableCell: false,
        cellSkus: [],
        adjacentSkus: [],
        rackSkus: [],
        usedRackFallback: true,
      },
    });
    await service.evaluate(TENANT, 'va-1', { rackCode: 'R1' }, 'user-1', VIEWER);
    expect(planograms.narrowCandidates).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ locationId: 'store-1' }),
    );
  });

  it('accepts an explicit locationId that MATCHES the clip store', async () => {
    const { service } = buildHarness();
    const report = await service.evaluate(
      TENANT,
      'va-1',
      { locationId: 'store-1', rackCode: 'R1' },
      'user-1',
      VIEWER,
    );
    expect(report.classical?.topSku).toBe('SKU-A');
  });

  it('a store-less clip may use an explicit TENANT-validated location only', async () => {
    const storelessAsset = {
      id: 'va-1',
      width: 1920,
      height: 1080,
      locationId: null,
    };
    const ok = buildHarness({
      asset: storelessAsset,
      tenantLocations: ['store-9'],
    });
    await ok.service.evaluate(
      TENANT,
      'va-1',
      { locationId: 'store-9', rackCode: 'R1' },
      'user-1',
      VIEWER,
    );
    expect(ok.prisma.location.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: TENANT, id: 'store-9' }),
      }),
    );

    const foreign = buildHarness({
      asset: storelessAsset,
      tenantLocations: [],
    });
    await expect(
      foreign.service.evaluate(
        TENANT,
        'va-1',
        { locationId: 'store-of-tenant-b', rackCode: 'R1' },
        'user-1',
        VIEWER,
      ),
    ).rejects.toThrow(NotFoundException);
    expect(foreign.storedRuns).toHaveLength(0);
  });
});

describe('PretrainedVisionService — scored planogram immutability (P1)', () => {
  const narrowedV1 = {
    rackId: 'rack-1',
    rackCode: 'R1',
    version: 1,
    cell: { rowIndex: 1, columnIndex: 2, cellCode: 'B3', confidence: 1 },
    matchableCell: true,
    cellSkus: ['SKU-B'],
    adjacentSkus: [],
    rackSkus: ['SKU-B'],
    usedRackFallback: false,
  };

  it('report shows the STORED scored snapshot even after the planogram changes', async () => {
    const { service, planograms } = buildHarness({ narrowed: narrowedV1 });
    const evaluated = await service.evaluate(
      TENANT,
      'va-1',
      {
        locationId: 'store-1',
        rackCode: 'R1',
        normalizedRackX: 0.62,
        normalizedRackY: 0.38,
      },
      'user-1',
      VIEWER,
    );
    expect(evaluated.planogram.version).toBe(1);
    expect(evaluated.planogram.source).toBe('SCORED_AT_EVALUATION');

    // The planogram is re-published as version 2 with DIFFERENT cells.
    (planograms.narrowCandidates as jest.Mock).mockResolvedValue({
      ...narrowedV1,
      version: 2,
      cellSkus: ['SKU-TOTALLY-DIFFERENT'],
    });
    (planograms.narrowCandidates as jest.Mock).mockClear();

    const report = await service.report(TENANT, 'va-1', {}, VIEWER);
    // The OLD run's scored evidence is immutable: version 1, original
    // candidates/status, and the live planogram was never consulted.
    expect(report.planogram.source).toBe('SCORED_AT_EVALUATION');
    expect(report.planogram.version).toBe(1);
    expect(report.planogram.planogramCandidateSkus).toEqual(['SKU-B']);
    expect(report.planogram.planogramMatchStatus).toBe(
      evaluated.planogram.planogramMatchStatus,
    );
    expect(planograms.narrowCandidates).not.toHaveBeenCalled();
  });

  it('labels a live section CURRENT_ACTIVE only when NO stored snapshot exists', async () => {
    const { service } = buildHarness({ narrowed: narrowedV1 });
    // No evaluate ran — report computes live and says so.
    const report = await service.report(
      TENANT,
      'va-1',
      { locationId: 'store-1', rackCode: 'R1' },
      VIEWER,
    );
    expect(report.planogram.source).toBe('CURRENT_ACTIVE');
  });
});

describe('PretrainedVisionService — candidate scope (P1, no blind cap)', () => {
  it('queries the reference library WITHOUT a take limit', async () => {
    const { service, prisma } = buildHarness({
      provider: 'hybrid',
      stubMode: true,
    });
    await service.evaluate(TENANT, 'va-1', {}, 'user-1', VIEWER);
    expect(prisma.product.findMany).toHaveBeenCalledWith(
      expect.not.objectContaining({ take: expect.anything() }),
    );
  });

  it('ranks a late-alphabet planogram SKU that a 50-cap would have dropped', async () => {
    // 60 reference products; the planogram cell expects the LAST one.
    const referenceProducts = Array.from({ length: 60 }, (_, i) => ({
      id: `prod-${String(i).padStart(2, '0')}`,
      sku: `SKU-${String(i).padStart(2, '0')}`,
    }));
    const { service } = buildHarness({
      provider: 'embeddings_local',
      stubMode: true,
      referenceProducts,
      narrowed: {
        rackId: 'rack-1',
        rackCode: 'R1',
        version: 1,
        cell: { rowIndex: 0, columnIndex: 0, cellCode: 'A1', confidence: 1 },
        matchableCell: true,
        cellSkus: ['SKU-59'],
        adjacentSkus: [],
        rackSkus: ['SKU-59'],
        usedRackFallback: false,
      },
    });
    const report = await service.evaluate(
      TENANT,
      'va-1',
      {
        locationId: 'store-1',
        rackCode: 'R1',
        normalizedRackX: 0.1,
        normalizedRackY: 0.1,
      },
      'user-1',
      VIEWER,
    );
    // SKU-59 (beyond any first-50 alphabetical window) is scoreable and
    // the planogram prior surfaces it among the boosted candidates.
    expect(
      report.planogram.candidates.some((row) => row.sku === 'SKU-59'),
    ).toBe(true);
    // Output stays bounded after ranking.
    expect(report.embeddingCandidates.length).toBeLessThanOrEqual(10);
    expect(report.planogram.candidates.length).toBeLessThanOrEqual(10);
  });

  it('includes the classical top SKU even when it has no reference images', async () => {
    const { service } = buildHarness({
      provider: 'embeddings_local',
      stubMode: true,
      // Reference library does NOT contain SKU-A (the classical top)...
      referenceProducts: [{ id: 'prod-z', sku: 'SKU-Z' }],
      // ...but the tenant catalog does.
      catalogProducts: [{ id: 'prod-a', sku: 'SKU-A' }],
    });
    const report = await service.evaluate(TENANT, 'va-1', {}, 'user-1', VIEWER);
    const skus = report.embeddingCandidates.map((row) => row.sku);
    expect(skus).toContain('SKU-A');
  });
});

describe('PretrainedVisionService — real local detector runtime (Phase 20)', () => {
  it('runtime UNAVAILABLE (runtime not installed) → YOLO row PROVIDER_UNAVAILABLE, classical still completes', async () => {
    const runtime = fakeRuntime({
      status: readyStatus({
        availability: 'UNAVAILABLE',
        reasonCode: 'LOCAL_RUNTIME_NOT_INSTALLED',
        model: null,
        device: null,
      }),
      detect: {
        ...pickupResult(),
        status: 'UNAVAILABLE',
        reasonCode: 'LOCAL_RUNTIME_NOT_INSTALLED',
        frames: [],
        model: null,
      },
    });
    const { service, storedRuns } = buildHarness({
      provider: 'yolo_local',
      detectorRuntime: runtime,
    });
    const statuses = await service.providerStatuses();
    expect(statuses.find((s) => s.provider === 'YOLO_LOCAL')).toMatchObject({
      availability: 'UNAVAILABLE',
      reasonCode: 'LOCAL_RUNTIME_NOT_INSTALLED',
      stubMode: false,
      runtime: null,
    });
    const report = await service.evaluate(TENANT, 'va-1', {}, 'user-1', VIEWER);
    expect(storedRuns.find((row) => row.provider === 'YOLO_LOCAL')).toMatchObject({
      status: 'PROVIDER_UNAVAILABLE',
    });
    expect(storedRuns.find((row) => row.provider === 'CLASSICAL')).toMatchObject({
      status: 'COMPLETED',
    });
    expect(report.classical?.topSku).toBe('SKU-A');
    expect(
      report.runs.find((run) => run.provider === 'YOLO_LOCAL')?.evidence.reasonCode,
    ).toBe('LOCAL_RUNTIME_NOT_INSTALLED');
  });

  it('runtime reporting MODEL_NOT_FOUND surfaces the classified code only', async () => {
    const runtime = fakeRuntime({
      status: readyStatus({
        availability: 'UNAVAILABLE',
        reasonCode: 'MODEL_NOT_FOUND',
        model: null,
        device: null,
      }),
      detect: {
        ...pickupResult(),
        status: 'UNAVAILABLE',
        reasonCode: 'MODEL_NOT_FOUND',
        frames: [],
        model: null,
      },
    });
    const { service, storedRuns } = buildHarness({
      provider: 'yolo_local',
      detectorRuntime: runtime,
    });
    await service.evaluate(TENANT, 'va-1', {}, 'user-1', VIEWER);
    const yolo = storedRuns.find((row) => row.provider === 'YOLO_LOCAL') as Row;
    expect(yolo.status).toBe('PROVIDER_UNAVAILABLE');
    expect((yolo.evidence as Row).reasonCode).toBe('MODEL_NOT_FOUND');
  });

  it('a rejecting runtime → FAILED + ADAPTER_ERROR, no message leaks, classical unaffected', async () => {
    const runtime = fakeRuntime({
      detect: async () => {
        throw new Error(
          'python C:/tools/python.exe exited: Traceback (most recent call last) C:/models/x.pt',
        );
      },
    });
    const { service, storedRuns } = buildHarness({
      provider: 'yolo_local',
      detectorRuntime: runtime,
    });
    const report = await service.evaluate(TENANT, 'va-1', {}, 'user-1', VIEWER);
    const yolo = storedRuns.find((row) => row.provider === 'YOLO_LOCAL') as Row;
    expect(yolo.status).toBe('FAILED');
    expect((yolo.evidence as Row).reasonCode).toBe('ADAPTER_ERROR');
    expect(
      report.runs.find((run) => run.provider === 'CLASSICAL')?.status,
    ).toBe('COMPLETED');
    const serialized = JSON.stringify({ report, storedRuns });
    for (const needle of ['Traceback', 'python', 'C:/', '.pt']) {
      expect(serialized).not.toContain(needle);
    }
  });

  it('a rejecting status probe → UNAVAILABLE / LOCAL_RUNTIME_PROBE_FAILED', async () => {
    const runtime = fakeRuntime({
      status: async () => {
        throw new Error('spawn ENOENT /usr/bin/python3');
      },
    });
    const { service } = buildHarness({
      provider: 'yolo_local',
      detectorRuntime: runtime,
    });
    const yolo = (await service.providerStatuses()).find(
      (s) => s.provider === 'YOLO_LOCAL',
    );
    expect(yolo).toMatchObject({
      availability: 'UNAVAILABLE',
      reasonCode: 'LOCAL_RUNTIME_PROBE_FAILED',
      runtime: null,
    });
    expect(JSON.stringify(yolo)).not.toContain('python');
  });

  it('runtime OK → COMPLETED real evidence: PRODUCT_IN_HAND, hand signal, forced review, improvement notes', async () => {
    const runtime = fakeRuntime({});
    const { service, storedRuns } = buildHarness({
      provider: 'yolo_local',
      detectorRuntime: runtime,
    });
    const report = await service.evaluate(TENANT, 'va-1', {}, 'user-1', VIEWER);
    expect(runtime.detect).toHaveBeenCalledWith({
      tenantId: TENANT,
      videoAssetId: 'va-1',
    });

    const yoloRow = storedRuns.find((row) => row.provider === 'YOLO_LOCAL') as Row;
    expect(yoloRow.status).toBe('COMPLETED');
    const yolo = report.runs.find((run) => run.provider === 'YOLO_LOCAL');
    expect(yolo?.synthetic).toBe(false);
    expect(yolo?.evidence.availability).toBe('READY');
    expect(yolo?.evidence.reasonCode).toBeNull();
    const labels = yolo?.evidence.detections.map((row) => row.label) ?? [];
    expect(labels).toContain('PRODUCT');
    expect(labels).toContain('PRODUCT_IN_HAND');
    expect(labels).toContain('HAND');
    expect(yolo?.evidence.handSignal).toMatchObject({
      handPresent: true,
      contactStartMs: 1000,
      contactEndMs: 1500,
      contactDurationMs: 500,
      enteredZoneAtMs: 1000,
      leftZoneAtMs: 2000,
    });
    // Product present early, gone late → disappeared → PICKUP candidate.
    expect(yolo?.evidence.features).toMatchObject({
      objectDisappeared: true,
      objectAppeared: false,
      actionCandidate: 'PICKUP',
    });
    expect(yolo?.evidence.notes).toEqual(
      expect.arrayContaining([
        'LOCAL_DETECTOR_OUTPUT',
        'PRODUCT_DETECTED',
        'PRODUCT_IN_HAND_DETECTED',
        'HAND_DETECTED_BY_DETECTOR',
        'PERSON_DETECTED',
      ]),
    );
    expect(yolo?.evidence.notes).not.toContain('STUB_SYNTHETIC_OUTPUT');

    // Review gate: real pretrained output is advisory — always review.
    expect(report.fusionSuggestion.reviewRequired).toBe(true);
    expect(report.fusionSuggestion.notes).toContain('PRETRAINED_GATE_NOT_APPROVED');
    expect(report.fusionSuggestion.notes).toContain('STILL_NEEDS_REVIEW');
    expect(report.improvementNotes).toEqual(
      expect.arrayContaining([
        'PRODUCT_DETECTED',
        'DETECTION_COVERAGE_IMPROVED',
        'HAND_CONTACT_OBSERVED',
        'STILL_NEEDS_REVIEW',
      ]),
    );
    expect(report.improvementNotes).not.toContain('NO_IMPROVEMENT_OVER_CLASSICAL');

    // The classical fallback is untouched and never replaced.
    expect(report.classical).toMatchObject({ topSku: 'SKU-A', action: 'PICKUP' });
    const classical = report.runs.find((run) => run.provider === 'CLASSICAL');
    expect(classical?.status).toBe('COMPLETED');
    expect(classical?.evidence.synthetic).toBe(false);
    expect(report.embeddingCandidates).toEqual([]);
  });

  it('never leaks runtime internals even when the runtime result carries junk fields', async () => {
    const junk = {
      ...pickupResult(),
      internalModelFile: 'C:\\models\\x.pt',
      stderr: 'Traceback (most recent call last): python worker crashed',
      argv: ['python', 'ml/models/worker.py'],
      model: { ...MODEL, location: 'C:\\models\\yolo\\weights.pt' },
    } as unknown as LocalDetectorResult;
    const runtime = fakeRuntime({
      status: {
        ...readyStatus(),
        interpreter: 'C:\\Python312\\python.exe',
      } as unknown as LocalDetectorStatus,
      detect: junk,
    });
    const { service, storedRuns } = buildHarness({
      provider: 'yolo_local',
      detectorRuntime: runtime,
    });
    const report = await service.evaluate(TENANT, 'va-1', {}, 'user-1', VIEWER);
    const serialized = JSON.stringify({
      report,
      storedRuns,
      statuses: await service.providerStatuses(),
    });
    for (const needle of [
      'C:\\',
      '.pt',
      'Traceback',
      'python',
      'ml/models',
      'weights',
      'interpreter',
      'argv',
      'stderr',
      'location',
    ]) {
      expect(serialized).not.toContain(needle);
    }
    const persistedEvidence = (
      storedRuns.find((row) => row.provider === 'YOLO_LOCAL') as Row
    ).evidence as Row;
    expect(Object.keys(persistedEvidence).sort()).toEqual(
      [
        'availability',
        'detections',
        'embeddingCandidates',
        'features',
        'handSignal',
        'notes',
        'provider',
        'reasonCode',
        'synthetic',
      ].sort(),
    );
  });

  it('providers listing shows the opaque runtime model id when READY and null otherwise', async () => {
    const ready = fakeRuntime({});
    const { service } = buildHarness({
      provider: 'yolo_local',
      detectorRuntime: ready,
    });
    const statuses = await service.providerStatuses();
    expect(statuses.find((s) => s.provider === 'YOLO_LOCAL')).toMatchObject({
      availability: 'READY',
      reasonCode: null,
      stubMode: false,
      runtime: {
        modelId: 'yolo-retail-lab-v1',
        runtimeKind: 'ULTRALYTICS',
        format: 'PT',
        version: '1',
        device: 'CUDA',
      },
    });
    expect(statuses.find((s) => s.provider === 'CLASSICAL')?.runtime).toBeNull();

    const unavailable = fakeRuntime({
      status: readyStatus({
        availability: 'UNAVAILABLE',
        reasonCode: 'MODEL_NOT_CONFIGURED',
        model: null,
        device: null,
      }),
    });
    const { service: service2 } = buildHarness({
      provider: 'yolo_local',
      detectorRuntime: unavailable,
    });
    expect(
      (await service2.providerStatuses()).find((s) => s.provider === 'YOLO_LOCAL')
        ?.runtime,
    ).toBeNull();
  });

  it('a runtime descriptor with a path-shaped field drops the whole runtime block', async () => {
    const runtime = fakeRuntime({
      status: readyStatus({ model: { ...MODEL, version: 'C:/models/v1' } }),
    });
    const { service } = buildHarness({
      provider: 'yolo_local',
      detectorRuntime: runtime,
    });
    const yolo = (await service.providerStatuses()).find(
      (s) => s.provider === 'YOLO_LOCAL',
    );
    expect(yolo?.availability).toBe('READY');
    expect(yolo?.runtime).toBeNull();
  });

  it('stub mode wins over a bound runtime (synthetic, runtime never called)', async () => {
    const runtime = fakeRuntime({});
    const { service } = buildHarness({
      provider: 'yolo_local',
      stubMode: true,
      detectorRuntime: runtime,
    });
    const yolo = (await service.providerStatuses()).find(
      (s) => s.provider === 'YOLO_LOCAL',
    );
    expect(yolo).toMatchObject({ availability: 'READY', stubMode: true, runtime: null });
    const report = await service.evaluate(TENANT, 'va-1', {}, 'user-1', VIEWER);
    const run = report.runs.find((row) => row.provider === 'YOLO_LOCAL');
    expect(run?.synthetic).toBe(true);
    expect(run?.evidence.notes).toContain('STUB_SYNTHETIC_OUTPUT');
    expect(runtime.detect).not.toHaveBeenCalled();
    expect(runtime.status).not.toHaveBeenCalled();
    // Synthetic evidence does not trip the real-evidence review gate.
    expect(report.fusionSuggestion.notes).not.toContain('PRETRAINED_GATE_NOT_APPROVED');
  });

  it('a disabled detector slot never touches the bound runtime', async () => {
    const runtime = fakeRuntime({});
    const { service, storedRuns } = buildHarness({
      provider: 'classical',
      detectorRuntime: runtime,
    });
    await service.evaluate(TENANT, 'va-1', {}, 'user-1', VIEWER);
    expect(runtime.detect).not.toHaveBeenCalled();
    expect(runtime.status).not.toHaveBeenCalled();
    expect(storedRuns.map((row) => row.provider)).toEqual(['CLASSICAL']);
  });

  it('report() rebuilds real evidence from the stored row with the same review gate', async () => {
    const runtime = fakeRuntime({});
    const { service } = buildHarness({
      provider: 'yolo_local',
      detectorRuntime: runtime,
    });
    await service.evaluate(TENANT, 'va-1', {}, 'user-1', VIEWER);
    const report = await service.report(TENANT, 'va-1', {}, VIEWER);
    const yolo = report.runs.find((run) => run.provider === 'YOLO_LOCAL');
    expect(yolo?.synthetic).toBe(false);
    expect(
      yolo?.evidence.detections.some((row) => row.label === 'PRODUCT_IN_HAND'),
    ).toBe(true);
    expect(report.fusionSuggestion.reviewRequired).toBe(true);
    expect(report.fusionSuggestion.notes).toContain('PRETRAINED_GATE_NOT_APPROVED');
    expect(runtime.detect).toHaveBeenCalledTimes(1);
  });
});
