import { RgbImage } from '../../pickup-detection/analysis/product-matcher';
import { QualifiedCrop, VlmRequestEvidence } from '../ports';
import {
  COMPARATIVE_MAX_CANDIDATES,
  DEFAULT_REFERENCES_PER_CANDIDATE,
  MIN_CROP_EDGE,
  buildPromptParts,
  enlargeCrop,
  maxImagesForContext,
  planPromptImages,
  referencesPerCandidateFromConfig,
} from './vlm-shared';

function rgb(width: number, height: number, fill = 0x80): RgbImage {
  return { width, height, rgb: Buffer.alloc(width * height * 3, fill) };
}

function crop(phase: QualifiedCrop['phase'], image: RgbImage): QualifiedCrop {
  return {
    phase,
    timestampMs: phase === 'pre' ? 1000 : phase === 'peak' ? 2000 : 3000,
    box: { x: 0, y: 0, width: image.width, height: image.height },
    image,
    quality: { sharpness: 10, occlusion: 0, brightness: 128 },
  } as QualifiedCrop;
}

function evidence(options: {
  candidates?: number;
  referencesEach?: number;
  frames?: number;
  withCrop?: boolean;
} = {}): VlmRequestEvidence {
  const candidates = options.candidates ?? 2;
  const referencesEach = options.referencesEach ?? 3;
  const frames = options.frames ?? 3;
  const phases: QualifiedCrop['phase'][] = ['pre', 'peak', 'post'];
  return {
    frames: phases.slice(0, frames).map((phase) => ({ phase, image: rgb(8, 8) })),
    crops: options.withCrop === false ? [] : [crop('pre', rgb(8, 8)), crop('peak', rgb(40, 60)), crop('post', rgb(8, 8))],
    candidates: Array.from({ length: candidates }, (_row, index) => ({
      sku: `SKU-${index + 1}`,
      name: `Product ${index + 1}`,
      fusedScore: 0.3 - index * 0.02,
      referenceImages: Array.from({ length: referencesEach }, () => rgb(6, 6)),
    })),
    ocrText: null,
    barcode: null,
    shelfContext: null,
  };
}

describe('referencesPerCandidateFromConfig', () => {
  it('defaults to 3 and accepts 1..4', () => {
    expect(referencesPerCandidateFromConfig(undefined)).toBe(DEFAULT_REFERENCES_PER_CANDIDATE);
    expect(referencesPerCandidateFromConfig('  ')).toBe(DEFAULT_REFERENCES_PER_CANDIDATE);
    for (const ok of ['1', '2', '3', '4']) {
      expect(referencesPerCandidateFromConfig(ok)).toBe(Number(ok));
    }
  });

  it('fails loudly outside the safe range or on non-integers', () => {
    for (const bad of ['0', '5', '-1', '2.5', 'three']) {
      expect(() => referencesPerCandidateFromConfig(bad)).toThrow(
        /PICKUP_VLM_REFERENCES_PER_CANDIDATE.*outside its safe range/,
      );
    }
  });
});

describe('maxImagesForContext', () => {
  it('derives an image cap from num_ctx and never drops below 2', () => {
    // 1100 measured tokens per image (qwen2.5-vl under Ollama) + 1024 text.
    expect(maxImagesForContext(8192)).toBe(6);
    expect(maxImagesForContext(16384)).toBe(13);
    expect(maxImagesForContext(4096)).toBe(2);
    expect(maxImagesForContext(512)).toBe(2);
    // A cheaper vision encoder can be declared per deployment.
    expect(maxImagesForContext(8192, 768)).toBe(9);
  });
});

describe('planPromptImages (context budget)', () => {
  it('sends every frame, the crop, and 3 references per candidate when the budget allows', () => {
    const plan = planPromptImages(evidence(), { referencesPerCandidate: 3, maxImages: 20 });
    expect(plan).toEqual({ frameCount: 3, includeCrop: true, referencesPerCandidate: 3, total: 10 });
  });

  it('reduces references per candidate FIRST, then the crop, then frames from the end', () => {
    const three = evidence({ candidates: 3, referencesEach: 3 }); // 3 frames + crop + 9 refs = 13
    expect(planPromptImages(three, { referencesPerCandidate: 3, maxImages: 10 })).toEqual({
      frameCount: 3,
      includeCrop: true,
      referencesPerCandidate: 2,
      total: 10,
    });
    expect(planPromptImages(three, { referencesPerCandidate: 3, maxImages: 7 })).toEqual({
      frameCount: 3,
      includeCrop: true,
      referencesPerCandidate: 1,
      total: 7,
    });
    // One reference each no longer fits with the crop: the crop goes next.
    expect(planPromptImages(three, { referencesPerCandidate: 3, maxImages: 6 })).toEqual({
      frameCount: 3,
      includeCrop: false,
      referencesPerCandidate: 1,
      total: 6,
    });
    // Then frames from the end; the pre frame is always kept.
    expect(planPromptImages(three, { referencesPerCandidate: 3, maxImages: 4 })).toEqual({
      frameCount: 1,
      includeCrop: false,
      referencesPerCandidate: 1,
      total: 4,
    });
  });

  it('counts only the references a candidate actually has', () => {
    const sparse = evidence({ candidates: 2, referencesEach: 1 });
    expect(planPromptImages(sparse, { referencesPerCandidate: 3, maxImages: 20 }).total).toBe(6);
  });

  it('clamps the requested references to 1..4', () => {
    expect(planPromptImages(evidence({ referencesEach: 4 }), { referencesPerCandidate: 9 }).referencesPerCandidate).toBe(4);
    expect(planPromptImages(evidence(), { referencesPerCandidate: 0 }).referencesPerCandidate).toBe(1);
  });
});

