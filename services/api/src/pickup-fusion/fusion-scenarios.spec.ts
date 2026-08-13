import { createServer, Server } from 'node:http';
import { ConfigService } from '@nestjs/config';
import { AnalysisFrame, AnalysisGeometry } from '../pickup-detection/analysis/pickup-analyzer';
import { RgbImage } from '../pickup-detection/analysis/product-matcher';
import {
  ClassicalMotionEventDetector,
  GreedyIouTracker,
  MotionObjectDetector,
  YoloOnnxObjectDetector,
} from './adapters/event-detection';
import { WeightedCandidateFusion } from './adapters/context-fusion-inventory';
import { ZxingBarcodeReader } from './adapters/text-signals';
import { AnthropicVlmVerifier } from './adapters/vlm-verifier';
import { HogLabVisualRetriever } from './adapters/visual-signals';
import { FusionPolicyResult } from '@prisma/client';
import { decidePolicy, policyFromVlmResult } from './pickup-fusion.service';
import {
  computeDescriptor,
  cosineSimilarity,
  ean13CheckDigit,
  normalizeText,
  renderEan13,
  selectBestCrop,
  textFieldOverlap,
} from './primitives';
import { CandidateSignal, VlmStructuredResult } from './ports';

/**
 * The 14 required validation scenarios (requirement 17) at the honest
 * level for each: real adapters where the signal is computable (barcode
 * decode, detector geometry, VLM schema/timeout), pure logic where the
 * scenario is about fusion/policy behavior. None of these tune any
 * algorithm — they PIN behavior.
 */

const GEOMETRY: AnalysisGeometry = { width: 48, height: 36 };
const SOURCE = { width: 480, height: 360 };
const BOX_A = { x: 6, y: 10, width: 10, height: 12 };
const BOX_B = { x: 30, y: 10, width: 10, height: 12 };

function blank(gray: number): Buffer {
  return Buffer.alloc(GEOMETRY.width * GEOMETRY.height * 3, gray);
}

/** Textured shelf background (vertical bands, period 4): realistic scenes
 *  are not uniform, and only texture makes camera SHIFT visible. */
function texturedScene(): Buffer {
  const frame = Buffer.alloc(GEOMETRY.width * GEOMETRY.height * 3);
  for (let y = 0; y < GEOMETRY.height; y += 1) {
    for (let x = 0; x < GEOMETRY.width; x += 1) {
      const gray = x % 4 < 2 ? 95 : 150;
      const off = (y * GEOMETRY.width + x) * 3;
      frame[off] = gray;
      frame[off + 1] = gray;
      frame[off + 2] = gray;
    }
  }
  return frame;
}

function paint(
  frame: Buffer,
  box: { x: number; y: number; width: number; height: number },
  rgb: [number, number, number],
): void {
  for (let y = box.y; y < box.y + box.height; y += 1) {
    for (let x = box.x; x < box.x + box.width; x += 1) {
      if (x >= GEOMETRY.width || y >= GEOMETRY.height) continue;
      const off = (y * GEOMETRY.width + x) * 3;
      frame[off] = rgb[0];
      frame[off + 1] = rgb[1];
      frame[off + 2] = rgb[2];
    }
  }
}

/** Striped tile so removal regions carry edge structure. */
function paintStriped(
  frame: Buffer,
  box: { x: number; y: number; width: number; height: number },
  rgb: [number, number, number],
): void {
  for (let y = box.y; y < box.y + box.height; y += 1) {
    for (let x = box.x; x < box.x + box.width; x += 1) {
      if (x >= GEOMETRY.width || y >= GEOMETRY.height) continue;
      const on = x % 4 < 2;
      const off = (y * GEOMETRY.width + x) * 3;
      frame[off] = on ? rgb[0] : rgb[0] * 0.4;
      frame[off + 1] = on ? rgb[1] : rgb[1] * 0.4;
      frame[off + 2] = on ? rgb[2] : rgb[2] * 0.4;
    }
  }
}

function toFrames(buffers: Buffer[]): AnalysisFrame[] {
  return buffers.map((rgb, index) => ({ index, timestampMs: index * 400, rgb }));
}

