import { EmbeddingImageInput } from './local-vision-runtime.port';

/**
 * PURE image preparation for the local embedding worker: the worker only
 * normalizes and encodes, so every input arrives here as an exact square
 * of the model's input size, aspect preserved and padded on a neutral
 * grey (the same 114 grey Ultralytics letterboxes with).
 */

export const LETTERBOX_FILL = 114;

/** Nearest-neighbour resample — deterministic, dependency-free (mirrors
 *  the pickup-detection matcher's resizeRgb without importing it, so this
 *  module stays free of any media/analysis import). */
export function resizeNearest(
  source: EmbeddingImageInput,
  width: number,
  height: number,
): EmbeddingImageInput {
  const out = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    const sy = Math.min(source.height - 1, Math.floor((y * source.height) / height));
    for (let x = 0; x < width; x += 1) {
      const sx = Math.min(source.width - 1, Math.floor((x * source.width) / width));
      const from = (sy * source.width + sx) * 3;
      const to = (y * width + x) * 3;
      out[to] = source.rgb[from];
      out[to + 1] = source.rgb[from + 1];
      out[to + 2] = source.rgb[from + 2];
    }
  }
  return { width, height, rgb: out };
}

/** True when the buffer length matches the declared geometry. */
export function isWellFormedImage(image: EmbeddingImageInput): boolean {
  return (
    Number.isInteger(image.width) &&
    Number.isInteger(image.height) &&
    image.width > 0 &&
    image.height > 0 &&
    Buffer.isBuffer(image.rgb) &&
    image.rgb.length === image.width * image.height * 3
  );
}

/**
 * Aspect-preserving fit into an `edge` x `edge` square, centred, padded
 * with LETTERBOX_FILL. Never upscales beyond the edge; a source already
 * square at the edge is copied through untouched.
 */
export function letterboxSquare(
  source: EmbeddingImageInput,
  edge: number,
  fill: number = LETTERBOX_FILL,
): EmbeddingImageInput {
  if (source.width === edge && source.height === edge) {
    return { width: edge, height: edge, rgb: Buffer.from(source.rgb) };
  }
  const scale = Math.min(edge / source.width, edge / source.height);
  const fitWidth = Math.max(1, Math.round(source.width * scale));
  const fitHeight = Math.max(1, Math.round(source.height * scale));
  const fitted = resizeNearest(source, fitWidth, fitHeight);
  const out = Buffer.alloc(edge * edge * 3, fill);
  const offsetX = Math.floor((edge - fitWidth) / 2);
  const offsetY = Math.floor((edge - fitHeight) / 2);
  for (let row = 0; row < fitHeight; row += 1) {
    const from = row * fitWidth * 3;
    const to = ((offsetY + row) * edge + offsetX) * 3;
    fitted.rgb.copy(out, to, from, from + fitWidth * 3);
  }
  return { width: edge, height: edge, rgb: out };
}

/** L2-normalize a vector in place semantics (returns a new array); a
 *  zero vector stays zero. */
export function l2Normalize(vector: readonly number[]): number[] {
  let sum = 0;
  for (const value of vector) {
    sum += value * value;
  }
  const norm = Math.sqrt(sum);
  if (!(norm > 0)) {
    return vector.map(() => 0);
  }
  return vector.map((value) => value / norm);
}
