import { spawn } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LocalRuntimeReasonCode } from './local-vision-runtime.port';

/**
 * LOCAL Python worker runner for Ultralytics-YOLO-class detection.
 *
 * Confinement mirrors the ffmpeg/tesseract adapters: the interpreter is
 * resolved from PATH by NAME (or an operator-configured absolute path),
 * the worker script is a fixed constant in this file, arguments are a
 * fixed vector (no shell), the child gets a MINIMAL env (no database URL,
 * no JWT secret), stderr is discarded at the OS level, stdout is capped,
 * and a wall-clock timeout kills the child. The worker never sees a
 * network. Everything it returns is rebuilt through an allowlist here —
 * a runner outcome carries classified codes and clamped numbers only:
 * no path, argv, errno, signal, stderr, or traceback ever escapes.
 */

/** Wire protocol version shared with ml/runtime/yolo_detect_worker.py. */
export const WORKER_PROTOCOL_VERSION = 1;
/** stdout ceiling: a 64-frame × 32-detection JSON is well under 1 MiB. */
export const MAX_WORKER_OUTPUT_BYTES = 8 * 1024 * 1024;
/** Protocol ceiling on the raw RGB payload piped to the worker. */
export const MAX_WORKER_INPUT_BYTES = 256 * 1024 * 1024;
export const MAX_WORKER_FRAMES = 64;
export const MIN_FRAME_EDGE = 16;
export const MAX_FRAME_EDGE = 4096;
export const DEFAULT_PYTHON_BINARY = 'python';
export const PROBE_TIMEOUT_MS = 120_000;

/** The ONLY place the worker script location is spelled out. Anchored at
 *  the repo root the same way the local storage root is (the API runs
 *  from services/api). */
const WORKER_SCRIPT = resolve(
  process.cwd(),
  '..',
  '..',
  'ml',
  'runtime',
  'yolo_detect_worker.py',
);

const BARE_BINARY_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
/** Absolute interpreter paths: no shell metacharacters, no quotes. */
const ABSOLUTE_BINARY_PATTERN = /^[A-Za-z0-9:\\/ ._()~-]{1,512}$/;

/** Environment variables the child may inherit — locale, temp, and the
 *  search path only. Compared case-insensitively (Windows). */
const CHILD_ENV_ALLOWLIST = new Set([
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'PROGRAMDATA',
  'TEMP',
  'TMP',
  'TMPDIR',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'LANG',
  'LC_ALL',
  'CUDA_VISIBLE_DEVICES',
  'CUDA_PATH',
]);

const RUNTIME_VERSION_PATTERN = /^[0-9A-Za-z._-]{1,32}$/;

export type WorkerDevice = 'auto' | 'cpu' | 'cuda';

export interface ProbeJob {
  /** Absolute weights path from the registry — consumed here, never
   *  echoed into any outcome. */
  modelFile: string;
  inputSize: number;
  device: WorkerDevice;
  timeoutMs: number;
}

export interface DetectJob extends ProbeJob {
  confThreshold: number;
  maxDetectionsPerFrame: number;
  width: number;
  height: number;
  frames: { index: number; timestampMs: number }[];
  /** Manifest class count — detections outside it are dropped. */
  classCount: number;
}

export interface RunnerDetection {
  classIndex: number;
  confidence: number;
  box: { x: number; y: number; width: number; height: number };
}

export interface RunnerFrame {
  index: number;
  detections: RunnerDetection[];
}

export type ProbeOutcome =
  | {
      ok: true;
      classCount: number;
      device: 'CPU' | 'CUDA' | null;
      runtimeVersion: string | null;
      elapsedMs: number | null;
    }
  | { ok: false; reasonCode: LocalRuntimeReasonCode };

export type DetectOutcome =
  | {
      ok: true;
      device: 'CPU' | 'CUDA' | null;
      runtimeVersion: string | null;
      elapsedMs: number | null;
      frames: RunnerFrame[];
    }
  | { ok: false; reasonCode: LocalRuntimeReasonCode };

export interface RunCommandOptions {
  stdin: Buffer;
  maxOutputBytes: number;
  timeoutMs: number;
  env: Record<string, string>;
}

export type RunCommand = (
  binary: string,
  args: string[],
  options: RunCommandOptions,
) => Promise<{ stdout: Buffer }>;

