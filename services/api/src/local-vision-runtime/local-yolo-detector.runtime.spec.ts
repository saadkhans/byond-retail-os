import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { PickupAnalysisFrameDecoder } from '../pickup-detection/analysis/analysis-frames';
import { AnalysisFrame } from '../pickup-detection/analysis/pickup-analyzer';
import {
  ExtractionFailedError,
  ExtractorUnavailableError,
} from '../video-ingest/extraction/video-frame-extractor.port';
import { LocalVideoStorageAdapter } from '../video-ingest/storage/local-video-storage.adapter';
import { LocalModelRegistry, ModelResolution } from './local-model-registry';
import { LocalModelDescriptor } from './local-vision-runtime.port';
import {
  LocalYoloDetectorRuntime,
  MAX_ANALYSIS_FRAMES,
  boundedAnalysisGeometry,
  effectiveSamplingFps,
  subsampleFrames,
} from './local-yolo-detector.runtime';
import {
  DetectJob,
  DetectOutcome,
  ProbeJob,
  ProbeOutcome,
  PythonYoloWorkerRunner,
} from './python-yolo-worker.runner';

const MODEL_FILE = 'C:\\registry\\yolo-retail-v1\\model.pt';
const STORAGE_KEY = 'tenant-a/1234-abcd/source.mp4';
const INTERNAL_PATH = 'C:\\video-store\\tenant-a\\1234-abcd\\source.mp4';

const descriptor: LocalModelDescriptor = {
  modelId: 'yolo-retail-v1',
  task: 'DETECT',
  runtime: 'ULTRALYTICS',
  format: 'PT',
  version: '1.0.0',
  inputSize: 640,
  classCount: 4,
  roleClassCounts: { PRODUCT: 2, HAND: 1, PERSON: 0, OBJECT: 0 },
};

const okResolution: ModelResolution = {
  ok: true,
  descriptor,
  // class 0 → PRODUCT, 1 → PRODUCT, 2 → HAND, 3 → unmapped (dropped)
  classRoles: ['PRODUCT', 'PRODUCT', 'HAND', null],
  internalModelFile: MODEL_FILE,
};

interface HarnessOptions {
  provider?: string;
  resolution?: ModelResolution;
  probe?: ProbeOutcome;
  detect?: DetectOutcome | ((job: DetectJob, bytes: Buffer) => DetectOutcome);
  asset?: Record<string, unknown> | null;
  frames?: AnalysisFrame[] | (() => Promise<AnalysisFrame[]>);
  config?: Record<string, string>;
}

function frame(index: number, timestampMs: number, bytes: number): AnalysisFrame {
  return { index, timestampMs, rgb: Buffer.alloc(bytes, index & 0xff) };
}

function buildHarness(options: HarnessOptions = {}) {
  const config = {
    get: (key: string) =>
      key === 'CV_PRETRAINED_PROVIDER'
        ? (options.provider ?? 'yolo_local')
        : options.config?.[key],
  } as unknown as ConfigService;
  const prisma = {
    videoAsset: {
      findFirst: jest.fn(async () =>
        options.asset === undefined
          ? {
              storageKey: STORAGE_KEY,
              width: 1280,
              height: 720,
              durationMs: 10_000,
              status: 'READY',
            }
          : options.asset,
      ),
    },
  };
  const registry = {
    resolve: jest.fn(async () => options.resolution ?? okResolution),
  } as unknown as LocalModelRegistry;
  const probeCalls: ProbeJob[] = [];
  const detectCalls: { job: DetectJob; bytes: Buffer }[] = [];
  const runner = {
    probe: jest.fn(async (job: ProbeJob) => {
      probeCalls.push(job);
      return (
        options.probe ?? {
          ok: true,
          classCount: 4,
          device: 'CUDA',
          runtimeVersion: '8.3.40',
          elapsedMs: 500,
        }
      );
    }),
    detect: jest.fn(async (job: DetectJob, bytes: Buffer) => {
      detectCalls.push({ job, bytes });
      const detect = options.detect;
      return typeof detect === 'function'
        ? detect(job, bytes)
        : (detect ?? {
            ok: true,
            device: 'CUDA',
            runtimeVersion: '8.3.40',
            elapsedMs: 900,
            frames: [],
          });
    }),
  } as unknown as PythonYoloWorkerRunner;
  const storage = {
    internalPathFor: jest.fn(() => INTERNAL_PATH),
  } as unknown as LocalVideoStorageAdapter;
  const decoderCalls: unknown[][] = [];
  const decoder = {
    decodeAnalysisFrames: jest.fn(async (...args: unknown[]) => {
      decoderCalls.push(args);
      const frames = options.frames;
      if (typeof frames === 'function') {
        return frames();
      }
      // Default: 640x360 geometry from a 1280x720 clip → 691200 bytes.
      return frames ?? [frame(0, 0, 640 * 360 * 3), frame(1, 500, 640 * 360 * 3)];
    }),
  } as unknown as PickupAnalysisFrameDecoder;
  const runtime = new LocalYoloDetectorRuntime(
    config,
    prisma as unknown as PrismaService,
    registry,
    runner,
    storage,
    decoder,
  );
  return { runtime, prisma, registry, runner, storage, decoder, probeCalls, detectCalls, decoderCalls };
}

