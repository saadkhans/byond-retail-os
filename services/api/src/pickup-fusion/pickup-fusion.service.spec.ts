import { ConfigService } from '@nestjs/config';
import { FusionPolicyResult, ProductStatus, VideoAssetStatus } from '@prisma/client';
import { WeightedCandidateFusion } from './adapters/context-fusion-inventory';
import {
  BARCODE_VALUE_SUPPRESSED,
  FUSION_PIPELINE_VERSION,
  FusionEvidence,
  OCR_TEXT_SUPPRESSED,
  PickupFusionService,
  applyVlmVerdictToEvidence,
} from './pickup-fusion.service';
import { CandidateSignal, VlmVerdict } from './ports';

/**
 * Two persistence-boundary guarantees of the fusion service:
 *
 * 1. PAYMENT-SAFETY — response-derived text (rawPreview, errorDetail,
 *    parser messages, HTTP body previews) never reaches the persisted
 *    PickupFusionRun evidence or the policy reason. A malformed
 *    completion can echo OCR/frame content, which may contain a PAN/CVV;
 *    only classified codes may travel.
 *
 * 2. ACTIVE-ONLY CANDIDATES — the fusion catalog is constrained to
 *    ACTIVE products, so a DRAFT/DISCONTINUED/ARCHIVED product with a
 *    barcode and strong signals can never become a candidate or reach
 *    AUTO_PROPOSE (the retrieval-side filter is pinned in
 *    adapters/visual-signals.spec.ts).
 *
 * 3. FRAME-DERIVED TEXT SCREEN — OCR text recovered from the zoomed
 *    event crop and unmatched barcode/QR decode payloads pass the shared
 *    containsSensitiveFreeText predicate before persistence; on a trip
 *    only a classified marker persists and the text reaches neither the
 *    evidence row nor the VLM request.
 */

/** A 16-digit PAN-looking string the model might echo from OCR/frames. */
const PAN = '4111111111111111';

function emptyEvidence(): FusionEvidence {
  return {
    pipelineVersion: FUSION_PIPELINE_VERSION,
    stages: [],
    detector: { adapterKey: 'stub', warnings: [], events: [], tracks: [], yoloReady: false },
    crops: [],
    cropArtifactId: null,
    barcode: { results: [], matchedSku: null },
    ocr: { rawText: '', normalizedText: '', languages: [], perProduct: [] },
    retrieval: { modelKey: 'stub', modelVersion: '1', indexed: 0, candidates: [] },
    classical: { candidates: [] },
    context: { candidates: [] },
    fused: [],
    inventoryValidation: [],
    vlm: {
      invoked: true,
      reason: 'test',
      provider: 'local',
      mode: 'UNCERTAIN_ONLY',
      status: null,
      verdict: null,
      selectedSku: null,
      visualSupport: null,
      ocrSupport: null,
      barcodeSupport: null,
      reasonCodes: [],
      contradictions: [],
      requiresHumanReview: null,
      modelKey: null,
      latencyMs: null,
    },
    policy: { result: FusionPolicyResult.FAILED, reason: 'not-run' },
    shadow: { classicalV1: null, groundTruth: null, v1Verdict: null, v2Verdict: null },
  };
}

