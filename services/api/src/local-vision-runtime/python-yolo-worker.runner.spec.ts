import { ConfigService } from '@nestjs/config';
import {
  DetectJob,
  MAX_WORKER_OUTPUT_BYTES,
  PythonYoloWorkerRunner,
  RunCommand,
  RunCommandOptions,
  buildChildEnv,
  classifyWorkerFailure,
  normalizePythonBinary,
  sanitizeRunnerFrames,
} from './python-yolo-worker.runner';

function configWith(values: Record<string, string | undefined> = {}): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

const probeJob = {
  modelFile: 'C:\\registry\\yolo-retail-v1\\model.pt',
  inputSize: 640,
  device: 'auto' as const,
  timeoutMs: 30_000,
};

function detectJob(overrides: Partial<DetectJob> = {}): DetectJob {
  return {
    ...probeJob,
    confThreshold: 0.25,
    maxDetectionsPerFrame: 4,
    width: 16,
    height: 16,
    frames: [
      { index: 0, timestampMs: 0 },
      { index: 1, timestampMs: 500 },
    ],
    classCount: 5,
    ...overrides,
  };
}

function okDetectDocument(frames: unknown) {
  return Buffer.from(
    JSON.stringify({
      protocol: 1,
      status: 'OK',
      mode: 'detect',
      device: 'cuda',
      runtimeVersion: '8.3.40',
      elapsedMs: 120,
      frames,
    }),
  );
}

function runnerReturning(stdout: Buffer | (() => Promise<{ stdout: Buffer }>)) {
  const calls: { binary: string; args: string[]; options: RunCommandOptions }[] =
    [];
  const run: RunCommand = async (binary, args, options) => {
    calls.push({ binary, args, options });
    if (typeof stdout === 'function') {
      return stdout();
    }
    return { stdout };
  };
  return { run, calls };
}