describe('LocalYoloDetectorRuntime.status', () => {
  it('is DISABLED without touching the registry or spawning when the provider is classical', async () => {
    const { runtime, registry, runner } = buildHarness({ provider: 'classical' });
    expect(await runtime.status()).toEqual({
      availability: 'DISABLED',
      reasonCode: 'PROVIDER_NOT_ENABLED',
      model: null,
      device: null,
      runtimeVersion: null,
    });
    expect(registry.resolve).not.toHaveBeenCalled();
    expect(runner.probe).not.toHaveBeenCalled();
  });

  it('passes registry failure codes through as UNAVAILABLE without probing', async () => {
    const { runtime, runner } = buildHarness({
      resolution: { ok: false, reasonCode: 'MODEL_NOT_FOUND' },
    });
    expect(await runtime.status()).toEqual({
      availability: 'UNAVAILABLE',
      reasonCode: 'MODEL_NOT_FOUND',
      model: null,
      device: null,
      runtimeVersion: null,
    });
    expect(runner.probe).not.toHaveBeenCalled();
  });

  it('passes probe failure codes through as UNAVAILABLE and keeps the safe descriptor', async () => {
    const { runtime } = buildHarness({
      probe: { ok: false, reasonCode: 'LOCAL_RUNTIME_NOT_INSTALLED' },
    });
    const status = await runtime.status();
    expect(status.availability).toBe('UNAVAILABLE');
    expect(status.reasonCode).toBe('LOCAL_RUNTIME_NOT_INSTALLED');
    expect(status.model).toEqual(descriptor);
    expect(JSON.stringify(status)).not.toContain('registry');
  });

  it('flags a class-count mismatch between manifest and loaded model', async () => {
    const { runtime } = buildHarness({
      probe: { ok: true, classCount: 80, device: 'CPU', runtimeVersion: null, elapsedMs: 1 },
    });
    const status = await runtime.status();
    expect(status.availability).toBe('UNAVAILABLE');
    expect(status.reasonCode).toBe('MODEL_MANIFEST_MISMATCH');
  });

  it('is READY after a successful probe, memoizes the probe, and collapses concurrent probes', async () => {
    const { runtime, probeCalls } = buildHarness({ provider: 'hybrid' });
    const [a, b] = await Promise.all([runtime.status(), runtime.status()]);
    expect(a).toEqual({
      availability: 'READY',
      reasonCode: null,
      model: descriptor,
      device: 'CUDA',
      runtimeVersion: '8.3.40',
    });
    expect(b).toEqual(a);
    await runtime.status();
    expect(probeCalls).toHaveLength(1);
    expect(probeCalls[0]).toEqual({
      modelFile: MODEL_FILE,
      inputSize: 640,
      device: 'auto',
      timeoutMs: 60_000,
    });
  });

  it('never rejects even when a collaborator throws', async () => {
    const { runtime } = buildHarness();
    (runtime as unknown as { registry: { resolve: () => Promise<never> } }).registry = {
      resolve: () => Promise.reject(new Error('boom C:\\registry')),
    };
    const status = await runtime.status();
    expect(status.availability).toBe('UNAVAILABLE');
    expect(JSON.stringify(status)).not.toContain('registry');
  });
});

