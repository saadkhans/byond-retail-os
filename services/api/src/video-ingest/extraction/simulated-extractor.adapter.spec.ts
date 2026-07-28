import {
  SIMULATED_PROBE,
  SimulatedVideoFrameExtractor,
} from './simulated-extractor.adapter';
import { FrameExceedsBudgetError } from './video-frame-extractor.port';

describe('SimulatedVideoFrameExtractor', () => {
  const extractor = new SimulatedVideoFrameExtractor();

  it('probes deterministic metadata without touching storage', async () => {
    const probe = await extractor.probe('tenant/asset/original.mp4');
    expect(probe).toEqual(SIMULATED_PROBE);
  });

  it('declares that it does NOT read real bytes (screening previews must refuse it)', () => {
    // The discriminator behind the informed-screening gate: placeholder
    // frames must never stand in for the footage a screener approves.
    expect(extractor.readsRealBytes).toBe(false);
  });

  it('honors a caller-supplied maxBytes on extractFrameAt', async () => {
    const fits = await extractor.extractFrameAt('k', SIMULATED_PROBE, 0, {
      maxBytes: 1024,
    });
    expect(fits.data.length).toBeLessThanOrEqual(1024);
    // A budget the placeholder cannot fit is the SAME controlled budget
    // verdict a real adapter produces — never a partial frame.
    await expect(
      extractor.extractFrameAt('k', SIMULATED_PROBE, 0, { maxBytes: 8 }),
    ).rejects.toBeInstanceOf(FrameExceedsBudgetError);
  });

  it('samples frames at the interval and honors the cap', async () => {
    const frames = await extractor.extractFrames('k', SIMULATED_PROBE, {
      intervalMs: 1000,
      maxFrames: 5,
      startMs: 0,
    });
    expect(frames).toHaveLength(5);
    expect(frames.map((f) => f.timestampMs)).toEqual([0, 1000, 2000, 3000, 4000]);
    for (const frame of frames) {
      expect(frame.width).toBe(SIMULATED_PROBE.width);
      expect(frame.height).toBe(SIMULATED_PROBE.height);
      expect(frame.mimeType).toBe('image/png');
      expect(frame.data.length).toBeGreaterThan(0);
    }
  });

  it('never samples past the duration', async () => {
    const frames = await extractor.extractFrames('k', SIMULATED_PROBE, {
      intervalMs: 4000,
      maxFrames: 30,
      startMs: 0,
    });
    // 0, 4000, 8000 — 12000 exceeds the 10s duration.
    expect(frames.map((f) => f.timestampMs)).toEqual([0, 4000, 8000]);
  });

  it('treats the duration as an EXCLUSIVE endpoint (no frame at durationMs)', async () => {
    const frames = await extractor.extractFrames('k', SIMULATED_PROBE, {
      intervalMs: 5000,
      maxFrames: 30,
      startMs: 0,
    });
    // 0, 5000 — 10000 IS the duration; real extraction has no frame there,
    // and the simulated adapter must behave identically.
    expect(frames.map((f) => f.timestampMs)).toEqual([0, 5000]);
  });

  it('extracts a single frame at a timestamp', async () => {
    const frame = await extractor.extractFrameAt('k', SIMULATED_PROBE, 2500);
    expect(frame.timestampMs).toBe(2500);
    expect(frame.width).toBe(SIMULATED_PROBE.width);
  });

  it('crops carry the requested geometry and distinct payloads', async () => {
    const a = await extractor.extractCrop('k', SIMULATED_PROBE, 1000, {
      x: 10,
      y: 20,
      width: 300,
      height: 200,
    });
    const b = await extractor.extractCrop('k', SIMULATED_PROBE, 2000, {
      x: 10,
      y: 20,
      width: 300,
      height: 200,
    });
    expect(a.width).toBe(300);
    expect(a.height).toBe(200);
    // Distinct request → distinct bytes → distinct checksum downstream.
    expect(a.data.equals(b.data)).toBe(false);
  });
});
