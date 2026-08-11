/**
 * Pure, dependency-free primitives for pickup-fusion-v2. Everything here
 * is deterministic math over RGB buffers or strings — unit-testable
 * without any tooling.
 */

import { AnalysisGeometry, BoundingBox } from '../pickup-detection/analysis/pickup-analyzer';
import { RgbImage, resizeRgb, rgbToHsv } from '../pickup-detection/analysis/product-matcher';

// ------------------------------------------------------------ descriptor

export const EMBEDDING_MODEL_KEY = 'hog-lab-v1';
export const EMBEDDING_MODEL_VERSION = '1.0.0';
/** 8x8 cells x 8 orientation bins + 3x(4x4) Lab means = 512 + 48. */
export const EMBEDDING_DIMENSIONS = 8 * 8 * 8 + 3 * 4 * 4;

/**
 * Real visual descriptor, computed in pure TS: gradient-orientation
 * histograms (HOG-style, 8x8 cells, 8 bins, on a 64x64 gray patch) plus
 * coarse 4x4 Lab-approximate color means. L2-normalized. Deliberately
 * DIFFERENT information than the HSV+NCC classical matcher (gradients vs
 * global histogram) so fusion combines genuinely distinct signals. The
 * CLIP/DINO upgrade path replaces this via VisualRetriever registration —
 * vectors are versioned per model key.
 */
export function computeDescriptor(image: RgbImage): Float64Array {
  const edge = 64;
  const resized = resizeRgb(image, edge, edge);
  const gray = new Float64Array(edge * edge);
  for (let index = 0; index < edge * edge; index += 1) {
    gray[index] =
      0.299 * resized.rgb[index * 3] +
      0.587 * resized.rgb[index * 3 + 1] +
      0.114 * resized.rgb[index * 3 + 2];
  }
  const cells = 8;
  const bins = 8;
  const cellSize = edge / cells;
  const hog = new Float64Array(cells * cells * bins);
  for (let y = 1; y < edge - 1; y += 1) {
    for (let x = 1; x < edge - 1; x += 1) {
      const gx = gray[y * edge + x + 1] - gray[y * edge + x - 1];
      const gy = gray[(y + 1) * edge + x] - gray[(y - 1) * edge + x];
      const magnitude = Math.sqrt(gx * gx + gy * gy);
      if (magnitude === 0) continue;
      let angle = Math.atan2(gy, gx);
      if (angle < 0) angle += Math.PI;
      const bin = Math.min(bins - 1, Math.floor((angle / Math.PI) * bins));
      const cellX = Math.min(cells - 1, Math.floor(x / cellSize));
      const cellY = Math.min(cells - 1, Math.floor(y / cellSize));
      hog[(cellY * cells + cellX) * bins + bin] += magnitude;
    }
  }
  // Coarse color: 4x4 grid of mean R/G/B (Lab-approximate weighting via
  // the same luma transform keeps this cheap and deterministic).
  const colorGrid = 4;
  const color = new Float64Array(colorGrid * colorGrid * 3);
  const counts = new Float64Array(colorGrid * colorGrid);
  for (let y = 0; y < edge; y += 1) {
    for (let x = 0; x < edge; x += 1) {
      const cx = Math.min(colorGrid - 1, Math.floor((x / edge) * colorGrid));
      const cy = Math.min(colorGrid - 1, Math.floor((y / edge) * colorGrid));
      const cell = cy * colorGrid + cx;
      color[cell * 3] += resized.rgb[(y * edge + x) * 3];
      color[cell * 3 + 1] += resized.rgb[(y * edge + x) * 3 + 1];
      color[cell * 3 + 2] += resized.rgb[(y * edge + x) * 3 + 2];
      counts[cell] += 1;
    }
  }
  for (let cell = 0; cell < colorGrid * colorGrid; cell += 1) {
    color[cell * 3] /= counts[cell] * 255;
    color[cell * 3 + 1] /= counts[cell] * 255;
    color[cell * 3 + 2] /= counts[cell] * 255;
  }
  const vector = new Float64Array(EMBEDDING_DIMENSIONS);
  vector.set(hog, 0);
  vector.set(color, hog.length);
  let norm = 0;
  for (let index = 0; index < vector.length; index += 1) {
    norm += vector[index] * vector[index];
  }
  norm = Math.sqrt(norm) || 1;
  for (let index = 0; index < vector.length; index += 1) {
    vector[index] /= norm;
  }
  return vector;
}

