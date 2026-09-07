import { access } from 'node:fs/promises';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AnalysisFrame,
  AnalysisGeometry,
  BoundingBox,
  PickupWindow,
  backgroundWindows,
  findMotionWindow,
  meanAbsoluteDifference,
  medianBackground,
} from '../../pickup-detection/analysis/pickup-analyzer';
import {
  DetectedBox,
  ObjectDetector,
  ObjectTrack,
  ObjectTracker,
  PickupDetectionOutput,
  PickupEventDetector,
  PickupEventProposal,
} from '../ports';
import { connectedRegions, shelfZoneFor } from '../primitives';
import { cellBox, localizedMotionTimeline } from './localized-motion';

/** Camera-motion guard: endpoint backgrounds disagreeing over more than
 *  this fraction of the frame is a moved camera, not a picked product. */
const CAMERA_MOTION_COVERAGE = 0.45;
const PIXEL_THRESHOLD = 40;
const MIN_REGION_PIXELS = 12;
/** Relaxed per-channel change threshold used ONLY inside the localized
 *  motion cell when the strict frame-wide search found no durable change:
 *  a transparent bottle on a white shelf changes the background subtly. */
const LOCALIZED_PIXEL_THRESHOLD = 20;

const MOTION_WINDOW_OPTIONS = {
  activationFraction: 0.12,
  removalPixelThreshold: PIXEL_THRESHOLD,
  backgroundFrames: 3,
  minRemovalPixels: MIN_REGION_PIXELS,
  minPeakToBaselineRatio: 3,
};

function changedMask(
  before: Buffer,
  after: Buffer,
  geometry: AnalysisGeometry,
  threshold: number = PIXEL_THRESHOLD,
  within: BoundingBox | null = null,
): Uint8Array {
  const mask = new Uint8Array(geometry.width * geometry.height);
  for (let index = 0; index < mask.length; index += 1) {
    if (within !== null) {
      const x = index % geometry.width;
      const y = Math.floor(index / geometry.width);
      if (
        x < within.x ||
        y < within.y ||
        x >= within.x + within.width ||
        y >= within.y + within.height
      ) {
        continue;
      }
    }
    const off = index * 3;
    const delta = Math.max(
      Math.abs(before[off] - after[off]),
      Math.abs(before[off + 1] - after[off + 1]),
      Math.abs(before[off + 2] - after[off + 2]),
    );
    mask[index] = delta > threshold ? 1 : 0;
  }
  return mask;
}

/** Mean RGB of a box region. */
function regionMean(
  buffer: Buffer,
  geometry: AnalysisGeometry,
  box: BoundingBox,
): [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (let y = box.y; y < box.y + box.height; y += 1) {
    for (let x = box.x; x < box.x + box.width; x += 1) {
      if (x < 0 || y < 0 || x >= geometry.width || y >= geometry.height) continue;
      const off = (y * geometry.width + x) * 3;
      r += buffer[off];
      g += buffer[off + 1];
      b += buffer[off + 2];
      count += 1;
    }
  }
  return count === 0 ? [0, 0, 0] : [r / count, g / count, b / count];
}

/**
 * How much a region STANDS OUT from its surrounding ring — an object on
 * the shelf makes the region's mean color diverge from its neighbourhood;
 * an empty (background) region matches it. Robust to shelf texture, which
 * the ring shares. This is the PICKUP/RETURN discriminator: removal makes
 * the contrast DROP across the event; a return makes it RISE.
 */
function regionSurroundContrast(
  buffer: Buffer,
  geometry: AnalysisGeometry,
  box: BoundingBox,
): number {
  const margin = Math.max(2, Math.round(Math.min(box.width, box.height) / 2));
  const outer: BoundingBox = {
    x: Math.max(0, box.x - margin),
    y: Math.max(0, box.y - margin),
    width: Math.min(geometry.width - Math.max(0, box.x - margin), box.width + margin * 2),
    height: Math.min(geometry.height - Math.max(0, box.y - margin), box.height + margin * 2),
  };
  const inner = regionMean(buffer, geometry, box);
  // Ring mean = outer totals minus inner totals.
  const outerMean = regionMean(buffer, geometry, outer);
  const innerArea = box.width * box.height;
  const outerArea = outer.width * outer.height;
  const ringArea = Math.max(1, outerArea - innerArea);
  const ring: [number, number, number] = [0, 1, 2].map((channel) =>
    (outerMean[channel] * outerArea - inner[channel] * innerArea) / ringArea,
  ) as [number, number, number];
  return Math.sqrt(
    (inner[0] - ring[0]) ** 2 + (inner[1] - ring[1]) ** 2 + (inner[2] - ring[2]) ** 2,
  );
}