describe('applyVlmVerdictToEvidence (payment-safe persistence boundary)', () => {
  it('classified failures persist the status code only — never errorDetail/rawPreview text', () => {
    const statuses: VlmVerdict['status'][] = [
      'MALFORMED_RESPONSE',
      'PROVIDER_ERROR',
      'INVALID_JSON',
    ];
    for (const status of statuses) {
      const evidence = emptyEvidence();
      const verdict: VlmVerdict = {
        status,
        result: null,
        modelKey: 'test-vision:7b',
        modelVersion: 'test-vision:7b',
        latencyMs: 42,
        // Response-derived text a provider/parser can produce: an error
        // body or parse message echoing frame/OCR content with a PAN+CVV.
        errorDetail: `HTTP 400: label read "${PAN}" cvv 987 exceeds context`,
        rawPreview: `The card in frame shows ${PAN} security code 987`,
      };
      applyVlmVerdictToEvidence(evidence, verdict, 'NEEDS_VLM', 'SKU-A', 'routed to review');

      // Classified failure still routes to review, reason from the enum only.
      expect(evidence.policy).toEqual({
        result: FusionPolicyResult.NEEDS_HUMAN_REVIEW,
        reason: `VLM ${status} — routed to review`,
      });
      expect(evidence.vlm.status).toBe(status);
      expect(evidence.vlm.modelKey).toBe('test-vision:7b');
      expect(evidence.vlm.latencyMs).toBe(42);
      // The exact JSON that would be persisted carries no response text.
      const persisted = JSON.stringify(evidence);
      expect(persisted).not.toContain(PAN);
      expect(persisted).not.toContain('987');
      expect(persisted).not.toContain('errorDetail');
      expect(persisted).not.toContain('rawPreview');
    }
  });

  it('a VERDICT persists whitelist-validated fields only — the raw completion preview never travels', () => {
    const evidence = emptyEvidence();
    const verdict: VlmVerdict = {
      status: 'VERDICT',
      result: {
        verdict: 'MATCH',
        selectedSku: 'SKU-A',
        visualSupport: 'STRONG',
        ocrSupport: 'MEDIUM',
        barcodeSupport: 'NONE',
        reasonCodes: ['REFERENCE_VISUAL_MATCH'],
        contradictions: [],
        requiresHumanReview: false,
      },
      modelKey: 'test-vision:7b',
      modelVersion: 'test-vision:7b',
      latencyMs: 10,
      errorDetail: null,
      // The success path ALSO carries a raw completion preview in memory.
      rawPreview: `{"verdict":"MATCH"} ... and the label read ${PAN}`,
    };
    applyVlmVerdictToEvidence(evidence, verdict, 'NEEDS_VLM', 'SKU-A', 'routed to review');

    expect(evidence.policy.result).toBe(FusionPolicyResult.AUTO_PROPOSE);
    expect(evidence.vlm.verdict).toBe('MATCH');
    expect(evidence.vlm.selectedSku).toBe('SKU-A');
    expect(evidence.vlm.reasonCodes).toEqual(['REFERENCE_VISUAL_MATCH']);
    const persisted = JSON.stringify(evidence);
    expect(persisted).not.toContain(PAN);
    expect(persisted).not.toContain('rawPreview');
    expect(persisted).not.toContain('errorDetail');
  });
});

// --------------------------------------------------------------------
// ACTIVE-only fusion catalog (service-level regression)
// --------------------------------------------------------------------

interface CatalogFixture {
  id: string;
  sku: string;
  name: string;
  status: ProductStatus;
  barcode: string;
}