/** Cosine similarity of two L2-normalized vectors, clamped to [0, 1]. */
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    dot += a[index] * b[index];
  }
  return Math.max(0, Math.min(1, dot));
}

// ------------------------------------------------------------ crop quality

/** Mean gradient magnitude — a standard sharpness proxy. */
export function sharpness(image: RgbImage): number {
  const edge = 64;
  const resized = resizeRgb(image, edge, edge);
  let total = 0;
  for (let y = 1; y < edge - 1; y += 1) {
    for (let x = 1; x < edge - 1; x += 1) {
      const at = (yy: number, xx: number) => {
        const off = (yy * edge + xx) * 3;
        return (
          0.299 * resized.rgb[off] +
          0.587 * resized.rgb[off + 1] +
          0.114 * resized.rgb[off + 2]
        );
      };
      total += Math.abs(at(y, x + 1) - at(y, x - 1)) + Math.abs(at(y + 1, x) - at(y - 1, x));
    }
  }
  return total / ((edge - 2) * (edge - 2));
}

export function meanBrightness(image: RgbImage): number {
  let total = 0;
  for (let index = 0; index < image.rgb.length; index += 1) {
    total += image.rgb[index];
  }
  return image.rgb.length === 0 ? 0 : total / image.rgb.length;
}

/** Fraction of box pixels that differ strongly from a quiet reference —
 *  the hand-over-product occlusion estimate for that instant. */
export function occlusionFraction(
  frame: Buffer,
  quiet: Buffer,
  geometry: AnalysisGeometry,
  box: BoundingBox,
  threshold = 40,
): number {
  let changed = 0;
  let total = 0;
  for (let y = box.y; y < box.y + box.height; y += 1) {
    for (let x = box.x; x < box.x + box.width; x += 1) {
      if (x < 0 || y < 0 || x >= geometry.width || y >= geometry.height) continue;
      const off = (y * geometry.width + x) * 3;
      const delta = Math.max(
        Math.abs(frame[off] - quiet[off]),
        Math.abs(frame[off + 1] - quiet[off + 1]),
        Math.abs(frame[off + 2] - quiet[off + 2]),
      );
      total += 1;
      if (delta > threshold) changed += 1;
    }
  }
  return total === 0 ? 0 : changed / total;
}

/** Crop selection rule (requirement 4): sharpest with least occlusion. */
export function selectBestCrop<
  T extends { quality: { sharpness: number; occlusion: number } },
>(crops: T[]): T {
  return crops.reduce((best, crop) =>
    crop.quality.sharpness * (1 - crop.quality.occlusion) >
    best.quality.sharpness * (1 - best.quality.occlusion)
      ? crop
      : best,
  );
}

// ------------------------------------------------------------ regions

/**
 * Split a changed-pixel mask into connected components (4-neighbour BFS)
 * and return each component's bounding box — the multi-product upgrade
 * over v1's single global box.
 */
export function connectedRegions(
  mask: Uint8Array,
  geometry: AnalysisGeometry,
  minPixels: number,
): BoundingBox[] {
  const visited = new Uint8Array(mask.length);
  const boxes: BoundingBox[] = [];
  const queue: number[] = [];
  for (let start = 0; start < mask.length; start += 1) {
    if (mask[start] === 0 || visited[start] === 1) continue;
    let minX = geometry.width;
    let minY = geometry.height;
    let maxX = -1;
    let maxY = -1;
    let count = 0;
    queue.length = 0;
    queue.push(start);
    visited[start] = 1;
    while (queue.length > 0) {
      const index = queue.pop() as number;
      const x = index % geometry.width;
      const y = Math.floor(index / geometry.width);
      count += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const neighbours = [index - 1, index + 1, index - geometry.width, index + geometry.width];
      for (const neighbour of neighbours) {
        if (
          neighbour >= 0 &&
          neighbour < mask.length &&
          mask[neighbour] === 1 &&
          visited[neighbour] === 0 &&
          Math.abs((neighbour % geometry.width) - x) <= 1
        ) {
          visited[neighbour] = 1;
          queue.push(neighbour);
        }
      }
    }
    if (count >= minPixels) {
      boxes.push({ x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 });
    }
  }
  return boxes.sort((a, b) => b.width * b.height - a.width * a.height);
}

