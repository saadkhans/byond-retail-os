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

  it('provides a trivial in-memory inspection session (deterministic probe, per-second placeholder frames, no-op close)', async () => {
    // The pre-storage screen refuses to TRUST this adapter anyway
    // (readsRealBytes=false), but the contract must still hold so the
    // module wires without special cases.
    const session = await extractor.inspectBuffer(Buffer.from('ignored'));
    await expect(session.probe()).resolves.toEqual(SIMULATED_PROBE);
    const frames = await session.extractFramesPerSecond({
      maxBytesPerFrame: 1024,
    });
    // One placeholder per started second of the 10 s simulated clip, each
    // a PNG-signature-led buffer.
    expect(frames).toHaveLength(10);
    for (const frame of frames) {
      expect(frame.subarray(0, 8)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
    }
    // Distinct seconds → distinct payloads (checksums differ downstream).
    expect(frames[0].equals(frames[1])).toBe(false);
    await expect(session.close()).resolves.toBeUndefined();
    // Idempotent close.
    await expect(session.close()).resolves.toBeUndefined();
  });

  it('applies the per-frame budget contract inside the inspection session', async () => {
    const session = await extractor.inspectBuffer(Buffer.from('ignored'));
    // A budget the placeholder cannot fit → the controlled budget verdict.
    await expect(
      session.extractFramesPerSecond({ maxBytesPerFrame: 8 }),
    ).rejects.toBeInstanceOf(FrameExceedsBudgetError);
    // Degenerate budgets are budget verdicts too, decided up front.
    for (const maxBytesPerFrame of [0, -1, 1.5, Number.NaN]) {
      await expect(
        session.extractFramesPerSecond({ maxBytesPerFrame }),
      ).rejects.toBeInstanceOf(FrameExceedsBudgetError);
    }
    await session.close();
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
