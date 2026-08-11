/**
 * Phase 10 MVP product recognition — CLASSICAL appearance matching of the
 * picked product's crop against per-SKU reference images. The connected
 * method (reported verbatim in the UI/job record as the model key) is:
 *
 *   `classical-hsv-histogram+ncc`
 *
 * Two complementary, real signals, combined 50/50:
 *
 * - HSV HISTOGRAM INTERSECTION (8H x 4S x 4V bins, L1-normalized): color
 *   identity, robust to small shifts and scale.
 * - NORMALIZED CROSS-CORRELATION over a 32x32 mean-centered grayscale
 *   thumbnail: spatial structure, so two same-colored SKUs with different
 *   artwork still separate.
 *
 * The combined score IS the recognition confidence (0..1). Below the
 * configured threshold the pipeline claims NOTHING (UNKNOWN_PRODUCT) — a
 * weak best-match is not an identification. No filename, SKU text, or any
 * non-pixel signal participates.
 *
 * Pure TypeScript over RGB24 buffers — deterministic and unit-testable.
 */

export interface RgbImage {
  width: number;
  height: number;
  /** Tightly packed RGB24, length = width * height * 3. */
  rgb: Buffer;
}

export interface ReferenceImage {
  productId: string;
  sku: string;
  image: RgbImage;
}

export interface MatchCandidate {
  productId: string;
  sku: string;
  /** Combined confidence in [0, 1]. */
  score: number;
}

export const MATCHER_MODEL_KEY = 'classical-hsv-histogram+ncc';
export const MATCHER_MODEL_VERSION = '1.0.0';

const HIST_H_BINS = 8;
const HIST_S_BINS = 4;
const HIST_V_BINS = 4;
const NCC_EDGE = 32;

/** Extract a sub-image; the box is clamped to the source bounds. */
export function cropRgb(
  source: RgbImage,
  box: { x: number; y: number; width: number; height: number },
): RgbImage {
  const x = Math.max(0, Math.min(box.x, source.width - 1));
  const y = Math.max(0, Math.min(box.y, source.height - 1));
  const width = Math.max(1, Math.min(box.width, source.width - x));
  const height = Math.max(1, Math.min(box.height, source.height - y));
  const out = Buffer.alloc(width * height * 3);
  for (let row = 0; row < height; row += 1) {
    const from = ((y + row) * source.width + x) * 3;
    source.rgb.copy(out, row * width * 3, from, from + width * 3);
  }
  return { width, height, rgb: out };
}

/** Nearest-neighbour resample — deterministic, dependency-free. */
export function resizeRgb(source: RgbImage, width: number, height: number): RgbImage {
  const out = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    const sy = Math.min(
      source.height - 1,
      Math.floor((y * source.height) / height),
    );
    for (let x = 0; x < width; x += 1) {
      const sx = Math.min(
        source.width - 1,
        Math.floor((x * source.width) / width),
      );
      const from = (sy * source.width + sx) * 3;
      const to = (y * width + x) * 3;
      out[to] = source.rgb[from];
      out[to + 1] = source.rgb[from + 1];
      out[to + 2] = source.rgb[from + 2];
    }
  }
  return { width, height, rgb: out };
}

/** RGB (0..255) -> HSV with h in [0,360), s and v in [0,1]. */
export function rgbToHsv(
  r: number,
  g: number,
  b: number,
): { h: number; s: number; v: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  let h = 0;
  if (delta > 0) {
    if (max === rn) {
      h = 60 * (((gn - bn) / delta) % 6);
    } else if (max === gn) {
      h = 60 * ((bn - rn) / delta + 2);
    } else {
      h = 60 * ((rn - gn) / delta + 4);
    }
  }
  if (h < 0) {
    h += 360;
  }
  return { h, s: max === 0 ? 0 : delta / max, v: max };
}

