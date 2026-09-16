import { Injectable } from '@nestjs/common';
import { RgbFrame } from './frame-source.port';
import { TrackerPort } from './tracker.port';
import {
  MotionRegion,
  NormalizedBox,
  ShelfZone,
  TrackingObservation,
  clampUnit,
  overlapFraction,
} from './tracking.types';

/**
 * FRAME-DIFFERENCE tracker — the pilot's real tier 1.
 *
 * It compares each downscaled frame against the previous one on a coarse
 * grid and reports where the picture changed. That is all tier 1 is
 * allowed to be: cheap enough to run on every frame of a continuous
 * stream, and incapable of naming a product.
 *
 * HONEST ABOUT ITS HEURISTICS. "Person likely" is whole-frame motion past
 * a threshold; "hand likely" is a COMPACT motion region overlapping a
 * configured shelf zone. Neither detects a person or a hand — they are
 * proxies, named after what they are used for, and the trigger layer
 * treats them as weak evidence for "this moment deserves a heavy look",
 * which is the only decision they feed. A model-backed tracker can
 * replace this class behind TrackerPort without the trigger layer
 * noticing.
 */
@Injectable()
export class MotionTracker extends TrackerPort {
  readonly kind = 'motion-diff';

  /** Grid resolution. Coarse on purpose: per-pixel regions would be
   *  noise, and the trigger layer only needs to know WHICH ZONE moved. */
  private static readonly GRID_COLUMNS = 16;
  private static readonly GRID_ROWS = 12;

  /** A motion region covering more than this fraction of the frame is a
   *  body or a lighting change, not a hand reaching in. */
  private static readonly MAX_HAND_REGION_AREA = 0.18;

  private previous: { data: Buffer; width: number; height: number } | null =
    null;

  constructor(
    private readonly zones: ShelfZone[],
    /** Per-pixel luma delta (0..255) counted as a change. Below this is
     *  sensor noise and compression churn on a still scene. */
    private readonly pixelDeltaThreshold: number,
    /** Fraction of a grid cell's pixels that must change for the cell to
     *  count as moving. Suppresses single-pixel speckle. */
    private readonly cellActivationRatio: number,
  ) {
    super();
  }

  reset(): void {
    this.previous = null;
  }

  observe(frame: RgbFrame, frameIndex: number): TrackingObservation | null {
    const expected = frame.width * frame.height * 3;
    if (frame.data.length < expected) {
      // A short buffer is a decode failure the source should have caught.
      // Treat it as "no opinion" and drop the baseline so the next frame
      // is not diffed against a truncated one.
      this.previous = null;
      return null;
    }
    const current = {
      data: frame.data,
      width: frame.width,
      height: frame.height,
    };
    const previous = this.previous;
    this.previous = current;
    if (
      previous === null ||
      previous.width !== current.width ||
      previous.height !== current.height
    ) {
      // First frame of a run, or the geometry changed under us: there is
      // nothing honest to compare against, so report nothing rather than
      // a frame of phantom motion.
      return null;
    }

    const cells = this.diffGrid(previous, current);
    const activeCells = cells.filter((cell) => cell.active).length;
    const motionRatio = clampUnit(activeCells / cells.length);
    const motionRegions = this.regionsFrom(cells);

    const zones = this.zones.map((zone) => {
      const coverage = clampUnit(
        motionRegions.reduce(
          (sum, region) => sum + overlapFraction(zone.box, region.box),
          0,
        ),
      );
      return {
        zoneCode: zone.zoneCode,
        occupied: coverage > 0,
        coverage,
      };
    });

    const compactOverZone = motionRegions.some(
      (region) =>
        region.box.width * region.box.height <=
          MotionTracker.MAX_HAND_REGION_AREA &&
        this.zones.some((zone) => overlapFraction(zone.box, region.box) > 0),
    );

    return {
      frameIndex,
      capturedAt: frame.capturedAt,
      motionRatio,
      motionRegions,
      presence: {
        personLikely: motionRatio > 0,
        handLikely: compactOverZone,
        confidence: clampUnit(motionRatio * 2),
      },
      zones,
    };
  }