/** Error shape the default runner produces: spawn/OS failures carry a
 *  STRING errno, exits a NUMERIC code, kills a killed/signal flag. */
interface CommandError {
  code?: string | number | null;
  killed?: boolean;
  signal?: string | null;
}

const defaultRunCommand: RunCommand = (binary, args, options) =>
  new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let killedByTimeout = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(binary, args, {
        // stderr is DISCARDED at the OS level: torch/ultralytics chatter
        // never reaches this process, so it can neither overflow a buffer
        // nor leak into a log.
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
        // No shell: the argument vector can never be reinterpreted.
        shell: false,
        env: options.env,
      });
    } catch (error) {
      rejectPromise(error);
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    const timer = setTimeout(() => {
      killedByTimeout = true;
      child.kill('SIGKILL');
    }, options.timeoutMs);
    const finish = (settle: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      settle();
    };
    child.on('error', (error) => finish(() => rejectPromise(error)));
    child.stdout?.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > options.maxOutputBytes) {
        child.kill('SIGKILL');
        finish(() =>
          rejectPromise({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }),
        );
        return;
      }
      chunks.push(chunk);
    });
    child.on('close', (code, signal) =>
      finish(() => {
        if (killedByTimeout) {
          rejectPromise({ killed: true, signal: signal ?? 'SIGKILL' });
        } else if (signal) {
          rejectPromise({ signal });
        } else if (code !== 0) {
          rejectPromise({ code });
        } else {
          resolvePromise({ stdout: Buffer.concat(chunks) });
        }
      }),
    );
    if (child.stdin) {
      // A worker that exits before draining stdin (missing runtime → exit
      // 2 straight away) raises EPIPE here; the outcome comes from the
      // exit shape, never from the pipe write.
      child.stdin.on('error', () => undefined);
      child.stdin.end(options.stdin);
    }
  });

/** Minimal child environment: allowlisted inheritance plus fixed
 *  Python/Ultralytics hygiene. Exported for tests. */
export function buildChildEnv(
  parentEnv: NodeJS.ProcessEnv,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(parentEnv)) {
    if (
      typeof value === 'string' &&
      CHILD_ENV_ALLOWLIST.has(key.toUpperCase())
    ) {
      env[key] = value;
    }
  }
  env.PYTHONIOENCODING = 'utf-8';
  env.PYTHONUTF8 = '1';
  env.PYTHONDONTWRITEBYTECODE = '1';
  env.YOLO_VERBOSE = 'False';
  return env;
}

/** Interpreter reference the operator may configure: a bare name looked
 *  up on PATH, or an absolute path free of shell metacharacters. Exported
 *  for tests. */
export function normalizePythonBinary(value: string | undefined): string | null {
  const candidate = (value ?? '').trim();
  if (candidate.length === 0) {
    return DEFAULT_PYTHON_BINARY;
  }
  if (BARE_BINARY_PATTERN.test(candidate)) {
    return candidate;
  }
  if (
    isAbsolute(candidate) &&
    ABSOLUTE_BINARY_PATTERN.test(candidate) &&
    !candidate.includes('..')
  ) {
    return candidate;
  }
  return null;
}

/** Header line the worker parses before the raw RGB payload. Exported for
 *  tests. */
export function buildProbeHeader(job: ProbeJob): string {
  return JSON.stringify({
    protocol: WORKER_PROTOCOL_VERSION,
    mode: 'probe',
    modelFile: job.modelFile,
    inputSize: job.inputSize,
    device: job.device,
  });
}

export function buildDetectHeader(job: DetectJob): string {
  return JSON.stringify({
    protocol: WORKER_PROTOCOL_VERSION,
    mode: 'detect',
    modelFile: job.modelFile,
    inputSize: job.inputSize,
    device: job.device,
    confThreshold: job.confThreshold,
    maxDetectionsPerFrame: job.maxDetectionsPerFrame,
    width: job.width,
    height: job.height,
    frames: job.frames.map((frame) => ({
      index: frame.index,
      timestampMs: frame.timestampMs,
    })),
  });
}

function isMaxBufferOverflow(error: unknown): boolean {
  return (
    (error as CommandError | null)?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
  );
}

function isProcessKill(error: unknown): boolean {
  const failure = (error ?? {}) as CommandError;
  return failure.killed === true || typeof failure.signal === 'string';
}

