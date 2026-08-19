import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  FusionPolicyResult,
  FusionRunScope,
  ProductStatus,
  VideoAssetStatus,
} from '@prisma/client';
import { WeightedCandidateFusion } from './adapters/context-fusion-inventory';
import { HogLabVisualRetriever } from './adapters/visual-signals';
import { EMBEDDING_MODEL_KEY, EMBEDDING_MODEL_VERSION } from './primitives';
import {
  BARCODE_VALUE_SUPPRESSED,
  CROP_ARTIFACT_FAILED,
  FUSION_PIPELINE_VERSION,
  FusionEvidence,
  LIVE_FRAME_PIXEL_SCREEN_REQUIRED,
  LIVE_FRAME_SCREENING_UNAVAILABLE,
  LIVE_FRAME_SENSITIVE_CONTENT,
  OCR_TEXT_SUPPRESSED,
  PickupFusionService,
  applyVlmVerdictToEvidence,
  fusionCropIdempotencyKey,
} from './pickup-fusion.service';
import { CandidateSignal, OcrExecutionStatus, VlmVerdict } from './ports';

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
    ocr: { rawText: '', normalizedText: '', languages: [], perProduct: [], status: 'NOT_RUN' },
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
  /** Classified OCR execution status the stub adapter reports (default OK). */
  ocrStatus?: OcrExecutionStatus;
  config?: Record<string, string>;
  vlmVerify?: jest.Mock;
  /** Inventory validator port fake — defaults to PLAUSIBLE for every
   *  requested candidate (the gate FAILS CLOSED on anything else). */
  inventoryValidate?: jest.Mock;
}) {
  const createdRuns: { data: { policy: FusionPolicyResult; fusedTopSku: string | null; evidence: FusionEvidence; runScope: FusionRunScope } }[] = [];
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
    // Phase 13 — tenant-scoped live-session existence check for
    // runLiveWindow ('live-1' is the one session this stub knows).
    liveCameraSession: {
      findFirst: jest.fn(
        async (args: { where: { tenantId: string; id: string } }) =>
          args.where.id === 'live-1' && args.where.tenantId === 'tenant-1'
            ? { id: 'live-1' }
            : null,
      ),
    },
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
  // The MEDIA PORT fake (PICKUP_MEDIA_DECODER) — storage-key based; the
  // service never sees a path or a concrete storage/decoder class.
  const decoder = {
    adapterKey: 'stub-media',
    version: '1.0.0',
    checkReady: jest.fn(async () => true),
    // Frames sized to whatever geometry the service asks for; flat gray.
    decodeAnalysisFrames: jest.fn(
      async (
        _storageKey: string,
        _fps: number,
        geometry: { width: number; height: number },
        _durationMs: number,
      ) =>
        Array.from({ length: 5 }, (_unused, index) => ({
          index,
          timestampMs: index * 1000,
          rgb: Buffer.alloc(geometry.width * geometry.height * 3, 100),
        })),
    ),
    // Full-resolution frames arrive one seek at a time.
    decodeFrameAt: jest.fn(
      async (
        _storageKey: string,
        timestampMs: number,
        geometry: { width: number; height: number },
      ) => ({
        index: 0,
        timestampMs,
        rgb: Buffer.alloc(geometry.width * geometry.height * 3, 100),
      }),
    ),
    decodeReferenceImage: jest.fn(),
  };
  // Hoisted so specs can shape PER-CALL responses (the live per-crop
  // screen re-invokes recognize for every extra VLM-bound crop).
  const ocrRecognize = jest.fn(async () => ({
    rawText: options.ocrSeen?.rawText ?? '',
    normalizedText: options.ocrSeen?.normalizedText ?? '',
    languages: options.ocrSeen ? ['eng'] : [],
    status: options.ocrStatus ?? 'OK',
  }));
  const detector = {
    adapterKey: 'stub-detector',
    version: '1.0.0',
    detect: jest.fn(async (_frames: { timestampMs: number }[]) => ({
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
  const videoAssets = {
    createCrop: jest.fn(async () => ({ artifact: { id: 'crop-1' } })),
  };
  const service = new PickupFusionService(
    prisma as never,
    { findByIdInternal: jest.fn(async () => asset) } as never,
    videoAssets as never,
    { analysisWidth: 48, analysisFps: 2 } as never,
    decoder as never,
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
      recognize: ocrRecognize,
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
    // The SELECTED verifier port (PICKUP_VLM_VERIFIER token) — fakes are
    // injected through the port; the service never sees a concrete vendor.
    {
      provider: 'local',
      verifier: {
        adapterKey: 'stub-vlm',
        version: '1.0.0',
        verify: options.vlmVerify ?? jest.fn(),
      },
      readiness: jest.fn(),
    } as never,
    {
      adapterKey: 'stub-inventory',
      version: '1.0.0',
      validate:
        options.inventoryValidate ??
        // Default: every requested candidate validates PLAUSIBLE, so the
        // fail-closed gate stays out of unrelated fixtures' way.
        jest.fn(
          async (_tenantId: string, _locationId: string | null, ids: string[]) =>
            ids.map((productId) => {
              const row = options.catalog.find(
                (product) => product.id === productId,
              );
              return {
                productId,
                sku: row?.sku ?? productId,
                stockedAtStore: true,
                onHandQuantity: 3,
                verdict: 'PLAUSIBLE' as const,
              };
            }),
        ),
    } as never,
    // Tx-scoped retriever factory (module-provided in production).
    (() => ({})) as never,
    { get: (key: string) => options.config?.[key] } as unknown as ConfigService,
  );
  return { service, productFindMany, createdRuns, decoder, detector, videoAssets, prisma, ocrRecognize };
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

// --------------------------------------------------------------------
// A failed OCR stage is classified and demotes AUTO_PROPOSE
// --------------------------------------------------------------------

describe('OCR execution failures are classified — never a silent no-text pass', () => {
  const ACTIVE: CatalogFixture = {
    id: 'p-active',
    sku: 'WATER-1',
    name: 'Spring Water 500ml',
    status: ProductStatus.ACTIVE,
    barcode: '6281000000002',
  };
  // Barcode + strong classical signal: without the OCR gate this fixture
  // reaches AUTO_PROPOSE (pinned by the ACTIVE-catalog suite above).
  const strong = {
    catalog: [ACTIVE],
    barcodeSeen: ACTIVE.barcode,
    classicalSignals: [{ productId: ACTIVE.id, sku: ACTIVE.sku, score: 0.95 }],
  };

  it.each(['EXECUTION_FAILED', 'TIMEOUT', 'UNAVAILABLE'] as const)(
    'OCR %s: a would-be AUTO_PROPOSE demotes to review and the classified marker persists',
    async (ocrStatus) => {
      const { service, createdRuns } = buildService({ ...strong, ocrStatus });
      await service.run('tenant-1', 'asset-1');

      expect(createdRuns).toHaveLength(1);
      const { data } = createdRuns[0];
      // The advertised OCR verification stage did not run — review, not
      // auto-propose past a dead stage.
      expect(data.policy).toBe(FusionPolicyResult.NEEDS_HUMAN_REVIEW);
      expect(data.evidence.policy.reason).toContain(`OCR stage ${ocrStatus}`);
      // Classified code only in the durable evidence — no longer
      // indistinguishable from a no-text pass, and never raw error text.
      expect(data.evidence.ocr.status).toBe(ocrStatus);
      expect(data.evidence.ocr.rawText).toBe('');
    },
  );

  it('a successful pass records status OK and auto-proposes as before', async () => {
    const { service, createdRuns } = buildService(strong);
    await service.run('tenant-1', 'asset-1');

    const { data } = createdRuns[0];
    expect(data.policy).toBe(FusionPolicyResult.AUTO_PROPOSE);
    expect(data.evidence.ocr.status).toBe('OK');
  });
});

// --------------------------------------------------------------------
// Full-resolution decoding stays per-timestamp (bounded ffmpeg output)
// --------------------------------------------------------------------

describe('full-resolution frames are decoded per consumed timestamp, never as a whole clip', () => {
  const ACTIVE: CatalogFixture = {
    id: 'p-active',
    sku: 'WATER-1',
    name: 'Spring Water 500ml',
    status: ProductStatus.ACTIVE,
    barcode: '6281000000002',
  };

  it('one whole-clip decode at the SMALL analysis geometry; full-res is one seek per instant', async () => {
    const { service, decoder } = buildService({
      catalog: [ACTIVE],
      barcodeSeen: ACTIVE.barcode,
      classicalSignals: [{ productId: ACTIVE.id, sku: ACTIVE.sku, score: 0.95 }],
    });
    await service.run('tenant-1', 'asset-1');

    // Whole-clip decoding happens exactly ONCE — the downscaled analysis
    // pass. A second whole-clip decode at full resolution is the overflow
    // regression (20-30 s clips exceed the decoder's 64 MiB budget).
    expect(decoder.decodeAnalysisFrames).toHaveBeenCalledTimes(1);
    // The PORT contract: the service hands over the STORAGE KEY (never a
    // filesystem path) plus the probed duration the decoder's aggregate
    // memory budget needs.
    expect(decoder.decodeAnalysisFrames.mock.calls[0][0]).toBe('assets/clip.mp4');
    expect(decoder.decodeAnalysisFrames.mock.calls[0][3]).toBe(6000);
    const smallGeometry = decoder.decodeAnalysisFrames.mock.calls[0][2] as {
      width: number;
    };
    expect(smallGeometry.width).toBe(48);

    // Full resolution arrives via per-timestamp seeks at the consumed
    // instants only: quiet baseline + pre*3 + peak + post (event fixture:
    // start 1500 / peak 2000 / end 2500, clip 6000 ms) — each decoded once.
    const seeks = decoder.decodeFrameAt.mock.calls
      .map((call) => call[1] as number)
      .sort((a, b) => a - b);
    expect(seeks).toEqual([0, 300, 900, 1300, 2000, 3100]);
    for (const call of decoder.decodeFrameAt.mock.calls) {
      expect((call[2] as { width: number }).width).toBe(480);
    }
  });

  it('a tail-of-clip fallback decode persists the ACTUAL decoded instant into crop evidence', async () => {
    const { service, decoder, createdRuns } = buildService({
      catalog: [ACTIVE],
      barcodeSeen: ACTIVE.barcode,
      classicalSignals: [{ productId: ACTIVE.id, sku: ACTIVE.sku, score: 0.95 }],
    });
    // The post instant (3100 ms) seeks past the container's last frame —
    // the decoder falls back 1 s and reports the instant that actually
    // produced pixels (pinned in analysis-frames.spec.ts).
    decoder.decodeFrameAt.mockImplementation(
      async (
        _storageKey: string,
        timestampMs: number,
        geometry: { width: number; height: number },
      ) => ({
        index: 0,
        timestampMs: timestampMs >= 3100 ? timestampMs - 1000 : timestampMs,
        rgb: Buffer.alloc(geometry.width * geometry.height * 3, 100),
      }),
    );
    await service.run('tenant-1', 'asset-1');

    expect(createdRuns).toHaveLength(1);
    const { data } = createdRuns[0];
    const post = data.evidence.crops.find((crop) => crop.phase === 'post');
    // Evidence carries the TRUE decoded timestamp (2100), never the
    // requested one (3100) — a near-clip-end event must not label a frame
    // up to 1 s earlier as if it showed the requested instant.
    expect(post?.timestampMs).toBe(2100);
    expect(data.evidence.crops.map((crop) => crop.timestampMs)).not.toContain(3100);
  });
});

// --------------------------------------------------------------------
// Inventory gate fails CLOSED (no store context / missing validation)
// --------------------------------------------------------------------

describe('AUTO_PROPOSE demotes when inventory validation cannot back the candidate', () => {
  const ACTIVE: CatalogFixture = {
    id: 'p-active',
    sku: 'WATER-1',
    name: 'Spring Water 500ml',
    status: ProductStatus.ACTIVE,
    barcode: '6281000000002',
  };
  // Barcode + strong classical signal: with a PLAUSIBLE validation this
  // fixture reaches AUTO_PROPOSE (pinned by the ACTIVE-catalog suite).
  const strong = {
    catalog: [ACTIVE],
    barcodeSeen: ACTIVE.barcode,
    classicalSignals: [{ productId: ACTIVE.id, sku: ACTIVE.sku, score: 0.95 }],
  };

  it('a location-less asset (NO_STORE_CONTEXT) routes to review — zero inventory validation is not a pass', async () => {
    const { service, createdRuns } = buildService({
      ...strong,
      inventoryValidate: jest.fn(
        async (_tenantId: string, _locationId: string | null, ids: string[]) =>
          ids.map((productId) => ({
            productId,
            sku: ACTIVE.sku,
            stockedAtStore: false,
            onHandQuantity: null,
            verdict: 'NO_STORE_CONTEXT' as const,
          })),
      ),
    });
    await service.run('tenant-1', 'asset-1');

    expect(createdRuns).toHaveLength(1);
    const { data } = createdRuns[0];
    expect(data.policy).toBe(FusionPolicyResult.NEEDS_HUMAN_REVIEW);
    expect(data.evidence.policy.reason).toContain('NO_STORE_CONTEXT');
  });

  it('a missing validation row for the final SKU routes to review too', async () => {
    const { service, createdRuns } = buildService({
      ...strong,
      inventoryValidate: jest.fn(async () => []),
    });
    await service.run('tenant-1', 'asset-1');

    expect(createdRuns).toHaveLength(1);
    const { data } = createdRuns[0];
    expect(data.policy).toBe(FusionPolicyResult.NEEDS_HUMAN_REVIEW);
    expect(data.evidence.policy.reason).toContain(
      `no inventory validation recorded for ${ACTIVE.sku}`,
    );
  });
});

// --------------------------------------------------------------------
// Atomic reference-index rebuild (delete + reconstruct in ONE transaction)
// --------------------------------------------------------------------

interface ReindexPrismaFixture {
  $transaction: jest.Mock;
  productReferenceEmbedding: { deleteMany: jest.Mock };
}

function buildReindexService(options: {
  prisma: ReindexPrismaFixture;
  decoder?: { decodeReferenceImage: jest.Mock };
  retriever?: { embeddingModelKey: string; embeddingModelVersion: string; ensureIndex: jest.Mock };
}) {
  const retriever =
    options.retriever ?? {
      embeddingModelKey: EMBEDDING_MODEL_KEY,
      embeddingModelVersion: EMBEDDING_MODEL_VERSION,
      ensureIndex: jest.fn(async () => ({ indexed: 0, total: 3 })),
    };
  const storage = { internalPathFor: (key: string) => key };
  const decoder = options.decoder ?? { decodeReferenceImage: jest.fn() };
  // The same factory shape the module provides: a REAL retriever adapter
  // bound to whatever (tx) client the rebuild hands it.
  const txRetrieverFactory = (tx: unknown) =>
    new HogLabVisualRetriever(tx as never, storage as never, decoder as never);
  const service = new PickupFusionService(
    options.prisma as never,
    {} as never,
    {} as never,
    {} as never,
    decoder as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    retriever as never,
    {} as never,
    {} as never,
    {} as never,
    { provider: 'local', verifier: {}, readiness: jest.fn() } as never,
    {} as never,
    txRetrieverFactory as never,
    { get: () => undefined } as unknown as ConfigService,
  );
  return { service, retriever };
}

describe('reference-index rebuild swaps atomically (old index intact until commit)', () => {
  it('rebuild=false only backfills through the injected retriever — no delete, no transaction', async () => {
    const prisma: ReindexPrismaFixture = {
      $transaction: jest.fn(),
      productReferenceEmbedding: { deleteMany: jest.fn() },
    };
    const { service, retriever } = buildReindexService({ prisma });

    const result = await service.reindexReferenceIndex('tenant-1', false);

    expect(retriever.ensureIndex).toHaveBeenCalledWith('tenant-1');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.productReferenceEmbedding.deleteMany).not.toHaveBeenCalled();
    expect(result).toEqual({
      modelKey: EMBEDDING_MODEL_KEY,
      modelVersion: EMBEDDING_MODEL_VERSION,
      rebuilt: false,
      indexed: 0,
      total: 3,
    });
  });

  it('rebuild=true deletes AND reconstructs on the SAME transaction client, inside one bounded transaction', async () => {
    const tx = {
      productReferenceEmbedding: {
        deleteMany: jest.fn(async () => ({ count: 1 })),
        create: jest.fn(async () => ({})),
      },
      productReferenceImage: {
        findMany: jest.fn(async () => [
          { id: 'img-1', productId: 'p-1', storageKey: 'refs/img-1.png', embeddings: [] },
        ]),
      },
    };
    const prisma: ReindexPrismaFixture = {
      $transaction: jest.fn(async (work: (tx: unknown) => Promise<unknown>) => work(tx)),
      productReferenceEmbedding: { deleteMany: jest.fn() },
    };
    const decoder = {
      decodeReferenceImage: jest.fn(async () => ({
        width: 8,
        height: 8,
        rgb: Buffer.alloc(192, 100),
      })),
    };
    const { service, retriever } = buildReindexService({ prisma, decoder });

    const result = await service.reindexReferenceIndex('tenant-1', true);

    // One interactive transaction with a BOUNDED budget.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 120_000,
    });
    // The delete runs on the TX client (never the live connection) and
    // strictly before the rebuild reads — so a rollback restores it all.
    expect(tx.productReferenceEmbedding.deleteMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-1', modelKey: EMBEDDING_MODEL_KEY },
    });
    expect(prisma.productReferenceEmbedding.deleteMany).not.toHaveBeenCalled();
    expect(
      tx.productReferenceEmbedding.deleteMany.mock.invocationCallOrder[0],
    ).toBeLessThan(tx.productReferenceImage.findMany.mock.invocationCallOrder[0]);
    // Reconstruction wrote through the tx client too, under the same key.
    expect(tx.productReferenceEmbedding.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 'tenant-1',
          referenceImageId: 'img-1',
          modelKey: EMBEDDING_MODEL_KEY,
        }),
      }),
    );
    // The injected (live-connection) retriever is bypassed entirely.
    expect(retriever.ensureIndex).not.toHaveBeenCalled();
    expect(result).toEqual({
      modelKey: EMBEDDING_MODEL_KEY,
      modelVersion: EMBEDDING_MODEL_VERSION,
      rebuilt: true,
      indexed: 1,
      total: 1,
    });
  });

  it('a mid-rebuild failure rejects out of the transaction — rollback leaves the old index intact', async () => {
    const tx = {
      productReferenceEmbedding: {
        deleteMany: jest.fn(async () => ({ count: 1 })),
        create: jest.fn(),
      },
      productReferenceImage: {
        findMany: jest.fn(async () => {
          throw new Error('connection lost');
        }),
      },
    };
    // A faithful $transaction: a rejection from the callback propagates
    // (Prisma rolls back), it never resolves with partial work.
    const prisma: ReindexPrismaFixture = {
      $transaction: jest.fn(async (work: (tx: unknown) => Promise<unknown>) => work(tx)),
      productReferenceEmbedding: { deleteMany: jest.fn() },
    };
    const { service } = buildReindexService({ prisma });

    await expect(service.reindexReferenceIndex('tenant-1', true)).rejects.toThrow(
      'connection lost',
    );
    // The live (non-tx) client never deleted anything — the pre-rebuild
    // index was only ever touched inside the rolled-back transaction.
    expect(prisma.productReferenceEmbedding.deleteMany).not.toHaveBeenCalled();
  });

  it('rebuild aborts (throws inside the tx) when any active reference cannot be reconstructed', async () => {
    const tx = {
      productReferenceEmbedding: {
        deleteMany: jest.fn(async () => ({ count: 2 })),
        create: jest.fn(async () => ({})),
      },
      productReferenceImage: {
        findMany: jest.fn(async () => [
          { id: 'img-ok', productId: 'p-1', storageKey: 'refs/ok.png', embeddings: [] },
          { id: 'img-bad', productId: 'p-2', storageKey: 'refs/broken.png', embeddings: [] },
        ]),
      },
    };
    const prisma: ReindexPrismaFixture = {
      $transaction: jest.fn(async (work: (tx: unknown) => Promise<unknown>) => work(tx)),
      productReferenceEmbedding: { deleteMany: jest.fn() },
    };
    // One reference is temporarily unreadable — the incremental path may
    // skip it, but a REBUILD committing without its vector would silently
    // shrink the live index.
    const decoder = {
      decodeReferenceImage: jest.fn(async (path: string) => {
        if (path.includes('broken')) {
          throw new Error('unreadable');
        }
        return { width: 8, height: 8, rgb: Buffer.alloc(192, 100) };
      }),
    };
    const { service } = buildReindexService({ prisma, decoder });

    await expect(service.reindexReferenceIndex('tenant-1', true)).rejects.toThrow(
      /rebuild aborted: 1 of 2/,
    );
    // The rejection propagates OUT of $transaction (Prisma rolls back) —
    // the live client never deleted the old generation.
    expect(prisma.productReferenceEmbedding.deleteMany).not.toHaveBeenCalled();
  });
});

