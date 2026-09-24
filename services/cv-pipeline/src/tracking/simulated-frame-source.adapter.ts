import { Injectable } from '@nestjs/common';
import {
  FrameResult,
  FrameSourceOptions,
  FrameSourcePort,
} from './frame-source.port';

/**
 * DETERMINISTIC frame source — the default.
 *
 * CI, unit tests and a laptop with no camera all need the pipeline to
 * run end to end. This source synthesises RGB24 frames from the sample
 * index: a static background with one bright block that moves across the
 * frame, so a real frame-difference tracker fed by it produces real,
 * repeatable motion regions rather than a canned answer.
 *
 * `readsRealBytes` is false and stays false. The API draws the same
 * distinction for its simulated video extractor, and for the same
 * reason: an operator must never mistake a rehearsal for the camera.
 */
@Injectable()
export class SimulatedFrameSource extends FrameSourcePort {
  readonly kind = 'simulated';
  readonly readsRealBytes = false;

  private sampleIndex = 0;

  /** Nothing to probe — the generator is always available. */
  checkReady(): Promise<boolean> {
    return Promise.resolve(true);
  }

  sample(options: FrameSourceOptions): Promise<FrameResult> {
    const { width, height } = options;
    const data = Buffer.alloc(width * height * 3, 24);
    const index = this.sampleIndex;
    this.sampleIndex += 1;

    // A block that sweeps left to right over a 20-sample cycle and dwells
    // in the middle third, which is where a caller's shelf zones usually
    // sit. Every number here is a pure function of the sample index.
    const cycle = index % 20;
    const blockWidth = Math.max(1, Math.floor(width / 6));
    const blockHeight = Math.max(1, Math.floor(height / 4));
    const travel = Math.max(1, width - blockWidth);
    const left = Math.floor((travel * cycle) / 19);
    const top = Math.floor((height - blockHeight) / 2);

    for (let y = top; y < top + blockHeight && y < height; y += 1) {
      const rowOffset = y * width * 3;
      for (let x = left; x < left + blockWidth && x < width; x += 1) {
        const offset = rowOffset + x * 3;
        data[offset] = 220;
        data[offset + 1] = 220;
        data[offset + 2] = 220;
      }
    }

    return Promise.resolve({
      ok: true,
      frame: { data, width, height, capturedAt: new Date() },
    });
  }

  /** Test affordance: restart the sweep so a spec can assert a sequence
   *  from a known phase. */
  reset(): void {
    this.sampleIndex = 0;
  }
}