/** L1-normalized HSV histogram (HIST_H_BINS x HIST_S_BINS x HIST_V_BINS). */
export function hsvHistogram(image: RgbImage): Float64Array {
  const bins = new Float64Array(HIST_H_BINS * HIST_S_BINS * HIST_V_BINS);
  const pixels = image.width * image.height;
  for (let index = 0; index < pixels; index += 1) {
    const offset = index * 3;
    const { h, s, v } = rgbToHsv(
      image.rgb[offset],
      image.rgb[offset + 1],
      image.rgb[offset + 2],
    );
    const hBin = Math.min(HIST_H_BINS - 1, Math.floor((h / 360) * HIST_H_BINS));
    const sBin = Math.min(HIST_S_BINS - 1, Math.floor(s * HIST_S_BINS));
    const vBin = Math.min(HIST_V_BINS - 1, Math.floor(v * HIST_V_BINS));
    bins[(hBin * HIST_S_BINS + sBin) * HIST_V_BINS + vBin] += 1;
  }
  if (pixels > 0) {
    for (let index = 0; index < bins.length; index += 1) {
      bins[index] /= pixels;
    }
  }
  return bins;
}

/** Histogram intersection of two L1-normalized histograms — in [0, 1]. */
export function histogramIntersection(
  a: Float64Array,
  b: Float64Array,
): number {
  let total = 0;
  for (let index = 0; index < a.length; index += 1) {
    total += Math.min(a[index], b[index]);
  }
  return total;
}

/** Mean-centered grayscale thumbnail for NCC. */
export function grayThumbnail(image: RgbImage): Float64Array {
  const resized = resizeRgb(image, NCC_EDGE, NCC_EDGE);
  const out = new Float64Array(NCC_EDGE * NCC_EDGE);
  let mean = 0;
  for (let index = 0; index < out.length; index += 1) {
    const offset = index * 3;
    const gray =
      0.299 * resized.rgb[offset] +
      0.587 * resized.rgb[offset + 1] +
      0.114 * resized.rgb[offset + 2];
    out[index] = gray;
    mean += gray;
  }
  mean /= out.length;
  for (let index = 0; index < out.length; index += 1) {
    out[index] -= mean;
  }
  return out;
}

/** Normalized cross-correlation of two mean-centered signals, mapped from
 *  [-1, 1] to [0, 1] (anti-correlation is as much a non-match as noise).
 *
 *  DEGENERATE INPUTS: a (near-)constant image carries no spatial structure
 *  to correlate — and floating-point dust from the mean subtraction would
 *  otherwise make two solids correlate at exactly ±1. Structure-free
 *  comparisons return NEUTRAL 0.5, leaving the verdict to the color
 *  histogram (solid packaging is identified by color, honestly). */
export function normalizedCrossCorrelation(
  a: Float64Array,
  b: Float64Array,
): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  // Mean energy under 1 gray-level² ≈ no real structure (see doc above).
  const epsilon = a.length;
  if (normA < epsilon || normB < epsilon) {
    return 0.5;
  }
  const ncc = dot / Math.sqrt(normA * normB);
  return Math.max(0, Math.min(1, (ncc + 1) / 2));
}

/**
 * Score one crop against every reference image; return candidates ranked
 * by the best score any of the SKU's references achieved. Multiple
 * references per SKU are welcome — the max is the SKU's score.
 */
export function matchProduct(
  crop: RgbImage,
  references: ReferenceImage[],
): MatchCandidate[] {
  const cropHistogram = hsvHistogram(crop);
  const cropThumb = grayThumbnail(crop);
  const bestByProduct = new Map<string, MatchCandidate>();
  for (const reference of references) {
    const histScore = histogramIntersection(
      cropHistogram,
      hsvHistogram(reference.image),
    );
    const nccScore = normalizedCrossCorrelation(
      cropThumb,
      grayThumbnail(reference.image),
    );
    const score = 0.5 * histScore + 0.5 * nccScore;
    const current = bestByProduct.get(reference.productId);
    if (!current || score > current.score) {
      bestByProduct.set(reference.productId, {
        productId: reference.productId,
        sku: reference.sku,
        score,
      });
    }
  }
  return [...bestByProduct.values()].sort((a, b) => b.score - a.score);
}