describe('enlargeCrop', () => {
  it('upsamples a small crop so its short edge reaches the minimum, never downsamples', () => {
    const small = enlargeCrop(rgb(40, 60));
    expect(Math.min(small.width, small.height)).toBeGreaterThanOrEqual(MIN_CROP_EDGE);
    expect(small.width / small.height).toBeCloseTo(40 / 60, 5);
    const big = rgb(300, 400);
    expect(enlargeCrop(big)).toBe(big);
  });
});

describe('buildPromptParts', () => {
  it('orders images frames → enlarged product crop → references grouped per candidate, and reports the counts', () => {
    const parts = buildPromptParts(evidence({ candidates: 2, referencesEach: 3 }), {
      referencesPerCandidate: 3,
      maxImages: 20,
    });
    expect(parts.images.map((image) => image.label)).toEqual([
      'Video frame (pre)',
      'Video frame (peak)',
      'Video frame (post)',
      'Product crop (peak instant, enlarged)',
      'Reference image 1 for candidate SKU-1',
      'Reference image 2 for candidate SKU-1',
      'Reference image 3 for candidate SKU-1',
      'Reference image 1 for candidate SKU-2',
      'Reference image 2 for candidate SKU-2',
      'Reference image 3 for candidate SKU-2',
    ]);
    expect(parts.imagesSent).toBe(10);
    expect(parts.referencesPerCandidate).toBe(3);
    expect(parts.instruction).toContain('the next image is an enlarged crop of the product');
    expect(parts.instruction).toContain('up to 3 per candidate');
  });

  it('asks the COMPARATIVE question for small candidate sets and the open one otherwise', () => {
    const scoped = buildPromptParts(evidence({ candidates: COMPARATIVE_MAX_CANDIDATES }));
    expect(scoped.instruction).toContain(
      `Which ONE of these ${COMPARATIVE_MAX_CANDIDATES} products is being taken in the event images?`,
    );
    expect(scoped.instruction).toContain('or NONE if none matches');
    const open = buildPromptParts(evidence({ candidates: COMPARATIVE_MAX_CANDIDATES + 1 }));
    expect(open.instruction).toContain('Which candidate product was picked up?');
    expect(open.instruction).not.toContain('Which ONE of these');
  });

  it('keeps the strict schema and SKU whitelist in both prompt variants', () => {
    for (const parts of [
      buildPromptParts(evidence({ candidates: 2 })),
      buildPromptParts(evidence({ candidates: 5 })),
    ]) {
      expect(parts.instruction).toContain('"verdict": "MATCH"|"AMBIGUOUS"|"UNKNOWN"|"INVALID_INPUT"');
      expect(parts.instruction).toContain('"visualSupport": "STRONG"|"MEDIUM"|"WEAK"|"NONE"');
      expect(parts.instruction).toContain('it MUST be exactly one of: SKU-1, SKU-2');
    }
  });

  it('omits the crop image and its sentence when no crop is available', () => {
    const parts = buildPromptParts(evidence({ withCrop: false }));
    expect(parts.images.some((image) => image.label.startsWith('Product crop'))).toBe(false);
    expect(parts.instruction).not.toContain('enlarged crop');
  });

  it('honours the budget in the images it actually sends', () => {
    const parts = buildPromptParts(evidence({ candidates: 3, referencesEach: 3 }), {
      referencesPerCandidate: 3,
      maxImages: 7,
    });
    expect(parts.images).toHaveLength(7);
    expect(parts.imagesSent).toBe(7);
    expect(parts.referencesPerCandidate).toBe(1);
    expect(parts.images.filter((image) => image.label.startsWith('Reference image'))).toHaveLength(3);
  });
});

describe('referencesPerCandidateFromConfig — validated numeric form', () => {
  it('accepts the validated numeric form (env.validation converts the key to a number)', () => {
    expect(referencesPerCandidateFromConfig(2)).toBe(2);
    expect(referencesPerCandidateFromConfig('2')).toBe(2);
    expect(referencesPerCandidateFromConfig(undefined)).toBe(3);
    expect(referencesPerCandidateFromConfig('')).toBe(3);
    expect(() => referencesPerCandidateFromConfig(9)).toThrow(/safe range/);
  });
});
