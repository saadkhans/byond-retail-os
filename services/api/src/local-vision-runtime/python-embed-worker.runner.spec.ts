import { ConfigService } from '@nestjs/config';
import {
  EmbedJob,
  PythonEmbedWorkerRunner,
  buildEmbedHeader,
  buildEmbedProbeHeader,
  sanitizeVectors,
} from './python-embed-worker.runner';
import { RunCommand, RunCommandOptions } from './python-yolo-worker.runner';

function configWith(values: Record<string, string | undefined> = {}): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

const probeJob = {
  modelFile: null,
  pretrained: 'laion2b_s34b_b79k',
  arch: 'ViT-B-32',
  inputSize: 32,
  device: 'auto' as const,
  timeoutMs: 30_000,
};

function embedJob(overrides: Partial<EmbedJob> = {}): EmbedJob {
  return { ...probeJob, dim: 3, imageCount: 2, ...overrides };
}

function bytesFor(job: EmbedJob) {
  return Buffer.alloc(job.imageCount * job.inputSize * job.inputSize * 3, 1);
}

function okDocument(mode: 'probe' | 'embed', extra: Record<string, unknown>) {
  return Buffer.from(
    JSON.stringify({
      protocol: 1,
      status: 'OK',
      mode,
      device: 'cpu',
      runtimeVersion: '2.26.1',
      elapsedMs: 40,
      ...extra,
    }),
  );
}

function runnerReturning(stdout: Buffer | (() => Promise<{ stdout: Buffer }>)) {
  const calls: { binary: string; args: string[]; options: RunCommandOptions }[] = [];
  const run: RunCommand = async (binary, args, options) => {
    calls.push({ binary, args, options });
    return typeof stdout === 'function' ? stdout() : { stdout };
  };
  return { run, calls };
}

describe('PythonEmbedWorkerRunner — probe', () => {
  it('maps ENOENT and exit codes to classified reasons', async () => {
    for (const [failure, reasonCode] of [
      [{ code: 'ENOENT' }, 'LOCAL_RUNTIME_NOT_INSTALLED'],
      [{ code: 2 }, 'LOCAL_RUNTIME_NOT_INSTALLED'],
      [{ code: 3 }, 'MODEL_LOAD_FAILED'],
      [{ killed: true, signal: 'SIGKILL' }, 'LOCAL_RUNTIME_PROBE_FAILED'],
      [{ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }, 'RUNTIME_OUTPUT_TOO_LARGE'],
    ] as const) {
      const { run } = runnerReturning(() => Promise.reject(failure));
      const runner = new PythonEmbedWorkerRunner(configWith(), run);
      expect(await runner.probe(probeJob)).toEqual({ ok: false, reasonCode });
    }
  });

  it('rejects garbage, wrong mode, or a missing dim as RUNTIME_OUTPUT_INVALID', async () => {
    for (const stdout of [
      Buffer.from('not json'),
      okDocument('embed', { dim: 512 }),
      okDocument('probe', {}),
      okDocument('probe', { dim: 0 }),
      okDocument('probe', { dim: 1.5 }),
    ]) {
      const runner = new PythonEmbedWorkerRunner(configWith(), runnerReturning(stdout).run);
      expect(await runner.probe(probeJob)).toEqual({
        ok: false,
        reasonCode: 'RUNTIME_OUTPUT_INVALID',
      });
    }
  });

  it('returns dim, device and version on a good probe and sends a path-free header', async () => {
    const { run, calls } = runnerReturning(okDocument('probe', { dim: 512 }));
    const runner = new PythonEmbedWorkerRunner(configWith(), run);
    expect(await runner.probe(probeJob)).toEqual({
      ok: true,
      dim: 512,
      device: 'CPU',
      runtimeVersion: '2.26.1',
      elapsedMs: 40,
    });
    expect(calls[0].args[0]).toMatch(/embed_worker\.py$/);
    expect(calls[0].args[1]).toBe('--probe');
    const header = JSON.parse(calls[0].options.stdin.toString('utf8'));
    expect(header).toEqual({
      protocol: 1,
      mode: 'probe',
      modelFile: null,
      pretrained: 'laion2b_s34b_b79k',
      arch: 'ViT-B-32',
      inputSize: 32,
      device: 'auto',
    });
    expect(calls[0].options.env.DATABASE_URL).toBeUndefined();
    expect(calls[0].options.env.JWT_SECRET).toBeUndefined();
  });

  it('reports LOCAL_RUNTIME_NOT_INSTALLED for an unsafe interpreter without spawning', async () => {
    const { run, calls } = runnerReturning(okDocument('probe', { dim: 512 }));
    const runner = new PythonEmbedWorkerRunner(
      configWith({ CV_LOCAL_PYTHON_BIN: 'python && curl evil' }),
      run,
    );
    expect(await runner.probe(probeJob)).toEqual({
      ok: false,
      reasonCode: 'LOCAL_RUNTIME_NOT_INSTALLED',
    });
    expect(calls).toHaveLength(0);
  });
});

