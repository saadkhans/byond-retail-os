import { RgbFrame } from './frame-source.port';
import { MotionTracker } from './motion-tracker.adapter';
import { SimulatedFrameSource } from './simulated-frame-source.adapter';
import { ShelfZone } from './tracking.types';

const WIDTH = 160;
const HEIGHT = 120;

const ZONES: ShelfZone[] = [
  { zoneCode: 'A1', box: { x: 0, y: 0, width: 0.5, height: 0.5 } },
  { zoneCode: 'B2', box: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 } },
];

function blankFrame(fill = 20): RgbFrame {
  return {
    data: Buffer.alloc(WIDTH * HEIGHT * 3, fill),
    width: WIDTH,
    height: HEIGHT,
    capturedAt: new Date('2026-09-16T10:00:00.000Z'),
  };
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A frame with bright rectangles at the given normalized boxes. */
function frameWithBlocks(boxes: Box[]): RgbFrame {
  const frame = blankFrame();
  for (const box of boxes) {
    const left = Math.floor(box.x * WIDTH);
    const top = Math.floor(box.y * HEIGHT);
    const right = Math.floor((box.x + box.width) * WIDTH);
    const bottom = Math.floor((box.y + box.height) * HEIGHT);
    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) {
        const offset = (y * WIDTH + x) * 3;
        frame.data[offset] = 240;
        frame.data[offset + 1] = 240;
        frame.data[offset + 2] = 240;
      }
    }
  }
  return frame;
}

function frameWithBlock(box: Box): RgbFrame {
  return frameWithBlocks([box]);
}

function tracker(): MotionTracker {
  return new MotionTracker(ZONES, 18, 0.12);
}

describe('MotionTracker — baseline behaviour', () => {
  it('has no opinion about the first frame of a run', () => {
    expect(tracker().observe(blankFrame(), 1)).toBeNull();
  });

  it('reports no motion between two identical frames', () => {
    const subject = tracker();
    subject.observe(blankFrame(), 1);
    const observation = subject.observe(blankFrame(), 2);

    expect(observation).not.toBeNull();
    expect(observation?.motionRatio).toBe(0);
    expect(observation?.motionRegions).toHaveLength(0);
    expect(observation?.presence.personLikely).toBe(false);
  });

  it('ignores a change below the per-pixel noise floor', () => {
    const subject = tracker();
    subject.observe(blankFrame(20), 1);
    // A delta of 5 is under the threshold of 18: sensor noise, not motion.
    const observation = subject.observe(blankFrame(25), 2);

    expect(observation?.motionRatio).toBe(0);
  });

  it('drops its baseline after a truncated frame', () => {
    const subject = tracker();
    subject.observe(blankFrame(), 1);

    const short: RgbFrame = {
      data: Buffer.alloc(10),
      width: WIDTH,
      height: HEIGHT,
      capturedAt: new Date(),
    };
    expect(subject.observe(short, 2)).toBeNull();
    // The next good frame becomes a new baseline rather than being diffed
    // against the frame from before the gap.
    expect(subject.observe(blankFrame(), 3)).toBeNull();
  });

  it('drops its baseline when the geometry changes mid-run', () => {
    const subject = tracker();
    subject.observe(blankFrame(), 1);
    const resized: RgbFrame = {
      data: Buffer.alloc(80 * 60 * 3, 20),
      width: 80,
      height: 60,
      capturedAt: new Date(),
    };
    expect(subject.observe(resized, 2)).toBeNull();
  });

  it('forgets everything on reset', () => {
    const subject = tracker();
    subject.observe(blankFrame(), 1);
    subject.reset();
    expect(subject.observe(frameWithBlock(ZONES[0].box), 2)).toBeNull();
  });
});

describe('MotionTracker — localisation', () => {
  it('attributes motion to the zone it happened in', () => {
    const subject = tracker();
    subject.observe(blankFrame(), 1);
    const observation = subject.observe(
      frameWithBlock({ x: 0.05, y: 0.05, width: 0.2, height: 0.2 }),
      2,
    );

    const a1 = observation?.zones.find((zone) => zone.zoneCode === 'A1');
    const b2 = observation?.zones.find((zone) => zone.zoneCode === 'B2');

    expect(a1?.occupied).toBe(true);
    expect(a1?.coverage).toBeGreaterThan(0);
    expect(b2?.occupied).toBe(false);
    expect(b2?.coverage).toBe(0);
  });

  it('reports every configured zone every frame, quiet ones included', () => {
    const subject = tracker();
    subject.observe(blankFrame(), 1);
    const observation = subject.observe(blankFrame(), 2);

    expect(observation?.zones.map((zone) => zone.zoneCode)).toEqual([
      'A1',
      'B2',
    ]);
  });

  it('calls a compact change over a zone a likely hand', () => {
    const subject = tracker();
    subject.observe(blankFrame(), 1);
    const observation = subject.observe(
      frameWithBlock({ x: 0.1, y: 0.1, width: 0.15, height: 0.15 }),
      2,
    );

    expect(observation?.presence.handLikely).toBe(true);
  });

  it('does not call a frame-filling change a hand', () => {
    const subject = tracker();
    subject.observe(blankFrame(20), 1);
    // A lighting change across the whole frame: motion, but not a reach.
    const observation = subject.observe(blankFrame(200), 2);

    expect(observation?.motionRatio).toBeGreaterThan(0.8);
    expect(observation?.presence.handLikely).toBe(false);
    expect(observation?.presence.personLikely).toBe(true);
  });

  it('separates two disjoint changes into two regions', () => {
    const subject = tracker();
    subject.observe(blankFrame(), 1);

    const frame = frameWithBlocks([
      { x: 0.05, y: 0.05, width: 0.15, height: 0.15 },
      { x: 0.7, y: 0.7, width: 0.15, height: 0.15 },
    ]);

    const observation = subject.observe(frame, 2);
    expect(observation?.motionRegions.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps every published ratio inside 0..1', () => {
    const subject = tracker();
    subject.observe(blankFrame(0), 1);
    const observation = subject.observe(blankFrame(255), 2);

    expect(observation?.motionRatio).toBeLessThanOrEqual(1);
    expect(observation?.presence.confidence).toBeLessThanOrEqual(1);
    for (const zone of observation?.zones ?? []) {
      expect(zone.coverage).toBeGreaterThanOrEqual(0);
      expect(zone.coverage).toBeLessThanOrEqual(1);
    }
    for (const region of observation?.motionRegions ?? []) {
      expect(region.intensity).toBeGreaterThanOrEqual(0);
      expect(region.intensity).toBeLessThanOrEqual(1);
    }
  });
});

describe('MotionTracker over the simulated frame source', () => {
  it('produces real motion from synthetic frames, so CI exercises the loop', async () => {
    const source = new SimulatedFrameSource();
    const subject = tracker();
    const ratios: number[] = [];

    for (let index = 1; index <= 6; index += 1) {
      const result = await source.sample({
        width: WIDTH,
        height: HEIGHT,
        timeoutMs: 1_000,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      const observation = subject.observe(result.frame, index);
      if (observation !== null) {
        ratios.push(observation.motionRatio);
      }
    }

    expect(ratios.length).toBeGreaterThan(0);
    expect(ratios.some((ratio) => ratio > 0)).toBe(true);
  });
});
