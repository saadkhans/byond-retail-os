import {
  ExtractionFailedError,
  ExtractionInfrastructureError,
} from '../../video-ingest/extraction/video-frame-extractor.port';
import {
  PickupAnalysisFrameDecoder,
  buildAnalysisFramesArgs,
  buildFrameAtArgs,
} from './analysis-frames';

/**
 * Whole-clip downscaled decoding: the sampled-frame total is unbounded by
 * any single constant (frame size x fps x duration), so the decoder must
 * split the clip into `-ss`/`-frames:v` chunks whose per-exec output fits
 * the 64 MiB execFile budget. A single unchunked exec is the overflow
 * regression: portrait 192x340 at the validated fps ceiling of 15 yields
 * 450 frames x 195,840 B = ~84 MiB over a 30 s clip, killing every decode
 * as a deterministic infrastructure failure.
 */
describe('PickupAnalysisFrameDecoder.decodeAnalysisFrames', () => {
  // The finding's byte math: portrait phone clip downscaled to 192x340 at
  // the top of the PICKUP_ANALYSIS_FPS validated range.
  const GEOMETRY = { width: 192, height: 340 };
  const FPS = 15;
  const FRAME_BYTES = GEOMETRY.width * GEOMETRY.height * 3;
  const MAX_DECODE_BYTES = 64 * 1024 * 1024;
  const FRAMES_PER_CHUNK = Math.floor(MAX_DECODE_BYTES / FRAME_BYTES);

  function decoderWith(
    responses: Buffer[],
    calls: { args: string[]; maxOutputBytes: number }[] = [],
  ) {
    let call = 0;
    const decoder = new PickupAnalysisFrameDecoder(async (_binary, args, maxOutputBytes) => {
      calls.push({ args, maxOutputBytes });
      const stdout = responses[Math.min(call, responses.length - 1)];
      call += 1;
      return { stdout };
    });
    return { decoder, calls };
  }

  it('builds chunk args: input seek BEFORE -i and a hard -frames:v output cap', () => {
    const args = buildAnalysisFramesArgs('/videos/clip.mp4', 15, 192, 340, 22_800, 342);
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
    expect(args[args.indexOf('-ss') + 1]).toBe('22.800');
    expect(args[args.indexOf('-frames:v') + 1]).toBe('342');
    expect(args).toContain('fps=15,scale=192:340');
  });

  it('decodes a short clip in ONE exec and keeps the i / fps timestamp cadence', async () => {
    const stdout = Buffer.alloc(5 * FRAME_BYTES);
    stdout[3 * FRAME_BYTES] = 42;
    const { decoder, calls } = decoderWith([stdout]);

    const frames = await decoder.decodeAnalysisFrames('/videos/clip.mp4', FPS, GEOMETRY);

    expect(calls).toHaveLength(1);
    expect(calls[0].args[calls[0].args.indexOf('-ss') + 1]).toBe('0.000');
    expect(frames).toHaveLength(5);
    expect(frames.map((frame) => frame.timestampMs)).toEqual([0, 67, 133, 200, 267]);
    expect(frames[3].rgb[0]).toBe(42);
    expect(frames[3].rgb.length).toBe(FRAME_BYTES);
  });

  it('splits a clip whose sampled total exceeds 64 MiB into budget-fitting chunks (portrait @ fps 15 regression)', async () => {
    // 30 s at 15 fps = 450 frames = ~84 MiB total — over the per-exec
    // budget, so a single-exec decode dies as ERR_CHILD_PROCESS_STDIO_MAXBUFFER.
    const totalFrames = 450;
    expect(totalFrames * FRAME_BYTES).toBeGreaterThan(MAX_DECODE_BYTES);
    const chunk1 = Buffer.alloc(FRAMES_PER_CHUNK * FRAME_BYTES);
    chunk1[(FRAMES_PER_CHUNK - 1) * FRAME_BYTES] = 7;
    const chunk2 = Buffer.alloc((totalFrames - FRAMES_PER_CHUNK) * FRAME_BYTES);
    chunk2[0] = 9;
    const { decoder, calls } = decoderWith([chunk1, chunk2]);

    const frames = await decoder.decodeAnalysisFrames('/videos/clip.mp4', FPS, GEOMETRY);

    expect(calls).toHaveLength(2);
    for (const { args, maxOutputBytes } of calls) {
      // Every exec's requested output — frame cap x frame size — provably
      // fits the budget it was given.
      const cap = Number(args[args.indexOf('-frames:v') + 1]);
      expect(cap).toBe(FRAMES_PER_CHUNK);
      expect(cap * FRAME_BYTES).toBeLessThanOrEqual(maxOutputBytes);
      expect(maxOutputBytes).toBe(MAX_DECODE_BYTES);
    }
    // The second chunk resumes the cadence at the first unsampled instant.
    expect(calls[1].args[calls[1].args.indexOf('-ss') + 1]).toBe(
      ((FRAMES_PER_CHUNK * 1000) / FPS / 1000).toFixed(3),
    );
    expect(frames).toHaveLength(totalFrames);
    // Indices and timestamps are GLOBAL across chunks, and each frame's
    // pixels come from its own chunk's region.
    expect(frames[FRAMES_PER_CHUNK - 1].rgb[0]).toBe(7);
    expect(frames[FRAMES_PER_CHUNK].rgb[0]).toBe(9);
    expect(frames[FRAMES_PER_CHUNK].index).toBe(FRAMES_PER_CHUNK);
    expect(frames[FRAMES_PER_CHUNK].timestampMs).toBe(
      Math.round((FRAMES_PER_CHUNK * 1000) / FPS),
    );
  });

  it('a clip that is an EXACT chunk multiple terminates on the empty follow-up chunk', async () => {
    const { decoder, calls } = decoderWith([
      Buffer.alloc(FRAMES_PER_CHUNK * FRAME_BYTES),
      Buffer.alloc(0), // seek landed past the last frame — clip is done
    ]);

    const frames = await decoder.decodeAnalysisFrames('/videos/clip.mp4', FPS, GEOMETRY);

    expect(calls).toHaveLength(2);
    expect(frames).toHaveLength(FRAMES_PER_CHUNK);
  });

  it('fails CONTROLLED (ExtractionFailedError) when the clip decodes no frames at all', async () => {
    const { decoder } = decoderWith([Buffer.alloc(0)]);

    await expect(
      decoder.decodeAnalysisFrames('/videos/clip.mp4', FPS, GEOMETRY),
    ).rejects.toBeInstanceOf(ExtractionFailedError);
  });

  it('maps execFile failures through the shared classifier — no raw stderr escapes', async () => {
    const decoder = new PickupAnalysisFrameDecoder(async () => {
      const error = new Error('ffmpeg exploded: /secret/path') as Error & {
        killed: boolean;
        signal: string;
      };
      error.killed = true;
      error.signal = 'SIGTERM';
      throw error;
    });

    await expect(
      decoder.decodeAnalysisFrames('/videos/clip.mp4', FPS, GEOMETRY),
    ).rejects.toBeInstanceOf(ExtractionInfrastructureError);
  });
});