/**
 * Map a child failure to a classified code. Numeric exit codes are the
 * worker's own verdict (protocol); everything else is an infrastructure
 * shape. The error object is never echoed. Exported for tests.
 */
export function classifyWorkerFailure(
  error: unknown,
  mode: 'probe' | 'detect',
): LocalRuntimeReasonCode {
  const failure = (error ?? {}) as CommandError;
  if (failure.code === 'ENOENT') {
    return 'LOCAL_RUNTIME_NOT_INSTALLED';
  }
  if (isMaxBufferOverflow(error)) {
    return 'RUNTIME_OUTPUT_TOO_LARGE';
  }
  if (isProcessKill(error)) {
    return mode === 'probe' ? 'LOCAL_RUNTIME_PROBE_FAILED' : 'INFERENCE_TIMEOUT';
  }
  if (typeof failure.code === 'number') {
    switch (failure.code) {
      case 2:
        return 'LOCAL_RUNTIME_NOT_INSTALLED';
      case 3:
        return 'MODEL_LOAD_FAILED';
      case 4:
        return 'INFERENCE_FAILED';
      case 5:
        return 'RUNTIME_OUTPUT_INVALID';
      case 6:
        return 'LOCAL_RUNTIME_PROBE_FAILED';
      default:
        return mode === 'probe' ? 'LOCAL_RUNTIME_PROBE_FAILED' : 'INFERENCE_FAILED';
    }
  }
  // Any other string errno (EACCES, EAGAIN, ENOMEM, ...): the OS refused
  // to run the interpreter.
  return mode === 'probe' ? 'LOCAL_RUNTIME_PROBE_FAILED' : 'INFERENCE_FAILED';
}

function num01(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : null;
}

/** Strict non-negative INTEGER — indexes and counts are never rounded
 *  into range. */
function nonNegativeInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

/** Non-negative duration, rounded to whole milliseconds. */
function nonNegativeMs(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;
}

function deviceCode(value: unknown): 'CPU' | 'CUDA' | null {
  return value === 'cpu' ? 'CPU' : value === 'cuda' ? 'CUDA' : null;
}

function runtimeVersion(value: unknown): string | null {
  return typeof value === 'string' && RUNTIME_VERSION_PATTERN.test(value)
    ? value
    : null;
}

function parseDocument(stdout: Buffer, mode: 'probe' | 'detect') {
  let doc: unknown;
  try {
    doc = JSON.parse(stdout.toString('utf8'));
  } catch {
    return null;
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return null;
  }
  const record = doc as Record<string, unknown>;
  if (
    record.protocol !== WORKER_PROTOCOL_VERSION ||
    record.status !== 'OK' ||
    record.mode !== mode
  ) {
    return null;
  }
  return record;
}

/** Allowlist rebuild of one frame's detections. Exported for tests. */
export function sanitizeRunnerFrames(
  raw: unknown,
  job: Pick<DetectJob, 'frames' | 'classCount' | 'maxDetectionsPerFrame'>,
): RunnerFrame[] | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  const validIndexes = new Set(job.frames.map((frame) => frame.index));
  const seen = new Set<number>();
  const frames: RunnerFrame[] = [];
  for (const entry of raw) {
    const frame = entry as Partial<RunnerFrame> | null;
    const index = nonNegativeInt(frame?.index);
    if (index === null || !validIndexes.has(index) || seen.has(index)) {
      continue;
    }
    seen.add(index);
    const detections: RunnerDetection[] = [];
    for (const rawDetection of Array.isArray(frame?.detections)
      ? frame.detections
      : []) {
      const detection = rawDetection as Partial<RunnerDetection> | null;
      const classIndex = nonNegativeInt(detection?.classIndex);
      const confidence = num01(detection?.confidence);
      const box = detection?.box as Partial<RunnerDetection['box']> | undefined;
      const x = num01(box?.x);
      const y = num01(box?.y);
      const width = num01(box?.width);
      const height = num01(box?.height);
      if (
        classIndex === null ||
        classIndex >= job.classCount ||
        confidence === null ||
        x === null ||
        y === null ||
        width === null ||
        height === null ||
        width === 0 ||
        height === 0
      ) {
        continue;
      }
      detections.push({ classIndex, confidence, box: { x, y, width, height } });
    }
    detections.sort((a, b) => b.confidence - a.confidence);
    frames.push({
      index,
      detections: detections.slice(0, job.maxDetectionsPerFrame),
    });
  }
  frames.sort((a, b) => a.index - b.index);
  return frames;
}