function buildService(options: {
  catalog: CatalogFixture[];
  barcodeSeen: string;
  classicalSignals: CandidateSignal[];
  barcodeFormat?: string;
  ocrSeen?: { rawText: string; normalizedText: string };
  config?: Record<string, string>;
  vlmVerify?: jest.Mock;
}) {
  const createdRuns: { data: { policy: FusionPolicyResult; fusedTopSku: string | null; evidence: FusionEvidence } }[] = [];
  // Behaves like the DB: honors the status filter the service sends.
  const productFindMany = jest.fn(
    async (args: { where: { status?: ProductStatus } }) =>
      options.catalog
        .filter((row) => args.where.status === undefined || row.status === args.where.status)
        .map((row) => ({
          id: row.id,
          sku: row.sku,
          name: row.name,
          nameArabic: null,
          aliases: [] as string[],
          description: null,
          barcodes: [{ value: row.barcode }],
        })),
  );
  const prisma = {
    product: { findMany: productFindMany },
    pickupFusionRun: {
      count: jest.fn(async () => 0),
      create: jest.fn(async (args: (typeof createdRuns)[number]) => {
        createdRuns.push(args);
        return { id: 'run-1' };
      }),
    },
    inferenceJob: { findFirst: jest.fn(async () => null) },
    videoGroundTruth: { findFirst: jest.fn(async () => null) },
    productReferenceImage: { findMany: jest.fn(async () => []) },
  };
  const asset = {
    deletedAt: null,
    status: VideoAssetStatus.VALIDATED,
    durationMs: 6000,
    width: 480,
    height: 360,
    fps: 30,
    storageKey: 'assets/clip.mp4',
    locationId: null,
    unitId: null,
    deviceId: null,
  };
  const decoder = {
    // Frames sized to whatever geometry the service asks for; flat gray.
    decodeAnalysisFrames: jest.fn(
      async (_path: string, _fps: number, geometry: { width: number; height: number }) =>
        Array.from({ length: 5 }, (_unused, index) => ({
          index,
          timestampMs: index * 1000,
          rgb: Buffer.alloc(geometry.width * geometry.height * 3, 100),
        })),
    ),
    decodeReferenceImage: jest.fn(),
  };
  const detector = {
    adapterKey: 'stub-detector',
    version: '1.0.0',
    detect: jest.fn(async () => ({
      events: [
        {
          kind: 'PICKUP' as const,
          startMs: 1500,
          peakMs: 2000,
          endMs: 2500,
          trackId: 't1',
          shelfZoneId: 'z-1-1',
          box: { x: 4, y: 4, width: 12, height: 12 },
        },
      ],
      tracks: [],
      warnings: [],
    })),
  };
  const service = new PickupFusionService(
    prisma as never,
    { findByIdInternal: jest.fn(async () => asset) } as never,
    { createCrop: jest.fn(async () => ({ artifact: { id: 'crop-1' } })) } as never,
    { internalPathFor: (key: string) => key } as never,
    decoder as never,
    { analysisWidth: 48, analysisFps: 2 } as never,
    detector as never,
    { checkReady: jest.fn(async () => false) } as never,
    {
      adapterKey: 'stub-barcode',
      version: '1.0.0',
      read: jest.fn(async () => [
        {
          value: options.barcodeSeen,
          format: options.barcodeFormat ?? 'EAN_13',
          timestampMs: 0,
        },
      ]),
    } as never,
    {
      adapterKey: 'stub-ocr',
      version: '1.0.0',
      recognize: jest.fn(async () => ({
        rawText: options.ocrSeen?.rawText ?? '',
        normalizedText: options.ocrSeen?.normalizedText ?? '',
        languages: options.ocrSeen ? ['eng'] : [],
      })),
    } as never,
    {
      adapterKey: 'stub-retriever',
      version: '1.0.0',
      embeddingModelKey: 'stub-embedding',
      embeddingModelVersion: '1',
      ensureIndex: jest.fn(async () => ({ indexed: 0, total: 0 })),
      retrieve: jest.fn(async () => []),
    } as never,
    {
      adapterKey: 'stub-classical',
      version: '1.0.0',
      match: jest.fn(async () => options.classicalSignals),
    } as never,
    {
      adapterKey: 'stub-context',
      version: '1.0.0',
      contextFor: jest.fn(async () => []),
    } as never,
    new WeightedCandidateFusion(),
    {} as never,
    // Local (Ollama) verifier slot — the provider the service selects by
    // default when a test enables PICKUP_VLM_ENABLED.
    {
      adapterKey: 'stub-vlm',
      version: '1.0.0',
      verify: options.vlmVerify ?? jest.fn(),
    } as never,
    {
      adapterKey: 'stub-inventory',
      version: '1.0.0',
      validate: jest.fn(async () => []),
    } as never,
    { get: (key: string) => options.config?.[key] } as unknown as ConfigService,
  );
  return { service, productFindMany, createdRuns };
}