describe('PythonEmbedWorkerRunner — embed', () => {
  it('refuses a byte-math mismatch without spawning', async () => {
    const { run, calls } = runnerReturning(okDocument('embed', { vectors: [] }));
    const runner = new PythonEmbedWorkerRunner(configWith(), run);
    const job = embedJob();
    expect(await runner.embed(job, Buffer.alloc(10))).toEqual({
      ok: false,
      reasonCode: 'INFERENCE_FAILED',
    });
    expect(await runner.embed(embedJob({ imageCount: 0 }), Buffer.alloc(0))).toEqual({
      ok: false,
      reasonCode: 'INFERENCE_FAILED',
    });
    expect(calls).toHaveLength(0);
  });

  it('returns re-normalized vectors and pipes header + bytes', async () => {
    const { run, calls } = runnerReturning(
      okDocument('embed', { vectors: [[3, 4, 0], [0, 0, 2]] }),
    );
    const runner = new PythonEmbedWorkerRunner(configWith(), run);
    const job = embedJob();
    const outcome = await runner.embed(job, bytesFor(job));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.vectors).toEqual([[0.6, 0.8, 0], [0, 0, 1]]);
    expect(outcome.device).toBe('CPU');
    const stdin = calls[0].options.stdin;
    const newline = stdin.indexOf(10);
    const header = JSON.parse(stdin.subarray(0, newline).toString('utf8'));
    expect(header.mode).toBe('embed');
    expect(header.width).toBe(32);
    expect(header.height).toBe(32);
    expect(header.images).toEqual([{ index: 0 }, { index: 1 }]);
    expect(stdin.length - newline - 1).toBe(2 * 32 * 32 * 3);
    expect(calls[0].args[1]).toBe('--embed');
  });

  it('rejects wrong vector counts, lengths, or non-finite values', async () => {
    for (const vectors of [
      [[1, 0, 0]], // one vector for two images
      [[1, 0], [0, 1]], // dim 2 ≠ 3
      [[1, 0, 0], [0, Number.NaN, 0]],
      [[0, 0, 0], [1, 0, 0]], // zero vector
      'nope',
    ]) {
      const runner = new PythonEmbedWorkerRunner(
        configWith(),
        runnerReturning(okDocument('embed', { vectors })).run,
      );
      const job = embedJob();
      expect(await runner.embed(job, bytesFor(job))).toEqual({
        ok: false,
        reasonCode: 'RUNTIME_OUTPUT_INVALID',
      });
    }
  });

  it('maps a kill during embedding to INFERENCE_TIMEOUT and exit 4 to INFERENCE_FAILED', async () => {
    const job = embedJob();
    const killed = new PythonEmbedWorkerRunner(
      configWith(),
      runnerReturning(() => Promise.reject({ killed: true, signal: 'SIGKILL' })).run,
    );
    expect(await killed.embed(job, bytesFor(job))).toEqual({
      ok: false,
      reasonCode: 'INFERENCE_TIMEOUT',
    });
    const failed = new PythonEmbedWorkerRunner(
      configWith(),
      runnerReturning(() => Promise.reject({ code: 4 })).run,
    );
    expect(await failed.embed(job, bytesFor(job))).toEqual({
      ok: false,
      reasonCode: 'INFERENCE_FAILED',
    });
  });
});

describe('embed runner helpers', () => {
  it('sanitizeVectors normalizes rows and rejects shape violations', () => {
    expect(sanitizeVectors([[0, 2]], { dim: 2, imageCount: 1 })).toEqual([[0, 1]]);
    expect(sanitizeVectors([[1, 2, 3]], { dim: 2, imageCount: 1 })).toBeNull();
    expect(sanitizeVectors([[1, 2]], { dim: 2, imageCount: 2 })).toBeNull();
    expect(sanitizeVectors([[Infinity, 1]], { dim: 2, imageCount: 1 })).toBeNull();
  });

  it('headers carry the weights reference verbatim (consumed by the worker only)', () => {
    const header = JSON.parse(buildEmbedHeader(embedJob({ modelFile: 'C:\\r\\clip.pt', pretrained: null })));
    expect(header.modelFile).toBe('C:\\r\\clip.pt');
    expect(header.pretrained).toBeNull();
    expect(JSON.parse(buildEmbedProbeHeader(probeJob)).mode).toBe('probe');
  });
});