describe('PythonYoloWorkerRunner — failure classification', () => {
  it('maps a missing interpreter (ENOENT) to LOCAL_RUNTIME_NOT_INSTALLED', async () => {
    const { run } = runnerReturning(() => Promise.reject({ code: 'ENOENT' }));
    const runner = new PythonYoloWorkerRunner(configWith(), run);
    expect(await runner.probe(probeJob)).toEqual({
      ok: false,
      reasonCode: 'LOCAL_RUNTIME_NOT_INSTALLED',
    });
  });

  it.each([
    [2, 'LOCAL_RUNTIME_NOT_INSTALLED'],
    [3, 'MODEL_LOAD_FAILED'],
    [4, 'INFERENCE_FAILED'],
    [5, 'RUNTIME_OUTPUT_INVALID'],
    [6, 'LOCAL_RUNTIME_PROBE_FAILED'],
    [99, 'INFERENCE_FAILED'],
  ])('maps worker exit code %p to %p on detect', async (code, reasonCode) => {
    const { run } = runnerReturning(() => Promise.reject({ code }));
    const runner = new PythonYoloWorkerRunner(configWith(), run);
    expect(await runner.detect(detectJob(), Buffer.alloc(2 * 16 * 16 * 3))).toEqual({
      ok: false,
      reasonCode,
    });
  });

  it('maps a timeout kill to INFERENCE_TIMEOUT (detect) and LOCAL_RUNTIME_PROBE_FAILED (probe)', () => {
    expect(classifyWorkerFailure({ killed: true, signal: 'SIGKILL' }, 'detect')).toBe(
      'INFERENCE_TIMEOUT',
    );
    expect(classifyWorkerFailure({ signal: 'SIGKILL' }, 'probe')).toBe(
      'LOCAL_RUNTIME_PROBE_FAILED',
    );
    expect(classifyWorkerFailure({ code: 'EACCES' }, 'detect')).toBe(
      'INFERENCE_FAILED',
    );
    expect(classifyWorkerFailure({ code: 99 }, 'probe')).toBe(
      'LOCAL_RUNTIME_PROBE_FAILED',
    );
  });

  it('maps an stdout overflow to RUNTIME_OUTPUT_TOO_LARGE and never throws', async () => {
    const { run } = runnerReturning(() =>
      Promise.reject({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }),
    );
    const runner = new PythonYoloWorkerRunner(configWith(), run);
    expect(await runner.probe(probeJob)).toEqual({
      ok: false,
      reasonCode: 'RUNTIME_OUTPUT_TOO_LARGE',
    });
    const thrower = new PythonYoloWorkerRunner(configWith(), () => {
      throw new Error('spawn exploded: /usr/bin/python');
    });
    const outcome = await thrower.probe(probeJob);
    expect(outcome.ok).toBe(false);
    expect(JSON.stringify(outcome)).not.toContain('/usr/bin');
  });

  it.each([
    Buffer.from('not json'),
    Buffer.from('[]'),
    Buffer.from(JSON.stringify({ protocol: 2, status: 'OK', mode: 'detect', frames: [] })),
    Buffer.from(JSON.stringify({ protocol: 1, status: 'OK', mode: 'probe', frames: [] })),
    Buffer.from(JSON.stringify({ protocol: 1, status: 'ERROR', code: 'X' })),
    Buffer.from(JSON.stringify({ protocol: 1, status: 'OK', mode: 'detect', frames: 'x' })),
  ])('rejects garbage / wrong-protocol stdout as RUNTIME_OUTPUT_INVALID', async (stdout) => {
    const { run } = runnerReturning(stdout);
    const runner = new PythonYoloWorkerRunner(configWith(), run);
    expect(await runner.detect(detectJob(), Buffer.alloc(2 * 16 * 16 * 3))).toEqual({
      ok: false,
      reasonCode: 'RUNTIME_OUTPUT_INVALID',
    });
  });

  it('rejects a probe document without a positive class count', async () => {
    const { run } = runnerReturning(
      Buffer.from(JSON.stringify({ protocol: 1, status: 'OK', mode: 'probe', classCount: 0 })),
    );
    const runner = new PythonYoloWorkerRunner(configWith(), run);
    expect(await runner.probe(probeJob)).toEqual({
      ok: false,
      reasonCode: 'RUNTIME_OUTPUT_INVALID',
    });
  });
});