describe('fusion catalog is constrained to ACTIVE products', () => {
  const RETIRED: CatalogFixture = {
    id: 'p-retired',
    sku: 'RETIRED-1',
    name: 'Retired Water 500ml',
    status: ProductStatus.DISCONTINUED,
    barcode: '6281000000002',
  };
  const ACTIVE: CatalogFixture = { ...RETIRED, status: ProductStatus.ACTIVE };

  it('a DISCONTINUED product with an exact barcode and a strong stray signal never becomes a candidate or auto-proposes', async () => {
    const { service, productFindMany, createdRuns } = buildService({
      catalog: [RETIRED],
      barcodeSeen: RETIRED.barcode,
      // A perfect stray visual signal (as if a stale cache still knew the
      // product): even combined with the exact barcode this MUST NOT
      // reach AUTO_PROPOSE once the catalog is ACTIVE-filtered.
      classicalSignals: [{ productId: RETIRED.id, sku: RETIRED.sku, score: 0.95 }],
    });
    await service.run('tenant-1', 'asset-1');

    // The constraint lives in the query itself, at the data-access boundary.
    expect(productFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: ProductStatus.ACTIVE }),
      }),
    );
    expect(createdRuns).toHaveLength(1);
    const { data } = createdRuns[0];
    expect(data.policy).toBe(FusionPolicyResult.UNKNOWN_PRODUCT);
    expect(data.policy).not.toBe(FusionPolicyResult.AUTO_PROPOSE);
    // The retired product's barcode no longer resolves to an owner and
    // its SKU appears in no candidate list.
    expect(data.evidence.barcode.matchedSku).toBeNull();
    expect(data.evidence.fused.map((candidate) => candidate.sku)).not.toContain(
      RETIRED.sku,
    );
  });

  it('the SAME signals on an ACTIVE product auto-propose — only the status gate differs', async () => {
    const { service, createdRuns } = buildService({
      catalog: [ACTIVE],
      barcodeSeen: ACTIVE.barcode,
      classicalSignals: [{ productId: ACTIVE.id, sku: ACTIVE.sku, score: 0.95 }],
    });
    await service.run('tenant-1', 'asset-1');

    expect(createdRuns).toHaveLength(1);
    const { data } = createdRuns[0];
    expect(data.policy).toBe(FusionPolicyResult.AUTO_PROPOSE);
    expect(data.fusedTopSku).toBe(ACTIVE.sku);
    expect(data.evidence.barcode.matchedSku).toBe(ACTIVE.sku);
    // Persisted evidence never carries response-derived text fields.
    const persisted = JSON.stringify(data.evidence);
    expect(persisted).not.toContain('rawPreview');
    expect(persisted).not.toContain('errorDetail');
  });
});

// --------------------------------------------------------------------
// Frame-derived text screening at the persistence boundary
// --------------------------------------------------------------------