function intersects(a: BoundingBox, b: BoundingBox): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

/** Aspect ratios outside this band are shelf lips, dividers, or shadow
 *  strips, never a graspable product. */
const PRODUCT_ASPECT_MIN = 0.25;
const PRODUCT_ASPECT_MAX = 4;
/** A region shorter than this (analysis pixels) cannot hold a product crop. */
const PRODUCT_MIN_EDGE = 24;

function productLike(box: BoundingBox): boolean {
  if (box.width < PRODUCT_MIN_EDGE || box.height < PRODUCT_MIN_EDGE) {
    return false;
  }
  const aspect = box.width / box.height;
  return aspect >= PRODUCT_ASPECT_MIN && aspect <= PRODUCT_ASPECT_MAX;
}

function centerDistance(a: BoundingBox, b: BoundingBox): number {
  return Math.hypot(
    a.x + a.width / 2 - (b.x + b.width / 2),
    a.y + a.height / 2 - (b.y + b.height / 2),
  );
}

/**
 * Fallback-mode region ranking. The endpoint difference of a noisy clip
 * returns several durable regions and the largest one wins by default -
 * on a fridge shelf that is the shelf lip (a 390x50 strip), so the crop,
 * the VLM, and the kind discriminator all look at the wrong pixels.
 * Rank product-shaped regions first, then the ones nearest the cell the
 * hand actually moved through, then by area. Pure; exported for tests.
 */
export function rankRegionsForFallback(
  regions: BoundingBox[],
  hotspot: BoundingBox,
): BoundingBox[] {
  return [...regions].sort((a, b) => {
    const shapeA = productLike(a) ? 1 : 0;
    const shapeB = productLike(b) ? 1 : 0;
    if (shapeA !== shapeB) {
      return shapeB - shapeA;
    }
    const nearA = intersects(a, hotspot) ? 1 : 0;
    const nearB = intersects(b, hotspot) ? 1 : 0;
    if (nearA !== nearB) {
      return nearB - nearA;
    }
    const distance = centerDistance(a, hotspot) - centerDistance(b, hotspot);
    if (Math.abs(distance) > 1e-6) {
      return distance;
    }
    return b.width * b.height - a.width * a.height;
  });
}

function iou(a: BoundingBox, b: BoundingBox): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.width * a.height + b.width * b.height - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Per-frame MOTION-REGION detector — the classical implementation of the
 * ObjectDetector port. Labels are GENERIC ('motion'): never a SKU, never a
 * catalog class (the invariant requirement 3 pins for the YOLO seat too).
 */
@Injectable()
export class MotionObjectDetector implements ObjectDetector {
  readonly adapterKey = 'motion-regions';
  readonly version = '2.0.0';

  checkReady(): Promise<boolean> {
    return Promise.resolve(true);
  }

  private background: Buffer | null = null;

  /** The orchestrator sets the quiet background before per-frame calls. */
  setBackground(background: Buffer): void {
    this.background = background;
  }

  detectObjects(
    frame: AnalysisFrame,
    geometry: AnalysisGeometry,
  ): Promise<DetectedBox[]> {
    const reference = this.background;
    if (!reference) {
      return Promise.resolve([]);
    }
    const regions = connectedRegions(
      changedMask(reference, frame.rgb, geometry),
      geometry,
      MIN_REGION_PIXELS,
    ).slice(0, 4);
    return Promise.resolve(
      regions.map((box) => ({
        timestampMs: frame.timestampMs,
        box,
        label: 'motion',
        confidence: 1,
      })),
    );
  }
}

/** Greedy IoU association — the classical ObjectTracker implementation. */
@Injectable()
export class GreedyIouTracker implements ObjectTracker {
  readonly adapterKey = 'greedy-iou';
  readonly version = '2.0.0';

  checkReady(): Promise<boolean> {
    return Promise.resolve(true);
  }