@Injectable()
export class PythonYoloWorkerRunner {
  private readonly binary: string | null;

  constructor(
    config: ConfigService,
    private readonly runCommand: RunCommand = defaultRunCommand,
  ) {
    this.binary = normalizePythonBinary(config.get<string>('CV_LOCAL_PYTHON_BIN'));
  }

  /** Real minimal inference over a synthetic frame — proves interpreter,
   *  runtime, and weights all load. Never rejects. */
  async probe(job: ProbeJob): Promise<ProbeOutcome> {
    if (this.binary === null) {
      return { ok: false, reasonCode: 'LOCAL_RUNTIME_NOT_INSTALLED' };
    }
    let stdout: Buffer;
    try {
      ({ stdout } = await this.runCommand(
        this.binary,
        [WORKER_SCRIPT, '--probe'],
        {
          stdin: Buffer.from(`${buildProbeHeader(job)}\n`, 'utf8'),
          maxOutputBytes: MAX_WORKER_OUTPUT_BYTES,
          timeoutMs: Math.min(job.timeoutMs, PROBE_TIMEOUT_MS),
          env: buildChildEnv(process.env),
        },
      ));
    } catch (error) {
      return { ok: false, reasonCode: classifyWorkerFailure(error, 'probe') };
    }
    const doc = parseDocument(stdout, 'probe');
    const classCount = doc === null ? null : nonNegativeInt(doc.classCount);
    if (doc === null || classCount === null || classCount === 0) {
      return { ok: false, reasonCode: 'RUNTIME_OUTPUT_INVALID' };
    }
    return {
      ok: true,
      classCount,
      device: deviceCode(doc.device),
      runtimeVersion: runtimeVersion(doc.runtimeVersion),
      elapsedMs: nonNegativeMs(doc.elapsedMs),
    };
  }

  /** Detection over tightly packed RGB24 frames (header order). Never
   *  rejects. */
  async detect(job: DetectJob, frameBytes: Buffer): Promise<DetectOutcome> {
    if (this.binary === null) {
      return { ok: false, reasonCode: 'LOCAL_RUNTIME_NOT_INSTALLED' };
    }
    const expectedBytes = job.frames.length * job.width * job.height * 3;
    if (
      job.frames.length === 0 ||
      job.frames.length > MAX_WORKER_FRAMES ||
      job.width < MIN_FRAME_EDGE ||
      job.height < MIN_FRAME_EDGE ||
      job.width > MAX_FRAME_EDGE ||
      job.height > MAX_FRAME_EDGE ||
      expectedBytes > MAX_WORKER_INPUT_BYTES ||
      frameBytes.length !== expectedBytes
    ) {
      // A caller-side byte-math bug, not a worker verdict — refuse to
      // pipe a malformed payload.
      return { ok: false, reasonCode: 'INFERENCE_FAILED' };
    }
    let stdout: Buffer;
    try {
      ({ stdout } = await this.runCommand(
        this.binary,
        [WORKER_SCRIPT, '--detect'],
        {
          stdin: Buffer.concat([
            Buffer.from(`${buildDetectHeader(job)}\n`, 'utf8'),
            frameBytes,
          ]),
          maxOutputBytes: MAX_WORKER_OUTPUT_BYTES,
          timeoutMs: job.timeoutMs,
          env: buildChildEnv(process.env),
        },
      ));
    } catch (error) {
      return { ok: false, reasonCode: classifyWorkerFailure(error, 'detect') };
    }
    const doc = parseDocument(stdout, 'detect');
    const frames = doc === null ? null : sanitizeRunnerFrames(doc.frames, job);
    if (doc === null || frames === null) {
      return { ok: false, reasonCode: 'RUNTIME_OUTPUT_INVALID' };
    }
    return {
      ok: true,
      device: deviceCode(doc.device),
      runtimeVersion: runtimeVersion(doc.runtimeVersion),
      elapsedMs: nonNegativeMs(doc.elapsedMs),
      frames,
    };
  }
}