describe('frame-derived OCR/decode text is screened before persistence (payment-safety)', () => {
  const ACTIVE: CatalogFixture = {
    id: 'p-active',
    sku: 'WATER-1',
    name: 'Spring Water 500ml',
    status: ProductStatus.ACTIVE,
    barcode: '6281000000002',
  };

  it('OCR frame text carrying a PAN/CVV never persists — only the classified marker does', async () => {
    const { service, createdRuns } = buildService({
      catalog: [ACTIVE],
      barcodeSeen: ACTIVE.barcode,
      classicalSignals: [{ productId: ACTIVE.id, sku: ACTIVE.sku, score: 0.95 }],
      // A checkout card visible in the ZOOMED event-region crop — text the
      // pre-store full-frame screen never resolved.
      ocrSeen: {
        rawText: `TOTAL 12.99 ${PAN} CVV 987`,
        normalizedText: `total 12 99 ${PAN} cvv 987`,
      },
    });
    await service.run('tenant-1', 'asset-1');

    expect(createdRuns).toHaveLength(1);
    const { data } = createdRuns[0];
    expect(data.evidence.ocr.screened).toBe(OCR_TEXT_SUPPRESSED);
    expect(data.evidence.ocr.rawText).toBe('');
    expect(data.evidence.ocr.normalizedText).toBe('');
    // The exact JSON that would be persisted carries none of the text.
    const persisted = JSON.stringify(data.evidence);
    expect(persisted).not.toContain(PAN);
    expect(persisted.toLowerCase()).not.toContain('cvv');
  });

  it('benign OCR text persists verbatim — the gate screens, it does not blanket-suppress', async () => {
    const { service, createdRuns } = buildService({
      catalog: [ACTIVE],
      barcodeSeen: ACTIVE.barcode,
      classicalSignals: [{ productId: ACTIVE.id, sku: ACTIVE.sku, score: 0.95 }],
      ocrSeen: { rawText: 'Spring Water 500ml', normalizedText: 'spring water 500ml' },
    });
    await service.run('tenant-1', 'asset-1');

    const { data } = createdRuns[0];
    expect(data.evidence.ocr.screened).toBeUndefined();
    expect(data.evidence.ocr.rawText).toBe('Spring Water 500ml');
    expect(data.evidence.ocr.normalizedText).toBe('spring water 500ml');
  });

  it('an unmatched QR payload that trips the screen persists format + marker only', async () => {
    const { service, createdRuns } = buildService({
      catalog: [ACTIVE],
      // A payment QR whose payload embeds a PAN — first decoded at fusion
      // time (the pre-store pixel screen cannot read a QR matrix).
      barcodeSeen: PAN,
      barcodeFormat: 'QR_CODE',
      classicalSignals: [{ productId: ACTIVE.id, sku: ACTIVE.sku, score: 0.95 }],
    });
    await service.run('tenant-1', 'asset-1');

    const { data } = createdRuns[0];
    expect(data.evidence.barcode.results).toEqual([
      { value: BARCODE_VALUE_SUPPRESSED, format: 'QR_CODE' },
    ]);
    expect(data.evidence.barcode.matchedSku).toBeNull();
    expect(JSON.stringify(data.evidence)).not.toContain(PAN);
  });

  it('a catalog-matched decode still persists verbatim', async () => {
    const { service, createdRuns } = buildService({
      catalog: [ACTIVE],
      barcodeSeen: ACTIVE.barcode,
      classicalSignals: [],
    });
    await service.run('tenant-1', 'asset-1');

    const { data } = createdRuns[0];
    expect(data.evidence.barcode.results).toEqual([
      { value: ACTIVE.barcode, format: 'EAN_13' },
    ]);
    expect(data.evidence.barcode.matchedSku).toBe(ACTIVE.sku);
  });

  it('screened OCR text and decode values never reach the VLM request either', async () => {
    const vlmVerify: jest.Mock = jest.fn(async () => ({
      status: 'TIMEOUT',
      result: null,
      modelKey: 'stub-vlm',
      modelVersion: 'stub-vlm',
      latencyMs: 1,
      errorDetail: null,
      rawPreview: null,
    }));
    const { service } = buildService({
      catalog: [ACTIVE],
      barcodeSeen: PAN,
      barcodeFormat: 'QR_CODE',
      // classical 1.0 alone fuses to 0.22 — the uncertain band → NEEDS_VLM.
      classicalSignals: [{ productId: ACTIVE.id, sku: ACTIVE.sku, score: 1 }],
      ocrSeen: { rawText: `CVV 987 ${PAN}`, normalizedText: `cvv 987 ${PAN}` },
      config: { PICKUP_VLM_ENABLED: 'true' },
      vlmVerify,
    });
    await service.run('tenant-1', 'asset-1');

    expect(vlmVerify).toHaveBeenCalledTimes(1);
    const request = vlmVerify.mock.calls[0][0] as {
      ocrText: string | null;
      barcode: string | null;
    };
    expect(request.ocrText).toBeNull();
    expect(request.barcode).toBeNull();
  });
});

// --------------------------------------------------------------------
// VLM timeout is bounded at construction (boot-time config validation)
// --------------------------------------------------------------------

describe('PICKUP_VLM_TIMEOUT_MS is bounded at construction like the policy thresholds', () => {
  const base = {
    catalog: [] as CatalogFixture[],
    barcodeSeen: '6281000000002',
    classicalSignals: [] as CandidateSignal[],
  };

  it('out-of-range values fail boot loudly instead of running with an unsafe timeout', () => {
    // 0/negative would abort every verification before it starts; an
    // extra digit would let a stalled provider pin a run for hours.
    for (const bad of ['0', '999', '-60000', '600001', '3600000']) {
      expect(() =>
        buildService({ ...base, config: { PICKUP_VLM_TIMEOUT_MS: bad } }),
      ).toThrow(/PICKUP_VLM_TIMEOUT_MS.*outside its safe range/);
    }
  });

  it('unset falls back to the provider default; in-range values are accepted', () => {
    expect(() => buildService(base)).not.toThrow();
    for (const ok of ['1000', '60000', '600000']) {
      expect(() =>
        buildService({ ...base, config: { PICKUP_VLM_TIMEOUT_MS: ok } }),
      ).not.toThrow();
    }
  });
});