  /** Per-cell change ratios over the coarse grid. */
  private diffGrid(
    previous: { data: Buffer; width: number; height: number },
    current: { data: Buffer; width: number; height: number },
  ): { column: number; row: number; active: boolean }[] {
    const { width, height } = current;
    const cells: { column: number; row: number; active: boolean }[] = [];
    const cellWidth = width / MotionTracker.GRID_COLUMNS;
    const cellHeight = height / MotionTracker.GRID_ROWS;

    for (let row = 0; row < MotionTracker.GRID_ROWS; row += 1) {
      const yStart = Math.floor(row * cellHeight);
      const yEnd = Math.max(yStart + 1, Math.floor((row + 1) * cellHeight));
      for (let column = 0; column < MotionTracker.GRID_COLUMNS; column += 1) {
        const xStart = Math.floor(column * cellWidth);
        const xEnd = Math.max(xStart + 1, Math.floor((column + 1) * cellWidth));
        let changed = 0;
        let counted = 0;
        for (let y = yStart; y < yEnd && y < height; y += 1) {
          const rowOffset = y * width * 3;
          for (let x = xStart; x < xEnd && x < width; x += 1) {
            const index = rowOffset + x * 3;
            // Rec. 601 luma without the floating-point cost: the integer
            // weights sum to 256, so the shift is an exact divide.
            const lumaPrevious =
              (previous.data[index] * 77 +
                previous.data[index + 1] * 150 +
                previous.data[index + 2] * 29) >>
              8;
            const lumaCurrent =
              (current.data[index] * 77 +
                current.data[index + 1] * 150 +
                current.data[index + 2] * 29) >>
              8;
            if (
              Math.abs(lumaCurrent - lumaPrevious) >= this.pixelDeltaThreshold
            ) {
              changed += 1;
            }
            counted += 1;
          }
        }
        cells.push({
          column,
          row,
          active: counted > 0 && changed / counted >= this.cellActivationRatio,
        });
      }
    }
    return cells;
  }

  /**
   * Connected groups of active cells, each reported as one normalized
   * box. Four-way flood fill over the grid — at 16x12 the whole thing is
   * 192 cells, so the simplest correct algorithm is also the fast one.
   */
  private regionsFrom(
    cells: { column: number; row: number; active: boolean }[],
  ): MotionRegion[] {
    const columns = MotionTracker.GRID_COLUMNS;
    const rows = MotionTracker.GRID_ROWS;
    const at = (column: number, row: number) => cells[row * columns + column];
    const seen = new Set<number>();
    const regions: MotionRegion[] = [];

    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const index = row * columns + column;
        if (seen.has(index) || !at(column, row).active) {
          continue;
        }
        const stack = [{ column, row }];
        seen.add(index);
        let minColumn = column;
        let maxColumn = column;
        let minRow = row;
        let maxRow = row;
        let members = 0;

        while (stack.length > 0) {
          const cell = stack.pop() as { column: number; row: number };
          members += 1;
          minColumn = Math.min(minColumn, cell.column);
          maxColumn = Math.max(maxColumn, cell.column);
          minRow = Math.min(minRow, cell.row);
          maxRow = Math.max(maxRow, cell.row);

          const neighbours = [
            { column: cell.column - 1, row: cell.row },
            { column: cell.column + 1, row: cell.row },
            { column: cell.column, row: cell.row - 1 },
            { column: cell.column, row: cell.row + 1 },
          ];
          for (const neighbour of neighbours) {
            if (
              neighbour.column < 0 ||
              neighbour.column >= columns ||
              neighbour.row < 0 ||
              neighbour.row >= rows
            ) {
              continue;
            }
            const neighbourIndex = neighbour.row * columns + neighbour.column;
            if (seen.has(neighbourIndex)) {
              continue;
            }
            if (!at(neighbour.column, neighbour.row).active) {
              continue;
            }
            seen.add(neighbourIndex);
            stack.push(neighbour);
          }
        }

        const box: NormalizedBox = {
          x: minColumn / columns,
          y: minRow / rows,
          width: (maxColumn - minColumn + 1) / columns,
          height: (maxRow - minRow + 1) / rows,
        };
        const boxCells = (maxColumn - minColumn + 1) * (maxRow - minRow + 1);
        regions.push({
          box,
          intensity: clampUnit(members / boxCells),
        });
      }
    }
    return regions;
  }
}
