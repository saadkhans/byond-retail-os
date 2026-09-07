import { ConfigService } from '@nestjs/config';
import { LocalEmbeddingRuntime } from './local-embedding.runtime';
import {
  EmbeddingModelResolution,
  LocalModelRegistry,
} from './local-model-registry';
import { LocalEmbeddingModelDescriptor } from './local-vision-runtime.port';
import {
  EmbedJob,
  EmbedOutcome,
  EmbedProbeJob,
  EmbedProbeOutcome,
  PythonEmbedWorkerRunner,
} from './python-embed-worker.runner';

const CHECKPOINT = 'C:\\registry\\clip-ft\\clip.pt';

const descriptor: LocalEmbeddingModelDescriptor = {
  modelId: 'clip-vit-b32',
  task: 'EMBED',
  runtime: 'OPEN_CLIP',
  format: 'HUB_CACHE',
  arch: 'ViT-B-32',
  pretrained: 'laion2b_s34b_b79k',
  dim: 4,
  version: 'laion2b',
  inputSize: 32,
};

const okResolution: EmbeddingModelResolution = {
  ok: true,
  descriptor,
  internalModelFile: null,
};

interface HarnessOptions {
  resolution?: EmbeddingModelResolution;
  probe?: EmbedProbeOutcome;
  embed?: EmbedOutcome | ((job: EmbedJob, bytes: Buffer) => EmbedOutcome);
  config?: Record<string, string>;
}

function unitVector(seed: number): number[] {
  const raw = [seed + 1, 1, 0, 0];
  const norm = Math.hypot(...raw);
  return raw.map((v) => v / norm);
}

function buildHarness(options: HarnessOptions = {}) {
  const config = {
    get: (key: string) => options.config?.[key],
  } as unknown as ConfigService;
  const registry = {
    resolveEmbedding: jest.fn(async () => options.resolution ?? okResolution),
  } as unknown as LocalModelRegistry;
  const probeCalls: EmbedProbeJob[] = [];
  const embedCalls: { job: EmbedJob; bytes: Buffer }[] = [];
  const runner = {
    probe: jest.fn(async (job: EmbedProbeJob) => {
      probeCalls.push(job);
      return (
        options.probe ?? {
          ok: true,
          dim: 4,
          device: 'CPU',
          runtimeVersion: '2.26.1',
          elapsedMs: 5,
        }
      );
    }),
    embed: jest.fn(async (job: EmbedJob, bytes: Buffer) => {
      embedCalls.push({ job, bytes });
      if (typeof options.embed === 'function') {
        return options.embed(job, bytes);
      }
      return (
        options.embed ?? {
          ok: true,
          vectors: Array.from({ length: job.imageCount }, (_row, index) => unitVector(index)),
          device: 'CPU',
          runtimeVersion: '2.26.1',
          elapsedMs: 7,
        }
      );
    }),
  } as unknown as PythonEmbedWorkerRunner;
  const runtime = new LocalEmbeddingRuntime(config, registry, runner);
  return { runtime, probeCalls, embedCalls };
}

function image(width: number, height: number, value = 3) {
  return { width, height, rgb: Buffer.alloc(width * height * 3, value) };
}

describe('LocalEmbeddingRuntime.status', () => {
  it('passes registry failures through as UNAVAILABLE codes without probing', async () => {
    const { runtime, probeCalls } = buildHarness({
      resolution: { ok: false, reasonCode: 'MODEL_NOT_CONFIGURED' },
    });
    expect(await runtime.status()).toEqual({
      availability: 'UNAVAILABLE',
      reasonCode: 'MODEL_NOT_CONFIGURED',
      model: null,
      device: null,
      runtimeVersion: null,
    });
    expect(probeCalls).toHaveLength(0);
  });

  it('is READY when the probe agrees with the declared dim, with a path-free status', async () => {
    const { runtime, probeCalls } = buildHarness({
      resolution: { ...okResolution, internalModelFile: CHECKPOINT },
    });
    const status = await runtime.status();
    expect(status.availability).toBe('READY');
    expect(status.model).toEqual(descriptor);
    expect(status.device).toBe('CPU');
    expect(JSON.stringify(status)).not.toContain(CHECKPOINT);
    expect(JSON.stringify(status)).not.toContain('registry');
    expect(probeCalls[0].modelFile).toBe(CHECKPOINT);
    expect(probeCalls[0].pretrained).toBe('laion2b_s34b_b79k');
  });

  it('fails CLOSED with MODEL_MANIFEST_MISMATCH when the encoder dim differs', async () => {
    const { runtime } = buildHarness({
      probe: { ok: true, dim: 768, device: 'CUDA', runtimeVersion: '2.26.1', elapsedMs: 1 },
    });
    const status = await runtime.status();
    expect(status.availability).toBe('UNAVAILABLE');
    expect(status.reasonCode).toBe('MODEL_MANIFEST_MISMATCH');
  });

  it('surfaces a probe failure code and memoizes the probe', async () => {
    const { runtime, probeCalls } = buildHarness({
      probe: { ok: false, reasonCode: 'LOCAL_RUNTIME_NOT_INSTALLED' },
    });
    expect((await runtime.status()).reasonCode).toBe('LOCAL_RUNTIME_NOT_INSTALLED');
    await runtime.status();
    expect(probeCalls).toHaveLength(1);
  });
});