  track(detections: DetectedBox[][]): Promise<ObjectTrack[]> {
    const tracks: ObjectTrack[] = [];
    let nextId = 1;
    for (const frameDetections of detections) {
      for (const detection of frameDetections) {
        const open = tracks.find((track) => {
          const last = track.boxes[track.boxes.length - 1];
          return (
            track.label === detection.label &&
            detection.timestampMs - last.timestampMs <= 1500 &&
            iou(last.box, detection.box) > 0.2
          );
        });
        if (open) {
          open.boxes.push(detection);
        } else {
          tracks.push({
            trackId: `track-${nextId++}`,
            label: detection.label,
            boxes: [detection],
          });
        }
      }
    }
    return Promise.resolve(tracks.filter((track) => track.boxes.length >= 2));
  }
}

/**
 * pickup-fusion-v2's default event detector: the v1 classical analysis
 * upgraded IN NEW CODE (v1 files untouched) with multi-region splitting,
 * a camera-motion guard, empty-shelf discrimination, and RETURN detection
 * via edge-energy comparison of the changed region across the endpoint
 * backgrounds (a removed product leaves LESS structure behind; a returned
 * one adds structure).
 */
@Injectable()
export class ClassicalMotionEventDetector implements PickupEventDetector {
  readonly adapterKey = 'classical-motion';
  readonly version = '2.0.0';

  constructor(
    private readonly objectDetector: MotionObjectDetector,
    private readonly tracker: GreedyIouTracker,
  ) {}

  checkReady(): Promise<boolean> {
    return Promise.resolve(true);
  }

  async detect(
    frames: AnalysisFrame[],
    geometry: AnalysisGeometry,
    _source: { width: number; height: number },
  ): Promise<PickupDetectionOutput> {
    const warnings: string[] = [];
    if (frames.length < 8) {
      return { events: [], tracks: [], warnings: ['TOO_FEW_FRAMES'] };
    }
    const motionTimeline: number[] = [];
    for (let index = 1; index < frames.length; index += 1) {
      motionTimeline.push(
        meanAbsoluteDifference(frames[index - 1].rgb, frames[index].rgb),
      );
    }
    let window: PickupWindow | null = findMotionWindow(
      motionTimeline,
      frames,
      MOTION_WINDOW_OPTIONS,
    );
    // The localized search area for a durable change — set only when the
    // fallback located the event, so the strict global path is unchanged.
    let localizedArea: BoundingBox | null = null;
    if (window === null) {
      // FALLBACK: frame-wide nuisance motion (handheld shake, an animated
      // display in shot, glass reflections) inflates the global baseline
      // so a small hand never reaches the required peak ratio. The
      // per-cell, baseline-subtracted timeline isolates the one cell the
      // hand actually moves through (see localized-motion.ts).
      const localized = localizedMotionTimeline(frames, geometry);
      window = findMotionWindow(localized.timeline, frames, MOTION_WINDOW_OPTIONS);
      if (window === null) {
        return { events: [], tracks: [], warnings: ['NO_MOTION_EVENT'] };
      }
      warnings.push('LOCALIZED_MOTION_FALLBACK');
      localizedArea = cellBox(localized.peakCells[window.peakIndex], geometry);
    }
    const { before, after } = backgroundWindows(frames, window, 3);
    const preBackground = medianBackground(before);
    const postBackground = medianBackground(after);
    const mask = changedMask(preBackground, postBackground, geometry);
    let coverage = 0;
    for (let index = 0; index < mask.length; index += 1) coverage += mask[index];
    if (coverage / mask.length > CAMERA_MOTION_COVERAGE) {
      return {
        events: [],
        tracks: await this.buildTracks(frames, preBackground, geometry),
        warnings: [...warnings, 'CAMERA_MOTION_SUSPECTED'],
      };
    }
    let regions = connectedRegions(mask, geometry, MIN_REGION_PIXELS);
    const tracks = await this.buildTracks(frames, preBackground, geometry);
    if (regions.length > 1 && localizedArea !== null) {
      // Fallback mode only: the same nuisance motion that hid the event
      // (an animated display, reflections) also litters the endpoint
      // difference with unrelated regions. Keep the ones near where the
      // hand actually moved when any exist; otherwise keep them all.
      const area = localizedArea;
      const near = regions.filter((box) => intersects(box, area));
      if (near.length > 0 && near.length < regions.length) {
        regions = near;
        warnings.push('LOCALIZED_REGION_FILTERED');
      }
    }
    if (regions.length === 0 && localizedArea !== null) {
      // The fallback knows WHERE the hand moved: look for a subtler
      // durable change confined to that cell neighbourhood (a transparent
      // bottle on a bright shelf leaves a low-contrast footprint).
      regions = connectedRegions(
        changedMask(
          preBackground,
          postBackground,
          geometry,
          LOCALIZED_PIXEL_THRESHOLD,
          localizedArea,
        ),
        geometry,
        MIN_REGION_PIXELS,
      );
      if (regions.length > 0) {
        warnings.push('LOCALIZED_REGION_RELAXED');
      }
    }
    if (regions.length === 0) {
      // Motion happened, nothing changed durably — a sweep over an empty
      // shelf (or a pickup immediately returned).
      return { events: [], tracks, warnings: [...warnings, 'NO_DURABLE_CHANGE'] };
    }
    if (regions.length > 1 && localizedArea !== null) {
      // Fallback mode only: the primary event (crop, VLM, kind) must be the
      // product-shaped region where the hand moved, not the biggest blob.
      const ranked = rankRegionsForFallback(regions, localizedArea);
      if (ranked[0] !== regions[0]) {
        warnings.push('LOCALIZED_REGION_RANKED');
      }
      regions = ranked;
    }
    const events: PickupEventProposal[] = regions.slice(0, 4).map((box) => {
      // Removal makes the region's stand-out contrast against its
      // surround DROP; a return makes it RISE (texture-robust — see
      // regionSurroundContrast).
      const kind =
        regionSurroundContrast(preBackground, geometry, box) >=
        regionSurroundContrast(postBackground, geometry, box)
          ? 'PICKUP'
          : 'RETURN';
      const overlapping = tracks.find((track) =>
        track.boxes.some((detection) => iou(detection.box, box) > 0.1),
      );
      return {
        kind,
        startMs: Math.round(window.eventStartMs),
        peakMs: Math.round(window.eventPeakMs),
        endMs: Math.round(window.eventEndMs),
        trackId: overlapping?.trackId ?? 'track-none',
        shelfZoneId: shelfZoneFor(box, geometry),
        box,
      } as PickupEventProposal;
    });
    return { events, tracks, warnings };
  }