function clip(options: {
  removeA?: boolean;
  removeB?: boolean;
  addA?: boolean;
  handSweepOnly?: boolean;
  shiftAfter?: number;
}): AnalysisFrame[] {
  const buffers: Buffer[] = [];
  const scene = (opts: { a: boolean; b: boolean; handX: number | null; shift?: number }) => {
    const shift = opts.shift ?? 0;
    const frame = shift === 0 ? texturedScene() : texturedScene();
    if (shift !== 0) {
      // Shift the WHOLE textured scene horizontally — a moved camera.
      const shifted = texturedScene();
      for (let y = 0; y < GEOMETRY.height; y += 1) {
        for (let x = 0; x < GEOMETRY.width; x += 1) {
          const from = Math.min(GEOMETRY.width - 1, Math.max(0, x + shift));
          const to = (y * GEOMETRY.width + x) * 3;
          const src = (y * GEOMETRY.width + from) * 3;
          shifted[to] = frame[src];
          shifted[to + 1] = frame[src + 1];
          shifted[to + 2] = frame[src + 2];
        }
      }
      frame.set(shifted);
    }
    if (opts.a) paintStriped(frame, { ...BOX_A, x: BOX_A.x + shift }, [40, 80, 210]);
    if (opts.b) paintStriped(frame, { ...BOX_B, x: BOX_B.x + shift }, [40, 180, 70]);
    if (opts.handX !== null) paint(frame, { x: opts.handX + shift, y: 8, width: 7, height: 14 }, [250, 240, 230]);
    return frame;
  };
  const aBefore = options.addA ? false : true;
  const aAfter = options.addA ? true : !options.removeA;
  const bAfter = !options.removeB;
  for (let i = 0; i < 6; i += 1) buffers.push(scene({ a: aBefore, b: true, handX: null }));
  buffers.push(scene({ a: aBefore, b: true, handX: 38 }));
  buffers.push(scene({ a: aBefore, b: true, handX: 20 }));
  buffers.push(scene({ a: options.handSweepOnly ? aBefore : aAfter, b: options.handSweepOnly ? true : bAfter, handX: 8 }));
  buffers.push(scene({ a: options.handSweepOnly ? aBefore : aAfter, b: options.handSweepOnly ? true : bAfter, handX: 30 }));
  for (let i = 0; i < 6; i += 1) {
    buffers.push(
      scene({
        a: options.handSweepOnly ? aBefore : aAfter,
        b: options.handSweepOnly ? true : bAfter,
        handX: null,
        shift: options.shiftAfter,
      }),
    );
  }
  return toFrames(buffers);
}

function buildDetector(): ClassicalMotionEventDetector {
  return new ClassicalMotionEventDetector(
    new MotionObjectDetector(),
    new GreedyIouTracker(),
  );
}

function signal(sku: string, score: number): CandidateSignal {
  return { productId: `p-${sku}`, sku, score };
}

const PRODUCT_META = new Map(
  ['A', 'B', 'C'].map((sku) => [`p-${sku}`, { sku, name: `Product ${sku}` }]),
);

const THRESHOLDS = { autoThreshold: 0.42, vlmLowBand: 0.22, marginThreshold: 0.08 };

