import {
  AnalysisFrame,
  AnalysisGeometry,
  BoundingBox,
} from '../../pickup-detection/analysis/pickup-analyzer';

/**
 * LOCALIZED motion timeline — the fallback signal for clips where the
 * global mean-absolute-difference baseline is inflated by frame-wide
 * nuisance motion (handheld shake, an animated display in shot, glass
 * reflections) so a small hand never reaches the peak/baseline ratio the
 * event finder requires.
 *
 * Method: partition every consecutive-frame difference into a grid×grid
 * lattice of cells, take each cell's mean absolute RGB difference, then
 * subtract that cell's TEMPORAL MEDIAN across all transitions (clamped at
 * zero). Permanently busy regions (an ad screen) are thereby flattened to
 * their own noise floor, while a hand passing through an otherwise quiet
 * cell stands out. The timeline value per transition is the maximum
 * residual over cells; the arg-max cell is reported alongside so callers
 * can localize the event.
 *
 * Pure arithmetic over RGB24 buffers, deterministic, no allocation beyond
 * one grid² accumulator per transition (frames are analysis-sized).
 */

export interface GridCell {
  row: number;
  col: number;
}

export interface LocalizedMotion {
  /** Baseline-subtracted peak cell residual per transition i → i+1. */
  timeline: number[];
  /** The cell carrying that peak residual, per transition. */
  peakCells: GridCell[];
}

export const DEFAULT_MOTION_GRID = 8;

export function localizedMotionTimeline(
  frames: AnalysisFrame[],
  geometry: AnalysisGeometry,
  grid: number = DEFAULT_MOTION_GRID,
): LocalizedMotion {
  const cells = Math.max(1, Math.floor(grid));
  const { width, height } = geometry;
  const transitions = Math.max(0, frames.length - 1);
  if (transitions === 0 || width <= 0 || height <= 0) {
    return { timeline: [], peakCells: [] };
  }
  // Column / row index per pixel coordinate — integer partition that
  // handles dimensions not divisible by the grid (the last cells absorb
  // the remainder).
  const colOf = new Uint16Array(width);
  for (let x = 0; x < width; x += 1) {
    colOf[x] = Math.min(cells - 1, Math.floor((x * cells) / width));
  }
  const rowOf = new Uint16Array(height);
  for (let y = 0; y < height; y += 1) {
    rowOf[y] = Math.min(cells - 1, Math.floor((y * cells) / height));
  }
  const counts = new Float64Array(cells * cells);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      counts[rowOf[y] * cells + colOf[x]] += 3;
    }
  }
  const perTransition: Float64Array[] = [];
  for (let t = 0; t < transitions; t += 1) {
    const a = frames[t].rgb;
    const b = frames[t + 1].rgb;
    const sums = new Float64Array(cells * cells);
    const length = Math.min(a.length, b.length, width * height * 3);
    for (let y = 0; y < height; y += 1) {
      const rowBase = rowOf[y] * cells;
      for (let x = 0; x < width; x += 1) {
        const off = (y * width + x) * 3;
        if (off + 2 >= length) break;
        const cell = rowBase + colOf[x];
        sums[cell] +=
          Math.abs(a[off] - b[off]) +
          Math.abs(a[off + 1] - b[off + 1]) +
          Math.abs(a[off + 2] - b[off + 2]);
      }
    }
    for (let cell = 0; cell < sums.length; cell += 1) {
      sums[cell] = counts[cell] > 0 ? sums[cell] / counts[cell] : 0;
    }
    perTransition.push(sums);
  }
  // Temporal median per cell — the cell's own nuisance floor.
  const medians = new Float64Array(cells * cells);
  const samples = new Float64Array(transitions);
  for (let cell = 0; cell < medians.length; cell += 1) {
    for (let t = 0; t < transitions; t += 1) {
      samples[t] = perTransition[t][cell];
    }
    samples.sort();
    medians[cell] = samples[Math.floor(transitions / 2)];
  }
  const timeline: number[] = [];
  const peakCells: GridCell[] = [];
  for (let t = 0; t < transitions; t += 1) {
    let best = 0;
    let bestCell = 0;
    const row = perTransition[t];
    for (let cell = 0; cell < row.length; cell += 1) {
      const residual = Math.max(0, row[cell] - medians[cell]);
      if (residual > best) {
        best = residual;
        bestCell = cell;
      }
    }
    timeline.push(best);
    peakCells.push({ row: Math.floor(bestCell / cells), col: bestCell % cells });
  }
  return { timeline, peakCells };
}

/** Normalized (0..1) center of a grid cell. */
export function cellCenterNormalized(
  cell: GridCell,
  grid: number = DEFAULT_MOTION_GRID,
): { x: number; y: number } {
  const cells = Math.max(1, Math.floor(grid));
  return {
    x: (cell.col + 0.5) / cells,
    y: (cell.row + 0.5) / cells,
  };
}

/** Pixel box of a grid cell expanded by `expand` cells on every side and
 *  clamped to the frame — the localized search area for a durable change. */
export function cellBox(
  cell: GridCell,
  geometry: AnalysisGeometry,
  grid: number = DEFAULT_MOTION_GRID,
  expand = 1,
): BoundingBox {
  const cells = Math.max(1, Math.floor(grid));
  const col0 = Math.max(0, cell.col - expand);
  const col1 = Math.min(cells, cell.col + expand + 1);
  const row0 = Math.max(0, cell.row - expand);
  const row1 = Math.min(cells, cell.row + expand + 1);
  const x = Math.floor((col0 * geometry.width) / cells);
  const y = Math.floor((row0 * geometry.height) / cells);
  const x2 = Math.floor((col1 * geometry.width) / cells);
  const y2 = Math.floor((row1 * geometry.height) / cells);
  return { x, y, width: Math.max(1, x2 - x), height: Math.max(1, y2 - y) };
}
