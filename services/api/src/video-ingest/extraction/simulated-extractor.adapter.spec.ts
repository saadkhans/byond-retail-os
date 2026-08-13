import { execFile, spawn } from 'node:child_process';
import {
  SIMULATED_PROBE,
  SimulatedVideoFrameExtractor,
} from './simulated-extractor.adapter';
import {
  FrameCountExceededError,
  FrameExceedsBudgetError,
  ScreeningDeadlineExceededError,
} from './video-frame-extractor.port';

// This adapter has NO tooling: the module is mocked purely so the specs can
// ASSERT that nothing is ever spawned — including by the readiness check.
jest.mock('node:child_process', () => ({
  execFile: jest.fn(),
  spawn: jest.fn(),
}));

const execFileMock = execFile as unknown as jest.Mock;
const spawnMock = spawn as unknown as jest.Mock;

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

  it('reports tooling READY trivially, without invoking anything', async () => {
    // There is no external tooling here to be missing, so nothing can fail
    // to run — and a check that spawned something to say so would be a lie
    // about what this strategy is. Reporting ready OPENS NOTHING: the
    // pre-buffer upload gate refuses on readsRealBytes=false above, and
    // readiness is only the second half of that gate (does the tool the
    // capability flag promises actually run?), never a substitute for it.
    const ready = await extractor.checkToolingReady();
    expect(typeof ready).toBe('boolean');
    expect(ready).toBe(true);
    expect(execFileMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  /** Collecting screener: the pull-based contract's simplest consumer. */
  const collector = (frames: Buffer[], stopAt?: number) => (
    frame: Buffer,
    index: number,
  ): Promise<'continue' | 'stop'> => {
    frames.push(frame);
    return Promise.resolve(index === stopAt ? 'stop' : 'continue');
  };

  it('provides a trivial in-memory inspection session (deterministic probe, EXHAUSTIVE placeholder frames PUSHED one at a time, no-op close)', async () => {
    // The pre-storage screen refuses to TRUST this adapter anyway
    // (readsRealBytes=false), but the contract must still hold so the
    // module wires without special cases: the exhaustive-decode contract
    // offers one placeholder per SOURCE frame — fps × duration — never a
    // per-second sample, and never as one retained array.
    const session = await extractor.inspectBuffer(Buffer.from('ignored'));
    await expect(session.probe()).resolves.toEqual(SIMULATED_PROBE);
    const frames: Buffer[] = [];
    const indices: number[] = [];
    const result = await session.streamFrames({
      maxFrames: 900,
      maxBytesPerFrame: 1024,
      deadlineMs: 30_000,
      onFrame: (frame, index) => {
        indices.push(index);
        return collector(frames)(frame, index);
      },
    });
    // 30 fps × 10 s simulated clip → 300 placeholder source frames, each
    // a PNG-signature-led buffer, delivered in decode order.
    expect(result).toEqual({ framesSeen: 300, stoppedEarly: false });
    expect(frames).toHaveLength(300);
    expect(indices[0]).toBe(0);
    expect(indices[299]).toBe(299);
    for (const frame of frames) {
      expect(frame.subarray(0, 8)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
    }
    // Distinct frames → distinct payloads (checksums differ downstream).
    expect(frames[0].equals(frames[1])).toBe(false);
    await expect(session.close()).resolves.toBeUndefined();
    // Idempotent close.
    await expect(session.close()).resolves.toBeUndefined();
  });

  it('accepts (and ignores) a probe deadline, keeping the session contract shape identical', async () => {
    // The aggregate screening budget covers probe AND decode on the real
    // adapter; the simulated session must take the same option so callers
    // wire without special cases. Nothing here runs a tool, so no budget
    // can be consumed — the result is the same constant every time, which
    // also satisfies the memoization contract trivially.
    const session = await extractor.inspectBuffer(Buffer.from('ignored'));
    await expect(session.probe()).resolves.toEqual(SIMULATED_PROBE);
    await expect(session.probe({ deadlineMs: 1 })).resolves.toEqual(
      SIMULATED_PROBE,
    );
    await expect(session.probe({ deadlineMs: 300_000 })).resolves.toEqual(
      SIMULATED_PROBE,
    );
    await session.close();
  });

  it('honors an early stop from the screener without an error', async () => {
    const session = await extractor.inspectBuffer(Buffer.from('ignored'));
    const frames: Buffer[] = [];
    const result = await session.streamFrames({
      maxFrames: 900,
      maxBytesPerFrame: 1024,
      deadlineMs: 30_000,
      onFrame: collector(frames, 2),
    });
    // The stopping frame counts as seen; the rest is never decoded.
    expect(result).toEqual({ framesSeen: 3, stoppedEarly: true });
    expect(frames).toHaveLength(3);
    await session.close();
  });

  it('applies the per-frame budget contract inside the inspection session', async () => {
    const session = await extractor.inspectBuffer(Buffer.from('ignored'));
    const onFrame = () => Promise.resolve<'continue'>('continue');
    // A budget the placeholder cannot fit → the controlled budget verdict.
    await expect(
      session.streamFrames({
        maxFrames: 900,
        maxBytesPerFrame: 8,
        deadlineMs: 30_000,
        onFrame,
      }),
    ).rejects.toBeInstanceOf(FrameExceedsBudgetError);
    // Degenerate budgets are budget verdicts too, decided up front.
    for (const maxBytesPerFrame of [0, -1, 1.5, Number.NaN]) {
      await expect(
        session.streamFrames({
          maxFrames: 900,
          maxBytesPerFrame,
          deadlineMs: 30_000,
          onFrame,
        }),
      ).rejects.toBeInstanceOf(FrameExceedsBudgetError);
    }
    await session.close();
  });

  it('applies the frame-count contract inside the inspection session', async () => {
    const session = await extractor.inspectBuffer(Buffer.from('ignored'));
    const onFrame = () => Promise.resolve<'continue'>('continue');
    // The 300-frame simulated stream past a smaller cap → the controlled
    // count verdict, mirroring the real adapter.
    await expect(
      session.streamFrames({
        maxFrames: 299,
        maxBytesPerFrame: 1024,
        deadlineMs: 30_000,
        onFrame,
      }),
    ).rejects.toBeInstanceOf(FrameCountExceededError);
    // Degenerate caps are count verdicts too, decided up front.
    for (const maxFrames of [0, -1, 1.5, Number.NaN]) {
      await expect(
        session.streamFrames({
          maxFrames,
          maxBytesPerFrame: 1024,
          deadlineMs: 30_000,
          onFrame,
        }),
      ).rejects.toBeInstanceOf(FrameCountExceededError);
    }
    await session.close();
  });

  it('applies the deadline contract (contractual, never timed) inside the inspection session', async () => {
    const session = await extractor.inspectBuffer(Buffer.from('ignored'));
    const onFrame = () => Promise.resolve<'continue'>('continue');
    for (const deadlineMs of [0, -1, 1.5, Number.NaN]) {
      await expect(
        session.streamFrames({
          maxFrames: 900,
          maxBytesPerFrame: 1024,
          deadlineMs,
          onFrame,
        }),
      ).rejects.toBeInstanceOf(ScreeningDeadlineExceededError);
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