describe('LocalEmbeddingRuntime.embed', () => {
  it('letterboxes every image to the model input and returns one vector per image', async () => {
    const { runtime, embedCalls } = buildHarness();
    const result = await runtime.embed([image(10, 40), image(32, 32), image(64, 16)]);
    expect(result.status).toBe('OK');
    expect(result.vectors).toHaveLength(3);
    expect(result.dim).toBe(4);
    expect(result.model?.modelId).toBe('clip-vit-b32');
    expect(embedCalls).toHaveLength(1);
    expect(embedCalls[0].job.inputSize).toBe(32);
    expect(embedCalls[0].job.imageCount).toBe(3);
    expect(embedCalls[0].job.dim).toBe(4);
    expect(embedCalls[0].bytes.length).toBe(3 * 32 * 32 * 3);
    expect(JSON.stringify(result)).not.toContain('registry');
  });

  it('splits more than 64 images into several worker calls, preserving order', async () => {
    const { runtime, embedCalls } = buildHarness();
    const result = await runtime.embed(Array.from({ length: 70 }, () => image(8, 8)));
    expect(result.status).toBe('OK');
    expect(result.vectors).toHaveLength(70);
    expect(embedCalls.map((call) => call.job.imageCount)).toEqual([64, 6]);
  });

  it('reports UNAVAILABLE without spawning when the model is not ready', async () => {
    const { runtime, embedCalls } = buildHarness({
      resolution: { ok: false, reasonCode: 'MODEL_NOT_FOUND' },
    });
    const result = await runtime.embed([image(8, 8)]);
    expect(result).toMatchObject({ status: 'UNAVAILABLE', reasonCode: 'MODEL_NOT_FOUND', vectors: null });
    expect(embedCalls).toHaveLength(0);
  });

  it('rejects malformed images and empty input as FAILED / INFERENCE_FAILED', async () => {
    const { runtime, embedCalls } = buildHarness();
    expect(await runtime.embed([])).toMatchObject({ status: 'FAILED', reasonCode: 'INFERENCE_FAILED' });
    expect(
      await runtime.embed([{ width: 8, height: 8, rgb: Buffer.alloc(5) }]),
    ).toMatchObject({ status: 'FAILED', reasonCode: 'INFERENCE_FAILED' });
    expect(embedCalls).toHaveLength(0);
  });

  it('passes a worker failure through as FAILED with its code', async () => {
    const { runtime } = buildHarness({ embed: { ok: false, reasonCode: 'INFERENCE_TIMEOUT' } });
    expect(await runtime.embed([image(8, 8)])).toMatchObject({
      status: 'FAILED',
      reasonCode: 'INFERENCE_TIMEOUT',
      vectors: null,
    });
  });

  it('honours the configured timeout and device on the worker job', async () => {
    const { runtime, embedCalls } = buildHarness({
      config: { CV_LOCAL_EMBED_TIMEOUT_MS: '9000', CV_LOCAL_YOLO_DEVICE: 'cuda' },
    });
    await runtime.embed([image(8, 8)]);
    expect(embedCalls[0].job.timeoutMs).toBe(9000);
    expect(embedCalls[0].job.device).toBe('cuda');
  });
});