/** Coarse 3x3 planogram zone id for a box centre ('zone-r1c2'). */
export function shelfZoneFor(box: BoundingBox, geometry: AnalysisGeometry): string {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const col = Math.min(2, Math.floor((cx / geometry.width) * 3));
  const row = Math.min(2, Math.floor((cy / geometry.height) * 3));
  return `zone-r${row + 1}c${col + 1}`;
}

// ------------------------------------------------------------ text

const ARABIC_DIACRITICS = /[ؐ-ًؚ-ٰٟۖ-ۜ۟-۪ۨ-ۭ]/g;

/**
 * Normalize OCR text for catalog comparison: case-fold and strip
 * punctuation for Latin; for Arabic remove diacritics, unify alef/teh
 * marbuta/yeh variants, and strip tatweel — the standard normalizations
 * for matching label text against catalog fields.
 */
export function normalizeText(raw: string): string {
  return raw
    .replace(ARABIC_DIACRITICS, '')
    .replace(/ـ/g, '') // tatweel
    .replace(/[آأإ]/g, 'ا') // alef variants → alef
    .replace(/ة/g, 'ه') // teh marbuta → heh
    .replace(/ى/g, 'ي') // alef maqsura → yeh
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Token-level overlap of normalized OCR text against one catalog field —
 *  fraction of the FIELD's tokens found in the text (order-free). */
export function textFieldOverlap(normalizedText: string, field: string): number {
  const fieldTokens = normalizeText(field).split(' ').filter((token) => token.length > 1);
  if (fieldTokens.length === 0) return 0;
  const textTokens = new Set(normalizedText.split(' '));
  const hits = fieldTokens.filter((token) => textTokens.has(token)).length;
  return hits / fieldTokens.length;
}

// ------------------------------------------------------------ EAN-13 (test fixture generator)

const EAN_L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const EAN_G = EAN_L.map((p) => p.split('').reverse().map((b) => (b === '0' ? '1' : '0')).join(''));
const EAN_R = EAN_L.map((p) => p.split('').map((b) => (b === '0' ? '1' : '0')).join(''));
const EAN_PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

export function ean13CheckDigit(digits12: string): number {
  let sum = 0;
  for (let index = 0; index < 12; index += 1) {
    sum += Number(digits12[index]) * (index % 2 === 0 ? 1 : 3);
  }
  return (10 - (sum % 10)) % 10;
}

/**
 * Render a REAL, spec-correct EAN-13 barcode as an RGB image (white
 * background, black modules) — the exact-barcode test scenario decodes
 * this with the production ZXing adapter, so the test exercises the real
 * decode path, not a mock.
 */
export function renderEan13(digits13: string, moduleWidth = 4, height = 120): RgbImage {
  if (!/^\d{13}$/.test(digits13)) {
    throw new Error('EAN-13 requires exactly 13 digits');
  }
  const parity = EAN_PARITY[Number(digits13[0])];
  let modules = '101';
  for (let index = 1; index <= 6; index += 1) {
    const digit = Number(digits13[index]);
    modules += parity[index - 1] === 'L' ? EAN_L[digit] : EAN_G[digit];
  }
  modules += '01010';
  for (let index = 7; index <= 12; index += 1) {
    modules += EAN_R[Number(digits13[index])];
  }
  modules += '101';
  const quiet = 10;
  const width = (modules.length + quiet * 2) * moduleWidth;
  const rgb = Buffer.alloc(width * height * 3, 255);
  for (let m = 0; m < modules.length; m += 1) {
    if (modules[m] !== '1') continue;
    for (let dx = 0; dx < moduleWidth; dx += 1) {
      const x = (quiet + m) * moduleWidth + dx;
      for (let y = 0; y < height; y += 1) {
        const off = (y * width + x) * 3;
        rgb[off] = 0;
        rgb[off + 1] = 0;
        rgb[off + 2] = 0;
      }
    }
  }
  return { width, height, rgb };
}

// ------------------------------------------------------------ misc

export function meanSaturation(image: RgbImage): number {
  let total = 0;
  const pixels = image.width * image.height;
  for (let index = 0; index < pixels; index += 1) {
    total += rgbToHsv(
      image.rgb[index * 3],
      image.rgb[index * 3 + 1],
      image.rgb[index * 3 + 2],
    ).s;
  }
  return pixels === 0 ? 0 : total / pixels;
}
