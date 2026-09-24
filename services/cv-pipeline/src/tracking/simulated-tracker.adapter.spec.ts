import { RgbFrame } from './frame-source.port';
import { SimulatedFrameSource } from './simulated-frame-source.adapter';
import { SimulatedTracker } from './simulated-tracker.adapter';
import { ShelfZone } from './tracking.types';

const ZONES: ShelfZone[] = [
  { zoneCode: 'A1', box: { x: 0, y: 0, width: 0.5, height: 0.5 } },
  { zoneCode: 'B2', box: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 } },
];

function frame(): RgbFrame {
  return {
    data: Buffer.alloc(8 * 8 * 3),
    width: 8,
    height: 8,
    capturedAt: new Date('2026-09-16T10:00:00.000Z'),
  };
}

describe('SimulatedTracker', () => {
  it('is deterministic, so a test can assert an exact sequence', () => {
    const first = new SimulatedTracker(ZONES);
    const second = new SimulatedTracker(ZONES);

    for (let index = 1; index <= 40; index += 1) {
      expect(first.observe(frame(), index)).toEqual(
        second.observe(frame(), index),
      );
    }
  });

  it('treats the first frame as a baseline like the real tracker', () => {
    expect(new SimulatedTracker(ZONES).observe(frame(), 0)).toBeNull();
  });

  it('replays identically after a reset, since the pattern is pure', () => {
    const subject = new SimulatedTracker(ZONES);
    const before = subject.observe(frame(), 7);
    subject.reset();
    expect(subject.observe(frame(), 7)).toEqual(before);
  });

  it('produces quiet frames as well as busy ones', () => {
    const subject = new SimulatedTracker(ZONES);
    const ratios: number[] = [];
    for (let index = 1; index <= 20; index += 1) {
      const observation = subject.observe(frame(), index);
      if (observation !== null) {
        ratios.push(observation.motionRatio);
      }
    }

    // Both states must occur, or the trigger layer's debounce and re-arm
    // paths are never exercised by a simulated run.
    expect(ratios.some((ratio) => ratio === 0)).toBe(true);
    expect(ratios.some((ratio) => ratio > 0)).toBe(true);
  });

  it('visits each configured zone in turn', () => {
    const subject = new SimulatedTracker(ZONES);
    const occupied = new Set<string>();
    for (let index = 1; index <= 40; index += 1) {
      const observation = subject.observe(frame(), index);
      for (const zone of observation?.zones ?? []) {
        if (zone.occupied) {
          occupied.add(zone.zoneCode);
        }
      }
    }
    expect([...occupied].sort()).toEqual(['A1', 'B2']);
  });

  it('survives a configuration with no zones', () => {
    const subject = new SimulatedTracker([]);
    const observation = subject.observe(frame(), 6);
    expect(observation?.zones).toEqual([]);
    expect(observation?.motionRegions).toEqual([]);
  });

  it('keeps every ratio inside 0..1', () => {
    const subject = new SimulatedTracker(ZONES);
    for (let index = 1; index <= 40; index += 1) {
      const observation = subject.observe(frame(), index);
      if (observation === null) {
        continue;
      }
      expect(observation.motionRatio).toBeGreaterThanOrEqual(0);
      expect(observation.motionRatio).toBeLessThanOrEqual(1);
      expect(observation.presence.confidence).toBeLessThanOrEqual(1);
      for (const zone of observation.zones) {
        expect(zone.coverage).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('SimulatedFrameSource', () => {
  it('is always ready and says it is not reading real bytes', async () => {
    const source = new SimulatedFrameSource();
    expect(await source.checkReady()).toBe(true);
    // An operator must never mistake a rehearsal for the camera.
    expect(source.readsRealBytes).toBe(false);
  });

  it('returns a correctly sized RGB24 buffer', async () => {
    const source = new SimulatedFrameSource();
    const result = await source.sample({
      width: 32,
      height: 24,
      timeoutMs: 1_000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.frame.data.length).toBe(32 * 24 * 3);
    expect(result.frame.width).toBe(32);
    expect(result.frame.height).toBe(24);
  });

  it('changes between samples, so a diff tracker has something to see', async () => {
    const source = new SimulatedFrameSource();
    const options = { width: 64, height: 48, timeoutMs: 1_000 };
    const first = await source.sample(options);
    const second = await source.sample(options);

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) {
      return;
    }
    expect(first.frame.data.equals(second.frame.data)).toBe(false);
  });

  it('replays from the start after a reset', async () => {
    const source = new SimulatedFrameSource();
    const options = { width: 16, height: 16, timeoutMs: 1_000 };
    const first = await source.sample(options);
    source.reset();
    const again = await source.sample(options);

    expect(first.ok && again.ok).toBe(true);
    if (!first.ok || !again.ok) {
      return;
    }
    expect(first.frame.data.equals(again.frame.data)).toBe(true);
  });
});