  private async buildTracks(
    frames: AnalysisFrame[],
    background: Buffer,
    geometry: AnalysisGeometry,
  ): Promise<ObjectTrack[]> {
    this.objectDetector.setBackground(background);
    const perFrame: DetectedBox[][] = [];
    // Sample every other frame for tracking — cheap and sufficient at 5fps.
    for (let index = 0; index < frames.length; index += 2) {
      perFrame.push(await this.objectDetector.detectObjects(frames[index], geometry));
    }
    return this.tracker.track(perFrame);
  }
}

/**
 * The YOLO seat: a config-gated ONNX adapter. It activates ONLY when the
 * operator provides a model file (PICKUP_YOLO_MODEL_PATH) and the ONNX
 * runtime dependency is installed — until then checkReady() is false and
 * the orchestrator stays on the classical detector. It NEVER fabricates
 * detections. Contract for the model: generic classes (hand / product /
 * shelf-interaction), never per-SKU classification (requirement 3 —
 * recognition belongs to retrieval/fusion, not the detector).
 */
@Injectable()
export class YoloOnnxObjectDetector implements ObjectDetector {
  readonly adapterKey = 'yolo-onnx';
  readonly version = '2.0.0';

  private readonly modelPath: string | undefined;

  constructor(config: ConfigService) {
    this.modelPath = config.get<string>('PICKUP_YOLO_MODEL_PATH');
  }

  async checkReady(): Promise<boolean> {
    if (!this.modelPath) {
      return false;
    }
    try {
      await access(this.modelPath);
    } catch {
      return false;
    }
    // Runtime presence is part of readiness: no ONNX runtime → not ready.
    try {
      require.resolve('onnxruntime-node');
      return true;
    } catch {
      return false;
    }
  }

  detectObjects(): Promise<DetectedBox[]> {
    return Promise.reject(
      new Error(
        'YOLO adapter is not active on this deployment (model/runtime absent)',
      ),
    );
  }
}