describe('PythonYoloWorkerRunner — invocation shape', () => {
  it('writes the probe header line and caps stdout / timeout', async () => {
    const { run, calls } = runnerReturning(
      Buffer.from(
        JSON.stringify({
          protocol: 1,
          status: 'OK',
          mode: 'probe',
          classCount: 80,
          device: 'cpu',
          runtimeVersion: '8.3.40',
          elapsedMs: 900.4,
        }),
      ),
    );
    const runner = new PythonYoloWorkerRunner(configWith(), run);
    const outcome = await runner.probe({ ...probeJob, timeoutMs: 999_999 });
    expect(outcome).toEqual({
      ok: true,
      classCount: 80,
      device: 'CPU',
      runtimeVersion: '8.3.40',
      elapsedMs: 900,
    });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.binary).toBe('python');
    expect(call.args).toHaveLength(2);
    expect(call.args[0]).toMatch(/yolo_detect_worker\.py$/);
    expect(call.args[1]).toBe('--probe');
    expect(call.options.maxOutputBytes).toBe(MAX_WORKER_OUTPUT_BYTES);
    expect(call.options.timeoutMs).toBe(120_000);
    const header = JSON.parse(call.options.stdin.toString('utf8').trimEnd());
    expect(header).toEqual({
      protocol: 1,
      mode: 'probe',
      modelFile: probeJob.modelFile,
      inputSize: 640,
      device: 'auto',
    });
    expect(call.options.stdin.toString('utf8').endsWith('\n')).toBe(true);
  });

  it('writes the detect header line followed by exactly the frame bytes', async () => {
    const { run, calls } = runnerReturning(okDetectDocument([]));
    const runner = new PythonYoloWorkerRunner(configWith(), run);
    const job = detectJob();
    const pixels = Buffer.alloc(2 * 16 * 16 * 3, 7);
    const outcome = await runner.detect(job, pixels);
    expect(outcome).toEqual({
      ok: true,
      device: 'CUDA',
      runtimeVersion: '8.3.40',
      elapsedMs: 120,
      frames: [],
    });
    const [call] = calls;
    expect(call.args[1]).toBe('--detect');
    expect(call.options.timeoutMs).toBe(30_000);
    const stdin = call.options.stdin;
    const newline = stdin.indexOf(0x0a);
    const header = JSON.parse(stdin.subarray(0, newline).toString('utf8'));
    expect(header).toEqual({
      protocol: 1,
      mode: 'detect',
      modelFile: probeJob.modelFile,
      inputSize: 640,
      device: 'auto',
      confThreshold: 0.25,
      maxDetectionsPerFrame: 4,
      width: 16,
      height: 16,
      frames: [
        { index: 0, timestampMs: 0 },
        { index: 1, timestampMs: 500 },
      ],
    });
    expect(stdin.subarray(newline + 1).equals(pixels)).toBe(true);
  });

  it('refuses a payload whose byte length does not match the header', async () => {
    const { run, calls } = runnerReturning(okDetectDocument([]));
    const runner = new PythonYoloWorkerRunner(configWith(), run);
    expect(await runner.detect(detectJob(), Buffer.alloc(5))).toEqual({
      ok: false,
      reasonCode: 'INFERENCE_FAILED',
    });
    expect(await runner.detect(detectJob({ frames: [] }), Buffer.alloc(0))).toEqual({
      ok: false,
      reasonCode: 'INFERENCE_FAILED',
    });
    expect(calls).toHaveLength(0);
  });

  it('passes a MINIMAL environment to the child — never secrets', () => {
    const env = buildChildEnv({
      PATH: '/usr/bin',
      Path: 'C:\\Windows',
      DATABASE_URL: 'postgresql://byond:byond@localhost:5433/byond_dev',
      JWT_SECRET: 'deadbeef',
      PICKUP_VLM_API_KEY: 'sk-secret',
      SystemRoot: 'C:\\Windows',
      TEMP: 'C:\\Temp',
      CUDA_VISIBLE_DEVICES: '0',
      SOME_RANDOM_TOKEN: 'x',
    });
    expect(env).toEqual({
      PATH: '/usr/bin',
      Path: 'C:\\Windows',
      SystemRoot: 'C:\\Windows',
      TEMP: 'C:\\Temp',
      CUDA_VISIBLE_DEVICES: '0',
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
      PYTHONDONTWRITEBYTECODE: '1',
      YOLO_VERBOSE: 'False',
    });
    expect(JSON.stringify(env)).not.toMatch(/DATABASE_URL|JWT_SECRET|API_KEY|secret/);
  });

  it('accepts a bare interpreter name or a clean absolute path, nothing else', () => {
    expect(normalizePythonBinary(undefined)).toBe('python');
    expect(normalizePythonBinary('  ')).toBe('python');
    expect(normalizePythonBinary('python3.12')).toBe('python3.12');
    expect(normalizePythonBinary('C:\\Python312\\python.exe')).toBe(
      'C:\\Python312\\python.exe',
    );
    expect(normalizePythonBinary('/usr/bin/python3')).toBe('/usr/bin/python3');
    expect(normalizePythonBinary('python; rm -rf /')).toBeNull();
    expect(normalizePythonBinary('$(python)')).toBeNull();
    expect(normalizePythonBinary('../python')).toBeNull();
    expect(normalizePythonBinary('/usr/bin/../python')).toBeNull();
    expect(normalizePythonBinary('bin/python')).toBeNull();
  });

  it('reports LOCAL_RUNTIME_NOT_INSTALLED for an unsafe interpreter setting without spawning', async () => {
    const { run, calls } = runnerReturning(okDetectDocument([]));
    const runner = new PythonYoloWorkerRunner(
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

describe('PythonYoloWorkerRunner — output allowlist rebuild', () => {
  it('drops out-of-range class indexes, unknown frames, and degenerate boxes; clamps and caps the rest', () => {
    const frames = sanitizeRunnerFrames(
      [
        {
          index: 0,
          detections: [
            { classIndex: 2, confidence: 0.9, box: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } },
            { classIndex: 5, confidence: 0.99, box: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } },
            { classIndex: -1, confidence: 0.99, box: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } },
            { classIndex: 1.5, confidence: 0.99, box: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } },
            { classIndex: 1, confidence: 7, box: { x: -1, y: 2, width: 0.3, height: 9 } },
            { classIndex: 1, confidence: 0.5, box: { x: 0.1, y: 0.2, width: 0, height: 0.4 } },
            { classIndex: 1, confidence: 0.4, box: { x: 0.1, y: 0.2, width: 0.3 } },
            { classIndex: 3, confidence: 0.6, box: { x: 0.5, y: 0.5, width: 0.1, height: 0.1 } },
            { classIndex: 4, confidence: 0.7, box: { x: 0.5, y: 0.5, width: 0.1, height: 0.1 } },
            { classIndex: 0, confidence: 0.3, box: { x: 0.5, y: 0.5, width: 0.1, height: 0.1 } },
            { classIndex: 0, confidence: 0.2, box: { x: 0.5, y: 0.5, width: 0.1, height: 0.1 } },
          ],
        },
        { index: 7, detections: [{ classIndex: 1, confidence: 0.9, box: { x: 0, y: 0, width: 1, height: 1 } }] },
        { index: 0, detections: [] },
        { index: 'x', detections: [] },
        null,
      ],
      { frames: [{ index: 0, timestampMs: 0 }, { index: 1, timestampMs: 500 }], classCount: 5, maxDetectionsPerFrame: 4 },
    );
    expect(frames).toEqual([
      {
        index: 0,
        detections: [
          { classIndex: 1, confidence: 1, box: { x: 0, y: 1, width: 0.3, height: 1 } },
          { classIndex: 2, confidence: 0.9, box: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } },
          { classIndex: 4, confidence: 0.7, box: { x: 0.5, y: 0.5, width: 0.1, height: 0.1 } },
          { classIndex: 3, confidence: 0.6, box: { x: 0.5, y: 0.5, width: 0.1, height: 0.1 } },
        ],
      },
    ]);
  });

  it('never carries worker strings other than the classified fields', async () => {
    const { run } = runnerReturning(
      Buffer.from(
        JSON.stringify({
          protocol: 1,
          status: 'OK',
          mode: 'detect',
          device: '/dev/nvidia0',
          runtimeVersion: 'C:\\Python312\\Lib\\site-packages\\ultralytics',
          traceback: 'File "C:\\registry\\model.pt"',
          modelFile: 'C:\\registry\\yolo-retail-v1\\model.pt',
          frames: [
            {
              index: 0,
              className: 'bottle',
              detections: [
                { classIndex: 1, confidence: 0.5, label: 'C:\\x', box: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 } },
              ],
            },
          ],
        }),
      ),
    );
    const runner = new PythonYoloWorkerRunner(configWith(), run);
    const outcome = await runner.detect(detectJob(), Buffer.alloc(2 * 16 * 16 * 3));
    expect(outcome).toEqual({
      ok: true,
      device: null,
      runtimeVersion: null,
      elapsedMs: null,
      frames: [
        {
          index: 0,
          detections: [
            { classIndex: 1, confidence: 0.5, box: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 } },
          ],
        },
      ],
    });
    const serialized = JSON.stringify(outcome);
    expect(serialized).not.toMatch(/registry|model\.pt|nvidia|site-packages|bottle|traceback/i);
  });
});