describe('LocalYoloDetectorRuntime.detect', () => {
  it('returns UNAVAILABLE with the status code when not READY and never reads the clip', async () => {
    const { runtime, prisma } = buildHarness({ provider: 'classical' });
    const result = await runtime.detect({ tenantId: 't1', videoAssetId: 'v1' });
    expect(result.status).toBe('UNAVAILABLE');
    expect(result.reasonCode).toBe('PROVIDER_NOT_ENABLED');
    expect(result.frames).toEqual([]);
    expect(prisma.videoAsset.findFirst).not.toHaveBeenCalled();
  });

  it('reads the clip TENANT-SCOPED and reports CLIP_NOT_FOUND for another tenant', async () => {
    const { runtime, prisma, decoder } = buildHarness({ asset: null });
    const result = await runtime.detect({ tenantId: 'tenant-b', videoAssetId: 'v1' });
    expect(prisma.videoAsset.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'v1', tenantId: 'tenant-b' } }),
    );
    expect(result.status).toBe('UNAVAILABLE');
    expect(result.reasonCode).toBe('CLIP_NOT_FOUND');
    expect(decoder.decodeAnalysisFrames).not.toHaveBeenCalled();
  });

  it('reports CLIP_NOT_DECODABLE for a clip without stored media or geometry', async () => {
    const { runtime } = buildHarness({
      asset: { storageKey: null, width: 1280, height: 720, durationMs: 1000, status: 'READY' },
    });
    const result = await runtime.detect({ tenantId: 't1', videoAssetId: 'v1' });
    expect(result.reasonCode).toBe('CLIP_NOT_DECODABLE');
  });

  it('maps decoder failures: no frames → NO_FRAMES_DECODED, tooling missing → CLIP_NOT_DECODABLE', async () => {
    const noFrames = buildHarness({
      frames: () => Promise.reject(new ExtractionFailedError()),
    });
    expect(
      (await noFrames.runtime.detect({ tenantId: 't1', videoAssetId: 'v1' })).reasonCode,
    ).toBe('NO_FRAMES_DECODED');
    const empty = buildHarness({ frames: [] });
    expect(
      (await empty.runtime.detect({ tenantId: 't1', videoAssetId: 'v1' })).reasonCode,
    ).toBe('NO_FRAMES_DECODED');
    const noTooling = buildHarness({
      frames: () => Promise.reject(new ExtractorUnavailableError()),
    });
    expect(
      (await noTooling.runtime.detect({ tenantId: 't1', videoAssetId: 'v1' })).reasonCode,
    ).toBe('CLIP_NOT_DECODABLE');
  });

  it('decodes through the local storage path seam and passes analysis geometry + bytes to the worker', async () => {
    const { runtime, storage, decoderCalls, detectCalls } = buildHarness({
      config: { CV_LOCAL_YOLO_FPS: '3', CV_LOCAL_YOLO_CONF_THRESHOLD: '0.4' },
    });
    const result = await runtime.detect({ tenantId: 't1', videoAssetId: 'v1' });
    expect(storage.internalPathFor).toHaveBeenCalledWith(STORAGE_KEY);
    expect(decoderCalls[0]).toEqual([
      INTERNAL_PATH,
      3,
      { width: 640, height: 360 },
      10_000,
    ]);
    expect(detectCalls).toHaveLength(1);
    const { job, bytes } = detectCalls[0];
    expect(job).toEqual({
      modelFile: MODEL_FILE,
      inputSize: 640,
      device: 'auto',
      timeoutMs: 60_000,
      confThreshold: 0.4,
      maxDetectionsPerFrame: 32,
      width: 640,
      height: 360,
      frames: [
        { index: 0, timestampMs: 0 },
        { index: 1, timestampMs: 500 },
      ],
      classCount: 4,
    });
    expect(bytes.length).toBe(2 * 640 * 360 * 3);
    expect(result.status).toBe('OK');
    expect(result.analysisDims).toEqual({ width: 640, height: 360 });
    expect(result.sampledFps).toBe(3);
  });

  it('never asks the decoder for more frames than the worker sample (P2 memory budget)', async () => {
    // 300 s clip at the fps ceiling would decode 2400 frames (192 MiB
    // retained by the decoder budget) only to keep 32 — cap the cadence
    // up front so at most 32 frames are ever retained.
    const { runtime, decoderCalls } = buildHarness({
      config: { CV_LOCAL_YOLO_FPS: '8' },
      asset: {
        storageKey: STORAGE_KEY,
        width: 1280,
        height: 720,
        durationMs: 300_000,
        status: 'READY',
      },
    });
    const result = await runtime.detect({ tenantId: 't1', videoAssetId: 'v1' });
    expect(result.status).toBe('OK');
    expect(decoderCalls[0][1]).toBe(0.106); // floor(32 / 300 s, millifps)
    expect(result.sampledFps).toBe(0.106);
    expect(effectiveSamplingFps(2, 10_000)).toBe(2);
    expect(effectiveSamplingFps(8, 10_000)).toBe(3.2);
    expect(effectiveSamplingFps(8, 0)).toBeGreaterThan(0);
  });

  it('bounds the analysis geometry to the worker edge ceiling for extreme aspect ratios', () => {
    expect(boundedAnalysisGeometry({ width: 1280, height: 720 })).toEqual({ width: 640, height: 360 });
    expect(boundedAnalysisGeometry({ width: 464, height: 832 })).toEqual({ width: 464, height: 832 });
    // A 100 x 10000 source scales by 4096/10000 so the worker never sees
    // an edge above 4096 px, and nothing is ever upscaled.
    const tall = boundedAnalysisGeometry({ width: 100, height: 10_000 });
    expect(tall.height).toBe(4096);
    expect(tall.width).toBe(40);
    expect(boundedAnalysisGeometry({ width: 20, height: 20 })).toEqual({ width: 20, height: 20 });
  });

  it('caps the frames sent to the worker at 32, evenly subsampled', async () => {
    const bytes = 640 * 360 * 3;
    const decoded = Array.from({ length: 100 }, (_, i) => frame(i, i * 100, bytes));
    const { runtime, detectCalls } = buildHarness({ frames: decoded });
    const result = await runtime.detect({ tenantId: 't1', videoAssetId: 'v1' });
    expect(detectCalls[0].job.frames).toHaveLength(MAX_ANALYSIS_FRAMES);
    expect(detectCalls[0].bytes.length).toBe(MAX_ANALYSIS_FRAMES * bytes);
    expect(detectCalls[0].job.frames[0]).toEqual({ index: 0, timestampMs: 0 });
    // Frame 31 of 32 picks source index floor(31 * 100 / 32) = 96.
    expect(detectCalls[0].job.frames[31].timestampMs).toBe(9_600);
    expect(result.frames).toHaveLength(MAX_ANALYSIS_FRAMES);
    expect(result.sampledFps).toBe(3.2);
    expect(subsampleFrames([1, 2, 3], 5)).toEqual([1, 2, 3]);
    expect(subsampleFrames([0, 1, 2, 3, 4, 5, 6, 7], 4)).toEqual([0, 2, 4, 6]);
  });

  it('maps class indexes onto roles and DROPS unmapped classes', async () => {
    const { runtime } = buildHarness({
      detect: {
        ok: true,
        device: 'CPU',
        runtimeVersion: '8.3.40',
        elapsedMs: 700,
        frames: [
          {
            index: 1,
            detections: [
              { classIndex: 0, confidence: 0.9, box: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } },
              { classIndex: 2, confidence: 0.8, box: { x: 0.15, y: 0.15, width: 0.1, height: 0.1 } },
              { classIndex: 3, confidence: 0.99, box: { x: 0.5, y: 0.5, width: 0.1, height: 0.1 } },
            ],
          },
        ],
      },
    });
    const result = await runtime.detect({ tenantId: 't1', videoAssetId: 'v1' });
    expect(result).toEqual({
      status: 'OK',
      reasonCode: null,
      model: descriptor,
      device: 'CPU',
      analysisDims: { width: 640, height: 360 },
      sampledFps: 2,
      elapsedMs: 700,
      frames: [
        { frameIndex: 0, timestampMs: 0, detections: [] },
        {
          frameIndex: 1,
          timestampMs: 500,
          detections: [
            { role: 'PRODUCT', classIndex: 0, confidence: 0.9, box: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } },
            { role: 'HAND', classIndex: 2, confidence: 0.8, box: { x: 0.15, y: 0.15, width: 0.1, height: 0.1 } },
          ],
        },
      ],
    });
  });

  it('passes worker failure codes through as FAILED and never throws', async () => {
    const failing = buildHarness({
      detect: { ok: false, reasonCode: 'INFERENCE_TIMEOUT' },
    });
    const result = await failing.runtime.detect({ tenantId: 't1', videoAssetId: 'v1' });
    expect(result.status).toBe('FAILED');
    expect(result.reasonCode).toBe('INFERENCE_TIMEOUT');
    expect(result.model).toEqual(descriptor);

    const throwing = buildHarness({
      detect: () => {
        throw new Error(`exploded at ${INTERNAL_PATH}`);
      },
    });
    const thrown = await throwing.runtime.detect({ tenantId: 't1', videoAssetId: 'v1' });
    expect(thrown.status).toBe('FAILED');
    expect(thrown.reasonCode).toBe('INFERENCE_FAILED');
  });

  it('never leaks the storage key, internal path, or model file in any result', async () => {
    const harness = buildHarness({
      detect: { ok: false, reasonCode: 'MODEL_LOAD_FAILED' },
    });
    const results = [
      await harness.runtime.status(),
      await harness.runtime.detect({ tenantId: 't1', videoAssetId: 'v1' }),
      await buildHarness().runtime.detect({ tenantId: 't1', videoAssetId: 'v1' }),
      await buildHarness({ asset: null }).runtime.detect({ tenantId: 't1', videoAssetId: 'v1' }),
    ];
    for (const result of results) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(STORAGE_KEY);
      expect(serialized).not.toContain('source.mp4');
      expect(serialized).not.toContain('video-store');
      expect(serialized).not.toContain('registry');
      expect(serialized).not.toContain('model.pt');
      expect(serialized).not.toMatch(/[A-Za-z]:\\/);
    }
  });
});