/**
 * Per-timestamp full-resolution decoding: the fusion pipeline consumes a
 * HANDFUL of full-res instants (quiet baseline + pre/peak/post crops), so
 * each decode request must be a single-frame seek whose output budget is
 * independent of clip duration. A whole-clip full-res decode of an
 * ordinary 20-30 s clip (640x360 RGB24 at 5 fps ≈ 69-104 MiB) overflows
 * the decoder's 64 MiB execFile budget and fails supported inputs.
 */
describe('PickupAnalysisFrameDecoder.decodeFrameAt', () => {
  const GEOMETRY = { width: 640, height: 360 };
  const FRAME_BYTES = GEOMETRY.width * GEOMETRY.height * 3;

  function decoderWith(
    responses: Buffer[],
    calls: { args: string[]; maxOutputBytes: number }[] = [],
  ) {
    let call = 0;
    const decoder = new PickupAnalysisFrameDecoder(async (_binary, args, maxOutputBytes) => {
      calls.push({ args, maxOutputBytes });
      const stdout = responses[Math.min(call, responses.length - 1)];
      call += 1;
      return { stdout };
    });
    return { decoder, calls };
  }

  it('seeks with -ss BEFORE -i and stops after ONE frame (-frames:v 1)', () => {
    const args = buildFrameAtArgs('/videos/clip.mp4', 2600, 640, 360);
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
    expect(args[args.indexOf('-ss') + 1]).toBe('2.600');
    expect(args).toContain('-frames:v');
    expect(args[args.indexOf('-frames:v') + 1]).toBe('1');
    expect(args).toContain('scale=640:360');
  });

  it('requests a SINGLE-FRAME output budget — duration-independent and far below the whole-clip cap', async () => {
    const { decoder, calls } = decoderWith([Buffer.alloc(FRAME_BYTES, 7)]);

    const frame = await decoder.decodeFrameAt('/videos/clip.mp4', 2600, GEOMETRY);

    expect(frame.timestampMs).toBe(2600);
    expect(frame.rgb.length).toBe(FRAME_BYTES);
    expect(calls).toHaveLength(1);
    // The bound is per FRAME (2x slack), not per clip: even a worst-case
    // 30 s portrait pass (640x1138 full geometry) stays ~4.4 MiB per
    // request — under a tenth of the 64 MiB whole-clip budget the old
    // full-clip decode overflowed.
    expect(calls[0].maxOutputBytes).toBe(FRAME_BYTES * 2);
    const portraitFrameBudget = 640 * 1138 * 3 * 2;
    expect(portraitFrameBudget).toBeLessThan((64 * 1024 * 1024) / 10);
  });

  it('a tail-of-clip seek past the last frame retries once from 1 s earlier', async () => {
    const { decoder, calls } = decoderWith([
      Buffer.alloc(0), // seek landed past the final frame — no output
      Buffer.alloc(FRAME_BYTES, 9),
    ]);

    const frame = await decoder.decodeFrameAt('/videos/clip.mp4', 29_950, GEOMETRY);

    expect(frame.rgb[0]).toBe(9);
    expect(calls).toHaveLength(2);
    expect(calls[0].args[calls[0].args.indexOf('-ss') + 1]).toBe('29.950');
    expect(calls[1].args[calls[1].args.indexOf('-ss') + 1]).toBe('28.950');
  });

  it('fails CONTROLLED (ExtractionFailedError) when no frame decodes at all', async () => {
    const { decoder } = decoderWith([Buffer.alloc(0)]);

    await expect(
      decoder.decodeFrameAt('/videos/clip.mp4', 5000, GEOMETRY),
    ).rejects.toBeInstanceOf(ExtractionFailedError);
  });

  it('maps execFile failures through the shared classifier — no raw stderr escapes', async () => {
    const decoder = new PickupAnalysisFrameDecoder(async () => {
      const error = new Error('ffmpeg exploded: /secret/path') as Error & {
        killed: boolean;
        signal: string;
      };
      error.killed = true;
      error.signal = 'SIGTERM';
      throw error;
    });

    await expect(
      decoder.decodeFrameAt('/videos/clip.mp4', 5000, GEOMETRY),
    ).rejects.toBeInstanceOf(ExtractionInfrastructureError);
  });
});