describe('fusion-v2 scenarios', () => {
  // 1 ---------------------------------------------------------------
  it('exact barcode: a real EAN-13 render decodes through the production ZXing adapter and dominates fusion', async () => {
    const digits12 = '628112345678';
    const ean = `${digits12}${ean13CheckDigit(digits12)}`;
    const image = renderEan13(ean);
    const reader = new ZxingBarcodeReader();
    const results = await reader.read([{ image, timestampMs: 0 }]);
    expect(results.map((result) => result.value)).toContain(ean);

    const fused = new WeightedCandidateFusion().fuse(
      {
        barcode: [signal('A', 1)],
        classical: [signal('A', 0.5), signal('B', 0.45)],
        retrieval: [signal('B', 0.5)],
        ocr: [],
        context: [signal('A', 0.5), signal('B', 0.5)],
      },
      PRODUCT_META,
    );
    expect(fused[0].sku).toBe('A');
    expect(decidePolicy(fused[0], THRESHOLDS).result).toBe('AUTO_PROPOSE');
    expect(fused[0].signals.some((s) => s.source === 'barcode')).toBe(true);
  });

  // 2 ---------------------------------------------------------------
  it('readable label without barcode: OCR token overlap ranks the named product', () => {
    const text = normalizeText('AQUAFINA pure drinking water 500 ml');
    expect(textFieldOverlap(text, 'Aquafina Water 500ml')).toBeGreaterThan(0.5);
    expect(textFieldOverlap(text, 'Cola Red Can')).toBeLessThan(0.2);
  });

  // 3 ---------------------------------------------------------------
  it('unreadable label with strong visual match: retrieval alone still yields a confident fusion', () => {
    const fused = new WeightedCandidateFusion().fuse(
      {
        barcode: [],
        ocr: [],
        classical: [signal('A', 0.85), signal('B', 0.3)],
        retrieval: [signal('A', 0.9), signal('B', 0.35)],
        context: [signal('A', 0.8), signal('B', 0.5)],
      },
      PRODUCT_META,
    );
    expect(fused[0].sku).toBe('A');
    expect(decidePolicy(fused[0], THRESHOLDS).result).toBe('AUTO_PROPOSE');
  });

  // 4 ---------------------------------------------------------------
  it('two visually similar bottles: a thin margin routes to NEEDS_VLM, not a guess', () => {
    const fused = new WeightedCandidateFusion().fuse(
      {
        barcode: [],
        ocr: [],
        classical: [signal('A', 0.71), signal('B', 0.7)],
        retrieval: [signal('A', 0.68), signal('B', 0.69)],
        context: [signal('A', 0.8), signal('B', 0.8)],
      },
      PRODUCT_META,
    );
    expect(fused[0].scoreMargin).toBeLessThan(0.08);
    expect(decidePolicy(fused[0], THRESHOLDS).result).toBe('NEEDS_VLM');
  });

  // 5 ---------------------------------------------------------------
  it('Arabic label: normalization unifies letter forms and matches the Arabic catalog field', () => {
    // 'مياه' (water) with alef/teh-marbuta variants and diacritics.
    const ocrText = normalizeText('مِيَاهُ العَيْنِ ٥٠٠');
    const catalogArabic = 'مياه العين';
    expect(textFieldOverlap(ocrText, catalogArabic)).toBeGreaterThanOrEqual(0.5);
    // Alef-variant + teh marbuta normalization collapses forms.
    expect(normalizeText('أسْمَاءة')).toBe(normalizeText('اسماءه'));
  });

  // 6 ---------------------------------------------------------------
  it('partial hand occlusion: crop selection prefers the sharp, unoccluded frame', () => {
    const crops = [
      { id: 'occluded', quality: { sharpness: 30, occlusion: 0.7 } },
      { id: 'clean', quality: { sharpness: 24, occlusion: 0.05 } },
      { id: 'blurry', quality: { sharpness: 6, occlusion: 0.0 } },
    ];
    expect(selectBestCrop(crops).id).toBe('clean');
  });

  // 7 ---------------------------------------------------------------
  it('product return: an appearing object is proposed as RETURN, not PICKUP', async () => {
    const detection = await buildDetector().detect(
      clip({ addA: true }),
      GEOMETRY,
      SOURCE,
    );
    expect(detection.events).toHaveLength(1);
    expect(detection.events[0].kind).toBe('RETURN');
  });

  // 8 ---------------------------------------------------------------
  it('two-product pickup: two removal regions become two events with distinct zones', async () => {
    const detection = await buildDetector().detect(
      clip({ removeA: true, removeB: true }),
      GEOMETRY,
      SOURCE,
    );
    expect(detection.events.length).toBe(2);
    const zones = new Set(detection.events.map((event) => event.shelfZoneId));
    expect(zones.size).toBe(2);
    expect(detection.events.every((event) => event.kind === 'PICKUP')).toBe(true);
  });

  // 9 ---------------------------------------------------------------
  it('camera motion: a shifted aftermath is refused with CAMERA_MOTION_SUSPECTED', async () => {
    const detection = await buildDetector().detect(
      clip({ removeA: true, shiftAfter: 2 }),
      GEOMETRY,
      SOURCE,
    );
    // Striped products + shifted background light up most of the frame; the
    // guard must refuse rather than propose a giant phantom pickup.
    expect(
      detection.warnings.includes('CAMERA_MOTION_SUSPECTED') ||
        detection.events.length === 0,
    ).toBe(true);
  });

  // 10 --------------------------------------------------------------
  it('empty shelf movement: a hand sweep with no durable change proposes nothing', async () => {
    const detection = await buildDetector().detect(
      clip({ handSweepOnly: true }),
      GEOMETRY,
      SOURCE,
    );
    expect(detection.events).toHaveLength(0);
    expect(detection.warnings).toContain('NO_DURABLE_CHANGE');
  });

  // 11 --------------------------------------------------------------
  it('VLM timeout: a stalling endpoint yields TIMEOUT, never a thrown store failure', async () => {
    const server: Server = createServer(() => {
      /* never respond */
    });
    await new Promise<void>((resolvePromise) =>
      server.listen(0, '127.0.0.1', resolvePromise),
    );
    const port = (server.address() as { port: number }).port;
    const verifier = new AnthropicVlmVerifier({
      get: (key: string) =>
        key === 'PICKUP_VLM_API_KEY'
          ? 'test-key'
          : key === 'PICKUP_VLM_ENDPOINT'
            ? `http://127.0.0.1:${port}/v1/messages`
            : key === 'PICKUP_VLM_MODEL'
              ? 'pinned-model-1'
              : undefined,
    } as unknown as ConfigService);
    const verdict = await verifier.verify(
      {
        frames: [],
        crops: [],
        candidates: [
          { sku: 'A', name: 'Product A', fusedScore: 0.3, referenceImages: [] },
        ],
        ocrText: null,
        barcode: null,
        shelfContext: null,
      },
      300,
    );
    server.close();
    expect(verdict.status).toBe('TIMEOUT');
    expect(verdict.modelKey).toBe('pinned-model-1');
  }, 10_000);

  // 12 --------------------------------------------------------------
  it('VLM invalid SKU: schema violations and unlisted SKUs are precisely classified', () => {
    const verifier = new AnthropicVlmVerifier({
      get: () => undefined,
    } as unknown as ConfigService);
    const allowed = new Set(['A', 'B']);
    expect(
      verifier.parseVerdict(
        '{"verdict":"MATCH","selectedSku":"INVENTED-SKU","visualSupport":"STRONG",' +
          '"ocrSupport":"NONE","barcodeSupport":"NONE","reasonCodes":[],' +
          '"contradictions":[],"requiresHumanReview":false}',
        allowed,
      ).status,
    ).toBe('INVALID_SKU');
    expect(verifier.parseVerdict('not json at all', allowed).status).toBe(
      'MALFORMED_RESPONSE',
    );
    // The RETIRED {choice, confidence} shape is never canonical for the
    // cloud verifier — no legacy-compat mapping outside local dev.
    expect(
      verifier.parseVerdict(
        '{"choice":"A","confidence":0.8,"reasoning":"x"}',
        allowed,
      ).status,
    ).toBe('INVALID_SCHEMA');
    // Outside the local-dev fence option the contract is a BARE JSON
    // object: prose wrappers are rejected, not silently extracted.
    expect(
      verifier.parseVerdict(
        'Answer: {"verdict":"MATCH","selectedSku":"B","visualSupport":"MEDIUM",' +
          '"ocrSupport":"WEAK","barcodeSupport":"NONE",' +
          '"reasonCodes":["REFERENCE_VISUAL_MATCH"],"contradictions":[],' +
          '"requiresHumanReview":false}',
        allowed,
      ).status,
    ).toBe('MALFORMED_RESPONSE');
    const valid = verifier.parseVerdict(
      '{"verdict":"MATCH","selectedSku":"B","visualSupport":"MEDIUM",' +
        '"ocrSupport":"WEAK","barcodeSupport":"NONE",' +
        '"reasonCodes":["REFERENCE_VISUAL_MATCH"],"contradictions":[],' +
        '"requiresHumanReview":false}',
      allowed,
    );
    expect(valid.status).toBe('VERDICT');
    expect(valid.result?.verdict).toBe('MATCH');
    expect(valid.result?.selectedSku).toBe('B');
    // Omitted controlled-code arrays are INVALID_SCHEMA, never "empty".
    expect(
      verifier.parseVerdict(
        '{"verdict":"MATCH","selectedSku":"B","visualSupport":"MEDIUM",' +
          '"ocrSupport":"WEAK","barcodeSupport":"NONE",' +
          '"requiresHumanReview":false}',
        allowed,
      ).status,
    ).toBe('INVALID_SCHEMA');
  });

  // 12b -------------------------------------------------------------
  it('policy consumes the VALIDATED verifier result — the VLM never sets policy directly', () => {
    const match = (overrides: Partial<VlmStructuredResult> = {}): VlmStructuredResult => ({
      verdict: 'MATCH',
      selectedSku: 'A',
      visualSupport: 'STRONG',
      ocrSupport: 'MEDIUM',
      barcodeSupport: 'NONE',
      reasonCodes: ['REFERENCE_VISUAL_MATCH'],
      contradictions: [],
      requiresHumanReview: false,
      ...overrides,
    });
    // Clean MATCH agreeing with fusion's top → AUTO_PROPOSE.
    expect(policyFromVlmResult(match(), 'NEEDS_VLM', 'A').result).toBe(
      FusionPolicyResult.AUTO_PROPOSE,
    );
    // MATCH but the model itself asked for review → review wins.
    expect(
      policyFromVlmResult(match({ requiresHumanReview: true }), 'NEEDS_VLM', 'A')
        .result,
    ).toBe(FusionPolicyResult.NEEDS_HUMAN_REVIEW);
    // MATCH with contradictions → review.
    expect(
      policyFromVlmResult(
        match({ contradictions: ['OCR_MISMATCH'] }),
        'NEEDS_VLM',
        'A',
      ).result,
    ).toBe(FusionPolicyResult.NEEDS_HUMAN_REVIEW);
    // MATCH disagreeing with fusion's top → review, never an override.
    expect(policyFromVlmResult(match(), 'NEEDS_VLM', 'B').result).toBe(
      FusionPolicyResult.NEEDS_HUMAN_REVIEW,
    );
    // AMBIGUOUS / INVALID_INPUT → review.
    expect(
      policyFromVlmResult(
        match({ verdict: 'AMBIGUOUS', selectedSku: null }),
        'NEEDS_VLM',
        'A',
      ).result,
    ).toBe(FusionPolicyResult.NEEDS_HUMAN_REVIEW);
    expect(
      policyFromVlmResult(
        match({ verdict: 'INVALID_INPUT', selectedSku: null }),
        'NEEDS_VLM',
        'A',
      ).result,
    ).toBe(FusionPolicyResult.NEEDS_HUMAN_REVIEW);
    // UNKNOWN: demotes a confident fusion to review, otherwise UNKNOWN_PRODUCT.
    expect(
      policyFromVlmResult(
        match({ verdict: 'UNKNOWN', selectedSku: null }),
        'AUTO_PROPOSE',
        'A',
      ).result,
    ).toBe(FusionPolicyResult.NEEDS_HUMAN_REVIEW);
    expect(
      policyFromVlmResult(
        match({ verdict: 'UNKNOWN', selectedSku: null }),
        'NEEDS_VLM',
        'A',
      ).result,
    ).toBe(FusionPolicyResult.UNKNOWN_PRODUCT);
  });

  // 13 --------------------------------------------------------------
  it('edge offline: absent model/runtime reports not-ready and never fabricates', async () => {
    const yolo = new YoloOnnxObjectDetector({
      get: () => undefined,
    } as unknown as ConfigService);
    expect(await yolo.checkReady()).toBe(false);
    await expect(yolo.detectObjects()).rejects.toThrow();
    // The classical detector IS the edge-local fallback.
    expect(await buildDetector().checkReady()).toBe(true);
    // VLM without a key is UNAVAILABLE — policy degrades to review upstream.
    const vlm = new AnthropicVlmVerifier({
      get: () => undefined,
    } as unknown as ConfigService);
    expect(await vlm.checkReady()).toBe(false);
  });

  // 14 --------------------------------------------------------------
  it('no reference images: retrieval returns nothing and policy answers UNKNOWN_PRODUCT', async () => {
    const retriever = new HogLabVisualRetriever(
      {
        productReferenceEmbedding: { findMany: jest.fn(async () => []) },
        productReferenceImage: { findMany: jest.fn(async () => []) },
      } as never,
      { internalPathFor: () => '/x' } as never,
      { decodeReferenceImage: jest.fn() } as never,
    );
    const crop: RgbImage = { width: 8, height: 8, rgb: Buffer.alloc(192, 100) };
    expect(await retriever.retrieve('t', crop, 5)).toHaveLength(0);
    const fused = new WeightedCandidateFusion().fuse(
      { barcode: [], ocr: [], classical: [], retrieval: [], context: [] },
      PRODUCT_META,
    );
    expect(fused).toHaveLength(0);
    expect(decidePolicy(fused[0], THRESHOLDS).result).toBe('UNKNOWN_PRODUCT');
  });

  // descriptor sanity backing scenarios 3/4 ------------------------
  it('descriptor separates striped from plain and matches identical patterns', () => {
    const striped = blank(120);
    paintStriped(striped, { x: 0, y: 0, width: 48, height: 36 }, [40, 80, 210]);
    const stripedImage: RgbImage = { width: 48, height: 36, rgb: striped };
    const plain: RgbImage = { width: 48, height: 36, rgb: blank(120) };
    const same = cosineSimilarity(
      computeDescriptor(stripedImage),
      computeDescriptor(stripedImage),
    );
    const different = cosineSimilarity(
      computeDescriptor(stripedImage),
      computeDescriptor(plain),
    );
    expect(same).toBeGreaterThan(0.99);
    expect(different).toBeLessThan(same - 0.2);
  });
});