describe('Phase 12 replay-window scoping (camera runtime)', () => {
  const NO_CANDIDATES = {
    catalog: [] as CatalogFixture[],
    barcodeSeen: '6281000000002',
    classicalSignals: [] as CandidateSignal[],
  };

  it('a window overlapping the detected event keeps it and records replayWindow', async () => {
    const { service, createdRuns } = buildService(NO_CANDIDATES);
    await service.run('tenant-1', 'asset-1', {
      window: { startMs: 1000, endMs: 2000, peakMs: 1600 },
    });
    const { data } = createdRuns[0];
    expect(data.evidence.replayWindow).toEqual({
      startMs: 1000,
      endMs: 2000,
      peakMs: 1600,
    });
    // The stub detector's 1500–2500 event overlaps 1000–2000 and survives.
    expect(data.evidence.detector.events).toHaveLength(1);
  });

  it('a NON-overlapping window follows the existing no-event path', async () => {
    const { service, createdRuns } = buildService(NO_CANDIDATES);
    await service.run('tenant-1', 'asset-1', {
      window: { startMs: 4000, endMs: 5000, peakMs: 4500 },
    });
    const { data } = createdRuns[0];
    // The 1500–2500 detector event does NOT overlap 4000–5000: filtered
    // out, so this window's run records no event and no crops.
    expect(data.evidence.detector.events).toHaveLength(0);
    expect(data.evidence.crops).toHaveLength(0);
    expect(data.policy).toBe(FusionPolicyResult.UNKNOWN_PRODUCT);
  });

  it('no options → whole-clip behavior unchanged, no replayWindow recorded', async () => {
    const { service, createdRuns } = buildService(NO_CANDIDATES);
    await service.run('tenant-1', 'asset-1');
    const { data } = createdRuns[0];
    expect(data.evidence.replayWindow).toBeUndefined();
    expect(data.evidence.detector.events).toHaveLength(1);
    expect(data.runScope).toBe(FusionRunScope.WHOLE_CLIP);
  });

  it('the DETECTOR INPUT is constrained to the window (baseline lead-in before, one frame margin after)', async () => {
    const { service, detector } = buildService(NO_CANDIDATES);
    // Decoder frames land at 0/1000/2000/3000/4000ms; analysisFps 2 →
    // tail margin 500ms, lead-in WINDOW_BASELINE_LEAD_IN_MS (1s — the
    // classical detector needs quiet warm-up frames or it models the
    // burst itself as background). A 1000–2000 window therefore admits
    // [0 (lead-in), 1000, 2000] and NOTHING after 2500ms — the later
    // clip content stays invisible to this window's detection.
    await service.run('tenant-1', 'asset-1', {
      window: { startMs: 1000, endMs: 2000, peakMs: 1600 },
    });
    const framesSeen = detector.detect.mock.calls[0][0].map(
      (frame) => frame.timestampMs,
    );
    expect(framesSeen).toEqual([0, 1000, 2000]);
  });

  it('TWO windows each detect their OWN local peak — never the global one', async () => {
    const { service, createdRuns, detector } = buildService(NO_CANDIDATES);
    // A detector that (like the real one) derives its event from the
    // frames it is GIVEN: peak = the middle frame it received. If the
    // whole clip leaked in, both windows would report the same peak.
    detector.detect.mockImplementation(
      async (frames: { timestampMs: number }[]) => {
        const peakMs = frames[Math.floor(frames.length / 2)].timestampMs;
        return {
          events: [
            {
              kind: 'PICKUP' as const,
              startMs: frames[0].timestampMs,
              peakMs,
              endMs: frames[frames.length - 1].timestampMs,
              trackId: 't1',
              shelfZoneId: 'z-1-1',
              box: { x: 4, y: 4, width: 12, height: 12 },
            },
          ],
          tracks: [],
          warnings: [],
        };
      },
    );
    await service.run('tenant-1', 'asset-1', {
      window: { startMs: 500, endMs: 1500, peakMs: 1000 },
    });
    await service.run('tenant-1', 'asset-1', {
      window: { startMs: 2500, endMs: 3500, peakMs: 3000 },
    });
    expect(createdRuns).toHaveLength(2);
    const firstPeak = createdRuns[0].data.evidence.detector.events[0].peakMs;
    const secondPeak = createdRuns[1].data.evidence.detector.events[0].peakMs;
    expect(firstPeak).not.toBe(secondPeak);
    expect(firstPeak).toBeGreaterThanOrEqual(500 - 500);
    expect(firstPeak).toBeLessThanOrEqual(1500 + 500);
    expect(secondPeak).toBeGreaterThanOrEqual(2500 - 500);
    expect(secondPeak).toBeLessThanOrEqual(3500 + 500);
  });

  it('a window-scoped run persists as REPLAY_WINDOW — whole-clip evaluation never sees it', async () => {
    const { service, createdRuns } = buildService(NO_CANDIDATES);
    await service.run('tenant-1', 'asset-1', {
      window: { startMs: 1000, endMs: 2000, peakMs: 1600 },
    });
    expect(createdRuns[0].data.runScope).toBe(FusionRunScope.REPLAY_WINDOW);
  });

  it('latestEvidence returns the WHOLE_CLIP run even when replay-window runs are newer (Codex P1)', async () => {
    const { service } = buildService(NO_CANDIDATES);
    // The builder keeps its prisma stub private — reach the same instance
    // the service holds to install an honoring run store.
    const prisma = (
      service as unknown as {
        prisma: { pickupFusionRun: { findFirst: jest.Mock } };
      }
    ).prisma;
    // Honoring stub: two stored runs for the asset — a NEWER window run
    // and an older whole-clip run. Only a query that filters runScope in
    // the database gets the whole-clip one back.
    const rows = [
      {
        id: 'run-window-newer',
        runScope: FusionRunScope.REPLAY_WINDOW,
        createdAt: new Date('2026-08-16T12:30:00.000Z'),
        pipelineVersion: 'pickup-fusion-v2',
        policy: 'UNKNOWN_PRODUCT',
        fusedTopSku: null,
        fusedTopScore: null,
        scoreMargin: null,
        processingMs: 10,
        evidence: {
          shadow: {},
          fused: [],
          vlm: { status: 'UNAVAILABLE', verdict: null, selectedSku: null },
        },
      },
      {
        id: 'run-whole-clip',
        runScope: FusionRunScope.WHOLE_CLIP,
        createdAt: new Date('2026-08-16T12:00:00.000Z'),
        pipelineVersion: 'pickup-fusion-v2',
        policy: 'AUTO_PROPOSE',
        fusedTopSku: 'SKU-A',
        fusedTopScore: 0.5,
        scoreMargin: 0.2,
        processingMs: 10,
        evidence: {
          shadow: {},
          fused: [],
          vlm: { status: 'UNAVAILABLE', verdict: null, selectedSku: null },
        },
      },
    ];
    prisma.pickupFusionRun.findFirst = jest.fn(
      async (args: { where: { runScope?: FusionRunScope } }) =>
        [...rows]
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .find(
            (row) =>
              args.where.runScope === undefined ||
              row.runScope === args.where.runScope,
          ) ?? null,
    );
    const result = await service.latestEvidence('tenant-1', 'asset-1');
    expect(result?.runId).toBe('run-whole-clip');
    expect(prisma.pickupFusionRun.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          runScope: FusionRunScope.WHOLE_CLIP,
        }),
      }),
    );
  });
});

