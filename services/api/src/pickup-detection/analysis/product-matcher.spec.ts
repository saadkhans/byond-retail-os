import {
  MATCHER_MODEL_KEY,
  MatchCandidate,
  ReferenceImage,
  RgbImage,
  grayThumbnail,
  histogramIntersection,
  hsvHistogram,
  matchProduct,
  normalizedCrossCorrelation,
  resizeRgb,
  rgbToHsv,
} from './product-matcher';

function solidImage(
  rgb: [number, number, number],
  width = 48,
  height = 48,
): RgbImage {
  const buffer = Buffer.alloc(width * height * 3);
  for (let index = 0; index < width * height; index += 1) {
    buffer[index * 3] = rgb[0];
    buffer[index * 3 + 1] = rgb[1];
    buffer[index * 3 + 2] = rgb[2];
  }
  return { width, height, rgb: buffer };
}

/** Two-color checkerboard — same average color as its inverse, different
 *  spatial structure, so only NCC can tell them apart. */
function checkerboard(
  a: [number, number, number],
  b: [number, number, number],
  invert: boolean,
  cell = 8,
  edge = 48,
): RgbImage {
  const buffer = Buffer.alloc(edge * edge * 3);
  for (let y = 0; y < edge; y += 1) {
    for (let x = 0; x < edge; x += 1) {
      const even = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0;
      const color = even !== invert ? a : b;
      const offset = (y * edge + x) * 3;
      buffer[offset] = color[0];
      buffer[offset + 1] = color[1];
      buffer[offset + 2] = color[2];
    }
  }
  return { width: edge, height: edge, rgb: buffer };
}

const RED: [number, number, number] = [200, 30, 30];
const BLUE: [number, number, number] = [30, 60, 200];
const GREEN: [number, number, number] = [30, 180, 60];

describe('product-matcher primitives', () => {
  it('rgbToHsv maps primaries to their hue sectors', () => {
    expect(Math.round(rgbToHsv(255, 0, 0).h)).toBe(0);
    expect(Math.round(rgbToHsv(0, 255, 0).h)).toBe(120);
    expect(Math.round(rgbToHsv(0, 0, 255).h)).toBe(240);
  });

  it('histogram intersection is 1 for identical images, near 0 for disjoint hues', () => {
    const red = hsvHistogram(solidImage(RED));
    expect(histogramIntersection(red, red)).toBeCloseTo(1, 6);
    const blue = hsvHistogram(solidImage(BLUE));
    expect(histogramIntersection(red, blue)).toBeLessThan(0.05);
  });

  it('NCC separates identical structure from inverted structure', () => {
    const board = grayThumbnail(checkerboard(RED, BLUE, false));
    const same = grayThumbnail(checkerboard(RED, BLUE, false));
    const inverted = grayThumbnail(checkerboard(RED, BLUE, true));
    expect(normalizedCrossCorrelation(board, same)).toBeCloseTo(1, 6);
    expect(normalizedCrossCorrelation(board, inverted)).toBeLessThan(0.1);
  });

  it('resizeRgb preserves solid color exactly', () => {
    const resized = resizeRgb(solidImage(GREEN, 33, 21), 16, 16);
    expect(resized.rgb[0]).toBe(GREEN[0]);
    expect(resized.rgb[resized.rgb.length - 1]).toBe(GREEN[2]);
  });
});

describe('matchProduct', () => {
  const references: ReferenceImage[] = [
    { productId: 'p-red', sku: 'SKU-RED', image: solidImage(RED) },
    { productId: 'p-blue', sku: 'SKU-BLUE', image: solidImage(BLUE) },
    { productId: 'p-green', sku: 'SKU-GREEN', image: solidImage(GREEN) },
  ];

  it('ranks the matching SKU first with a decisively higher score', () => {
    // Solid packaging carries no NCC structure (neutral 0.5), so the
    // color histogram decides: identical color ⇒ 0.75, disjoint ⇒ 0.25.
    const candidates = matchProduct(solidImage(RED), references);
    expect(candidates[0].sku).toBe('SKU-RED');
    expect(candidates[0].score).toBeGreaterThan(0.7);
    expect(candidates[0].score - candidates[1].score).toBeGreaterThan(0.3);
  });

  it('scores a structured identical pair near 1 (histogram AND NCC agree)', () => {
    const board = checkerboard(RED, BLUE, false);
    const structured: ReferenceImage[] = [
      { productId: 'p-board', sku: 'SKU-BOARD', image: board },
      { productId: 'p-green', sku: 'SKU-GREEN', image: solidImage(GREEN) },
    ];
    const candidates = matchProduct(checkerboard(RED, BLUE, false), structured);
    expect(candidates[0].sku).toBe('SKU-BOARD');
    expect(candidates[0].score).toBeGreaterThan(0.95);
  });

  it('keeps the best score across multiple references of one SKU', () => {
    const withVariants: ReferenceImage[] = [
      ...references,
      // A poor second reference must not drag SKU-RED down.
      { productId: 'p-red', sku: 'SKU-RED', image: solidImage(BLUE) },
    ];
    const candidates = matchProduct(solidImage(RED), withVariants);
    const red = candidates.find((c: MatchCandidate) => c.sku === 'SKU-RED')!;
    expect(candidates[0].sku).toBe('SKU-RED');
    expect(red.score).toBeGreaterThan(0.7);
  });

  it('scores an unrelated crop below any sane claim threshold', () => {
    // A dark textured crop resembling none of the catalog: whatever ranks
    // first must score too low to claim — this is the UNKNOWN_PRODUCT path.
    const noise = checkerboard([20, 20, 20], [60, 55, 50], false, 4);
    const candidates = matchProduct(noise, references);
    expect(candidates[0].score).toBeLessThan(0.55);
  });

  it('reports the exact connected matching method', () => {
    expect(MATCHER_MODEL_KEY).toBe('classical-hsv-histogram+ncc');
  });
});