describe('Phase 13 runLiveWindow (live RTSP shadow sessions)', () => {
  const NO_CANDIDATES = {
    catalog: [] as CatalogFixture[],
    barcodeSeen: '6281000000002',
    classicalSignals: [] as CandidateSignal[],
  };

  /** Five flat-gray sampled frames at 0..4000ms, one shared geometry —
   *  the live twin of the decoder stub's analysis stream. */
  function liveFrames(): { timestampMs: number; image: { width: number; height: number; rgb: Buffer } }[] {
    return Array.from({ length: 5 }, (_unused, index) => ({
      timestampMs: index * 1000,
      image: { width: 48, height: 36, rgb: Buffer.alloc(48 * 36 * 3, 100) },
    }));
  }

  const LIVE_INPUT = {
    liveSessionId: 'live-1',
    locationId: 'store-1',
    unitId: null,
    window: { startMs: 1000, endMs: 2600, peakMs: 2000 },
  };

  it('persists a LIVE_WINDOW run with the session origin and NO video asset', async () => {
    const { service, createdRuns } = buildService(NO_CANDIDATES);
    const { runId } = await service.runLiveWindow('tenant-1', {
      ...LIVE_INPUT,
      frames: liveFrames(),
    });
    expect(runId).toBe('run-1');
    expect(createdRuns).toHaveLength(1);
    const { data } = createdRuns[0] as unknown as {
      data: {
        runScope: FusionRunScope;
        videoAssetId: string | null;
        liveSessionId: string;
        evidence: FusionEvidence;
      };
    };
    expect(data.runScope).toBe(FusionRunScope.LIVE_WINDOW);
    expect(data.videoAssetId).toBeNull();
    expect(data.liveSessionId).toBe('live-1');
    expect(data.evidence.liveSessionId).toBe('live-1');
    expect(data.evidence.replayWindow).toEqual(LIVE_INPUT.window);
    // The stub detector's 1500-2500 event overlaps the window: the full
    // pipeline ran and recorded crops + a policy.
    expect(data.evidence.detector.events).toHaveLength(1);
    expect(data.evidence.crops.length).toBeGreaterThan(0);
  });

  it('an unknown or foreign-tenant session is NotFound with no run row', async () => {
    const { service, createdRuns } = buildService(NO_CANDIDATES);
    await expect(
      service.runLiveWindow('tenant-1', {
        ...LIVE_INPUT,
        liveSessionId: 'live-elsewhere',
        frames: liveFrames(),
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.runLiveWindow('tenant-2', {
        ...LIVE_INPUT,
        frames: liveFrames(),
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(createdRuns).toHaveLength(0);
  });

  it('bounds are enforced: frame count, shared geometry, ascending timestamps, dimension cap', async () => {
    const { service, createdRuns } = buildService(NO_CANDIDATES);
    await expect(
      service.runLiveWindow('tenant-1', {
        ...LIVE_INPUT,
        frames: liveFrames().slice(0, 1),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    const mixed = liveFrames();
    mixed[2] = {
      timestampMs: 2000,
      image: { width: 24, height: 36, rgb: Buffer.alloc(24 * 36 * 3, 100) },
    };
    await expect(
      service.runLiveWindow('tenant-1', { ...LIVE_INPUT, frames: mixed }),
    ).rejects.toBeInstanceOf(BadRequestException);
    const unordered = liveFrames();
    unordered[3] = { ...unordered[3], timestampMs: unordered[2].timestampMs };
    await expect(
      service.runLiveWindow('tenant-1', { ...LIVE_INPUT, frames: unordered }),
    ).rejects.toBeInstanceOf(BadRequestException);
    const huge = liveFrames().map((frame) => ({
      timestampMs: frame.timestampMs,
      image: { width: 1024, height: 36, rgb: Buffer.alloc(1024 * 36 * 3, 100) },
    }));
    await expect(
      service.runLiveWindow('tenant-1', { ...LIVE_INPUT, frames: huge }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(createdRuns).toHaveLength(0);
  });

  it('runs the IDENTICAL shared pipeline as the asset path: same fused answer and policy on the same frames', async () => {
    const assetSide = buildService(NO_CANDIDATES);
    await assetSide.service.run('tenant-1', 'asset-1', {
      window: LIVE_INPUT.window,
    });
    const liveSide = buildService(NO_CANDIDATES);
    await liveSide.service.runLiveWindow('tenant-1', {
      ...LIVE_INPUT,
      frames: liveFrames(),
    });
    const assetRun = assetSide.createdRuns[0].data;
    const liveRun = liveSide.createdRuns[0].data;
    expect(liveRun.policy).toBe(assetRun.policy);
    expect(liveRun.evidence.fused).toEqual(assetRun.evidence.fused);
    expect(liveRun.evidence.detector.events.map((event) => event.kind)).toEqual(
      assetRun.evidence.detector.events.map((event) => event.kind),
    );
  });

  it('a non-overlapping window is a controlled no-event run — and no crop ARTIFACT is ever written for live', async () => {
    const { service, createdRuns, videoAssets } = buildService(NO_CANDIDATES);
    await service.runLiveWindow('tenant-1', {
      ...LIVE_INPUT,
      window: { startMs: 3800, endMs: 4000, peakMs: 3900 },
      frames: liveFrames(),
    });
    const { data } = createdRuns[0];
    expect(data.policy).toBe(FusionPolicyResult.UNKNOWN_PRODUCT);
    expect(data.evidence.crops).toHaveLength(0);
    expect(videoAssets.createCrop).not.toHaveBeenCalled();
  });

  it('a successful live run also never writes a crop artifact (no asset exists)', async () => {
    const { service, videoAssets, createdRuns } = buildService(NO_CANDIDATES);
    await service.runLiveWindow('tenant-1', {
      ...LIVE_INPUT,
      frames: liveFrames(),
    });
    expect(createdRuns[0].data.evidence.cropArtifactId).toBeNull();
    expect(videoAssets.createCrop).not.toHaveBeenCalled();
  });
});

describe('fusion crop idempotency keys are collision-safe (Codex P2)', () => {
  const NO_CANDIDATES = {
    catalog: [] as CatalogFixture[],
    barcodeSeen: '6281000000002',
    classicalSignals: [] as CandidateSignal[],
  };
  const CROP = { timestampMs: 1000, x: 1, y: 2, width: 30, height: 40 };
  const WINDOW_A = { startMs: 1000, endMs: 2000, peakMs: 1600 };
  const WINDOW_B = { startMs: 1500, endMs: 2500, peakMs: 2100 };

  const cropKeyAt = (
    stub: { createCrop: jest.Mock },
    index: number,
  ): string =>
    (
      stub.createCrop.mock.calls as unknown as [
        string,
        string,
        { idempotencyKey: string },
      ][]
    )[index][2].idempotencyKey;

  it('two replay windows on one asset derive DIFFERENT keys — no cross-window steal', () => {
    const a = fusionCropIdempotencyKey('asset-1', 'REPLAY_WINDOW', WINDOW_A, CROP);
    const b = fusionCropIdempotencyKey('asset-1', 'REPLAY_WINDOW', WINDOW_B, CROP);
    expect(a).not.toBe(b);
  });

  it('exact retry of the same window derives the SAME key — the artifact replays', () => {
    const a = fusionCropIdempotencyKey('asset-1', 'REPLAY_WINDOW', WINDOW_A, CROP);
    const b = fusionCropIdempotencyKey('asset-1', 'REPLAY_WINDOW', { ...WINDOW_A }, { ...CROP });
    expect(a).toBe(b);
  });

  it('whole-clip and a replay window never share a key even for identical crops', () => {
    const clip = fusionCropIdempotencyKey('asset-1', 'WHOLE_CLIP', null, CROP);
    const win = fusionCropIdempotencyKey('asset-1', 'REPLAY_WINDOW', WINDOW_A, CROP);
    expect(clip).not.toBe(win);
  });

  it('a different detection crop changes the key', () => {
    const a = fusionCropIdempotencyKey('asset-1', 'WHOLE_CLIP', null, CROP);
    const b = fusionCropIdempotencyKey('asset-1', 'WHOLE_CLIP', null, {
      ...CROP,
      timestampMs: 1400,
    });
    expect(a).not.toBe(b);
  });

  it('keys never contain a 13+ digit run (secret-free key screen stays happy)', () => {
    const keys = [
      fusionCropIdempotencyKey('asset-1', 'WHOLE_CLIP', null, CROP),
      fusionCropIdempotencyKey(
        'asset-1',
        'REPLAY_WINDOW',
        { startMs: 1500000, endMs: 1501000, peakMs: 1500500 },
        { timestampMs: 1500500, x: 100, y: 200, width: 300, height: 400 },
      ),
    ];
    for (const key of keys) {
      expect(key).not.toMatch(/\d{13,}/);
      expect(key).toMatch(/^fusion:asset-1:(wc|rw):h[0-9a-f]{8}x[0-9a-f]{8}$/);
    }
  });

  it('run() derives the key from content — the racy run-count read is GONE and overlapping runs share the replayed artifact', async () => {
    const { service, videoAssets, prisma } = buildService(NO_CANDIDATES);
    await service.run('tenant-1', 'asset-1');
    expect(prisma.pickupFusionRun.count).not.toHaveBeenCalled();
    const first = cropKeyAt(videoAssets, 0);
    expect(first).toMatch(/^fusion:asset-1:wc:h[0-9a-f]{8}x[0-9a-f]{8}$/);
    // A second overlapping whole-clip run with identical detection content
    // computes the SAME key: the extraction layer replays one shared
    // artifact instead of rejecting a colliding ordinal.
    await service.run('tenant-1', 'asset-1');
    expect(cropKeyAt(videoAssets, 1)).toBe(first);
  });

  it('window-scoped runs pass window-scoped keys distinct from the whole-clip key', async () => {
    const { service, videoAssets } = buildService(NO_CANDIDATES);
    await service.run('tenant-1', 'asset-1');
    await service.run('tenant-1', 'asset-1', { window: WINDOW_B });
    const clipKey = cropKeyAt(videoAssets, 0);
    const windowKey = cropKeyAt(videoAssets, 1);
    expect(windowKey).toMatch(/^fusion:asset-1:rw:/);
    expect(windowKey).not.toBe(clipKey);
  });

  it('a crop failure surfaces CROP_ARTIFACT_FAILED in the evidence — never a silent missing-crop success', async () => {
    const { service, videoAssets, createdRuns } = buildService(NO_CANDIDATES);
    videoAssets.createCrop.mockRejectedValueOnce(new Error('boom'));
    await service.run('tenant-1', 'asset-1');
    const { data } = createdRuns[0];
    expect(data.evidence.cropArtifactId).toBeNull();
    expect(data.evidence.detector.warnings).toContain(CROP_ARTIFACT_FAILED);
  });
});

describe('LIVE frames are screened before any VLM invocation (Codex P1)', () => {
  const ACTIVE: CatalogFixture = {
    id: 'p-live',
    sku: 'SKU-LIVE',
    name: 'Live Product',
    status: ProductStatus.ACTIVE,
    barcode: '6281000000099',
  };
  /** classical 1.0 alone fuses into the uncertain band -> NEEDS_VLM, so
   *  the pipeline WANTS to invoke the verifier in every case below. */
  const VLM_WANTED = {
    catalog: [ACTIVE],
    barcodeSeen: '6281000000002',
    classicalSignals: [
      { productId: ACTIVE.id, sku: ACTIVE.sku, score: 1 },
    ] as CandidateSignal[],
    config: { PICKUP_VLM_ENABLED: 'true' },
  };
  const stubVerdict = (): jest.Mock =>
    jest.fn(async () => ({
      status: 'TIMEOUT' as const,
      result: null,
      modelKey: 'stub-vlm',
      modelVersion: 'stub-vlm',
      latencyMs: 1,
      errorDetail: null,
      rawPreview: null,
    }));
  function liveFrames() {
    return Array.from({ length: 5 }, (_unused, index) => ({
      timestampMs: index * 1000,
      image: { width: 48, height: 36, rgb: Buffer.alloc(48 * 36 * 3, 100) },
    }));
  }
  const LIVE_INPUT = {
    liveSessionId: 'live-1',
    locationId: 'store-1',
    unitId: null,
    window: { startMs: 1000, endMs: 2600, peakMs: 2000 },
  };

  it('a live crop whose OCR screen TRIPPED never reaches the VLM — review with a controlled reason', async () => {
    const vlmVerify = stubVerdict();
    const { service, createdRuns } = buildService({
      ...VLM_WANTED,
      ocrSeen: { rawText: `CVV 987 ${PAN}`, normalizedText: `cvv 987 ${PAN}` },
      vlmVerify,
    });
    await service.runLiveWindow('tenant-1', {
      ...LIVE_INPUT,
      frames: liveFrames(),
    });
    expect(vlmVerify).not.toHaveBeenCalled();
    const { data } = createdRuns[0];
    expect(data.policy).toBe(FusionPolicyResult.NEEDS_HUMAN_REVIEW);
    expect(data.evidence.vlm.invoked).toBe(false);
    expect(data.evidence.vlm.status).toBe('UNAVAILABLE');
    expect(data.evidence.vlm.reason).toBe(LIVE_FRAME_SENSITIVE_CONTENT);
    expect(JSON.stringify(data.evidence)).not.toContain(PAN);
  });

  it('a live crop whose OCR stage did NOT complete never reaches the VLM either', async () => {
    for (const status of ['UNAVAILABLE', 'TIMEOUT', 'EXECUTION_FAILED'] as const) {
      const vlmVerify = stubVerdict();
      const { service, createdRuns } = buildService({
        ...VLM_WANTED,
        ocrStatus: status,
        vlmVerify,
      });
      await service.runLiveWindow('tenant-1', {
        ...LIVE_INPUT,
        frames: liveFrames(),
      });
      expect(vlmVerify).not.toHaveBeenCalled();
      const { data } = createdRuns[0];
      expect(data.policy).toBe(FusionPolicyResult.NEEDS_HUMAN_REVIEW);
      expect(data.evidence.vlm.reason).toBe(LIVE_FRAME_SCREENING_UNAVAILABLE);
    }
  });

  it('a live crop with a CLEAN OCR screen STILL never reaches the VLM — OCR-clean is not pixel-clean (Phase 13 hard rule)', async () => {
    const vlmVerify = stubVerdict();
    const { service, createdRuns } = buildService({
      ...VLM_WANTED,
      ocrSeen: { rawText: 'shelf label', normalizedText: 'shelf label' },
      vlmVerify,
    });
    await service.runLiveWindow('tenant-1', {
      ...LIVE_INPUT,
      frames: liveFrames(),
    });
    expect(vlmVerify).not.toHaveBeenCalled();
    const { data } = createdRuns[0];
    expect(data.policy).toBe(FusionPolicyResult.NEEDS_HUMAN_REVIEW);
    expect(data.evidence.vlm.invoked).toBe(false);
    expect(data.evidence.vlm.status).toBe('UNAVAILABLE');
    expect(data.evidence.vlm.reason).toBe(LIVE_FRAME_PIXEL_SCREEN_REQUIRED);
  });

  const CLEAN_OCR = {
    rawText: 'shelf label',
    normalizedText: 'shelf label',
    languages: ['eng'],
    status: 'OK' as const,
  };

  it('PER-CROP screen: bestPre clean but the PEAK crop sensitive → VLM not called', async () => {
    const vlmVerify = stubVerdict();
    const { service, createdRuns, ocrRecognize } = buildService({
      ...VLM_WANTED,
      vlmVerify,
    });
    // Call order: evidence OCR (bestPre), then the gate's extra passes
    // (peak, post). Only the PEAK crop carries the sensitive text.
    ocrRecognize
      .mockResolvedValueOnce(CLEAN_OCR)
      .mockResolvedValueOnce({
        ...CLEAN_OCR,
        rawText: `card ${PAN}`,
        normalizedText: `card ${PAN}`,
      })
      .mockResolvedValue(CLEAN_OCR);
    await service.runLiveWindow('tenant-1', {
      ...LIVE_INPUT,
      frames: liveFrames(),
    });
    expect(vlmVerify).not.toHaveBeenCalled();
    const { data } = createdRuns[0];
    expect(data.policy).toBe(FusionPolicyResult.NEEDS_HUMAN_REVIEW);
    expect(data.evidence.vlm.invoked).toBe(false);
    expect(data.evidence.vlm.reason).toBe(LIVE_FRAME_SENSITIVE_CONTENT);
    // The peak crop's recognized text exists only for the verdict —
    // never in the persisted evidence.
    expect(JSON.stringify(data.evidence)).not.toContain(PAN);
  });

  it('PER-CROP screen: bestPre and peak clean but the POST crop sensitive → VLM not called', async () => {
    const vlmVerify = stubVerdict();
    const { service, createdRuns, ocrRecognize } = buildService({
      ...VLM_WANTED,
      vlmVerify,
    });
    ocrRecognize
      .mockResolvedValueOnce(CLEAN_OCR)
      .mockResolvedValueOnce(CLEAN_OCR)
      .mockResolvedValue({
        ...CLEAN_OCR,
        rawText: `cvv 987 ${PAN}`,
        normalizedText: `cvv 987 ${PAN}`,
      });
    await service.runLiveWindow('tenant-1', {
      ...LIVE_INPUT,
      frames: liveFrames(),
    });
    expect(vlmVerify).not.toHaveBeenCalled();
    const { data } = createdRuns[0];
    expect(data.evidence.vlm.reason).toBe(LIVE_FRAME_SENSITIVE_CONTENT);
    expect(JSON.stringify(data.evidence)).not.toContain(PAN);
  });

  it('PER-CROP screen: an extra crop whose OCR did NOT complete blocks the VLM', async () => {
    const vlmVerify = stubVerdict();
    const { service, createdRuns, ocrRecognize } = buildService({
      ...VLM_WANTED,
      vlmVerify,
    });
    ocrRecognize
      .mockResolvedValueOnce(CLEAN_OCR)
      .mockResolvedValue({ ...CLEAN_OCR, status: 'UNAVAILABLE' as const });
    await service.runLiveWindow('tenant-1', {
      ...LIVE_INPUT,
      frames: liveFrames(),
    });
    expect(vlmVerify).not.toHaveBeenCalled();
    expect(createdRuns[0].data.evidence.vlm.reason).toBe(
      LIVE_FRAME_SCREENING_UNAVAILABLE,
    );
  });

  it('PER-CROP screen: an extra crop whose OCR THROWS blocks the VLM as screening-unavailable', async () => {
    const vlmVerify = stubVerdict();
    const { service, createdRuns, ocrRecognize } = buildService({
      ...VLM_WANTED,
      vlmVerify,
    });
    ocrRecognize
      .mockResolvedValueOnce(CLEAN_OCR)
      .mockRejectedValue(new Error('recognizer crashed'));
    await service.runLiveWindow('tenant-1', {
      ...LIVE_INPUT,
      frames: liveFrames(),
    });
    expect(vlmVerify).not.toHaveBeenCalled();
    const { data } = createdRuns[0];
    expect(data.evidence.vlm.reason).toBe(LIVE_FRAME_SCREENING_UNAVAILABLE);
    // The thrown message never reaches the persisted evidence.
    expect(JSON.stringify(data.evidence)).not.toContain('recognizer crashed');
  });

  it('PER-CROP screen: every VLM-bound crop is OCRed for a specific reason, and even all-clean blocks the verifier', async () => {
    const vlmVerify = stubVerdict();
    const { service, createdRuns, ocrRecognize } = buildService({
      ...VLM_WANTED,
      ocrSeen: { rawText: 'shelf label', normalizedText: 'shelf label' },
      vlmVerify,
    });
    await service.runLiveWindow('tenant-1', {
      ...LIVE_INPUT,
      frames: liveFrames(),
    });
    // 1 evidence pass (bestPre) + one pass per extra VLM-bound crop
    // (peak, post) — the gate screened them all for the most specific
    // review reason, and the verifier was STILL not called.
    expect(ocrRecognize.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(vlmVerify).not.toHaveBeenCalled();
    expect(createdRuns[0].data.evidence.vlm.reason).toBe(
      LIVE_FRAME_PIXEL_SCREEN_REQUIRED,
    );
  });

  it('ASSET-path behavior is unchanged: a tripped screen still invokes the VLM with nulled text', async () => {
    const vlmVerify = stubVerdict();
    const { service, ocrRecognize } = buildService({
      ...VLM_WANTED,
      ocrSeen: { rawText: `CVV 987 ${PAN}`, normalizedText: `cvv 987 ${PAN}` },
      vlmVerify,
    });
    await service.run('tenant-1', 'asset-1');
    expect(vlmVerify).toHaveBeenCalledTimes(1);
    const request = vlmVerify.mock.calls[0][0] as { ocrText: string | null };
    expect(request.ocrText).toBeNull();
    // No per-crop screening passes on the asset path — the single
    // evidence OCR is the only recognize call (behavior byte-identical).
    expect(ocrRecognize).toHaveBeenCalledTimes(1);
  });
});
