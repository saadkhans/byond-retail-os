import { resolve } from 'node:path';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LocalRuntimeReasonCode } from './local-vision-runtime.port';
import {
  MAX_WORKER_OUTPUT_BYTES,
  PROBE_TIMEOUT_MS,
  RunCommand,
  WORKER_PROTOCOL_VERSION,
  WorkerDevice,
  buildChildEnv,
  classifyWorkerFailure,
  defaultRunCommand,
  normalizePythonBinary,
} from './python-yolo-worker.runner';

/**
 * LOCAL Python worker runner for open_clip-class image EMBEDDINGS
 * (Phase 24). Same confinement as the YOLO runner, which it reuses
 * verbatim: interpreter by name or operator-configured absolute path,
 * fixed script constant, fixed argv, minimal child env, stderr discarded,
 * stdout capped, wall-clock kill, allowlist rebuild of the JSON reply.
 * The worker receives images ALREADY letterboxed to the model's square
 * input, so it only normalizes and encodes.
 */

/** The ONLY place the embed worker script location is spelled out. */
const WORKER_SCRIPT = resolve(
  process.cwd(),
  '..',
  '..',
  'ml',
  'runtime',
  'embed_worker.py',
);

/** Protocol ceilings for one embed call (batches are split by the runtime). */
export const MAX_EMBED_IMAGES = 64;
export const MIN_EMBED_EDGE = 32;
export const MAX_EMBED_EDGE = 1024;
export const MAX_EMBED_INPUT_BYTES = 64 * 1024 * 1024;

const RUNTIME_VERSION_PATTERN = /^[0-9A-Za-z._-]{1,32}$/;

export interface EmbedProbeJob {
  /** Absolute checkpoint path (PT) or null for a HUB_CACHE model. Consumed
   *  here, never echoed into any outcome. */
  modelFile: string | null;
  /** open_clip pretrained tag for HUB_CACHE models, else null. */
  pretrained: string | null;
  arch: string;
  inputSize: number;
  device: WorkerDevice;
  timeoutMs: number;
}

export interface EmbedJob extends EmbedProbeJob {
  /** Declared embedding dimensionality — vectors of any other length are
   *  rejected as RUNTIME_OUTPUT_INVALID. */
  dim: number;
  imageCount: number;
}

export type EmbedProbeOutcome =
  | {
      ok: true;
      dim: number;
      device: 'CPU' | 'CUDA' | null;
      runtimeVersion: string | null;
      elapsedMs: number | null;
    }
  | { ok: false; reasonCode: LocalRuntimeReasonCode };

export type EmbedOutcome =
  | {
      ok: true;
      vectors: number[][];
      device: 'CPU' | 'CUDA' | null;
      runtimeVersion: string | null;
      elapsedMs: number | null;
    }
  | { ok: false; reasonCode: LocalRuntimeReasonCode };

function modelFields(job: EmbedProbeJob) {
  return {
    modelFile: job.modelFile,
    pretrained: job.pretrained,
    arch: job.arch,
    inputSize: job.inputSize,
    device: job.device,
  };
}

/** Header line the worker parses before the raw RGB payload. Exported for
 *  tests. */
export function buildEmbedProbeHeader(job: EmbedProbeJob): string {
  return JSON.stringify({
    protocol: WORKER_PROTOCOL_VERSION,
    mode: 'probe',
    ...modelFields(job),
  });
}

export function buildEmbedHeader(job: EmbedJob): string {
  return JSON.stringify({
    protocol: WORKER_PROTOCOL_VERSION,
    mode: 'embed',
    ...modelFields(job),
    width: job.inputSize,
    height: job.inputSize,
    images: Array.from({ length: job.imageCount }, (_row, index) => ({ index })),
  });
}

function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : null;
}

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

function parseDocument(stdout: Buffer, mode: 'probe' | 'embed') {
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

/**
 * Allowlist rebuild of the worker's vectors: exactly `imageCount` rows of
 * exactly `dim` finite numbers, each row re-normalized to unit length here
 * (the worker is expected to normalize, but the invariant is enforced on
 * this side of the boundary). Null on any deviation. Exported for tests.
 */
export function sanitizeVectors(
  raw: unknown,
  job: Pick<EmbedJob, 'dim' | 'imageCount'>,
): number[][] | null {
  if (!Array.isArray(raw) || raw.length !== job.imageCount) {
    return null;
  }
  const vectors: number[][] = [];
  for (const row of raw) {
    if (!Array.isArray(row) || row.length !== job.dim) {
      return null;
    }
    let sum = 0;
    const values: number[] = [];
    for (const value of row) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return null;
      }
      values.push(value);
      sum += value * value;
    }
    const norm = Math.sqrt(sum);
    if (!(norm > 0)) {
      return null;
    }
    vectors.push(values.map((value) => Math.round((value / norm) * 1e6) / 1e6));
  }
  return vectors;
}

@Injectable()
export class PythonEmbedWorkerRunner {
  private readonly binary: string | null;

  constructor(
    config: ConfigService,
    private readonly runCommand: RunCommand = defaultRunCommand,
  ) {
    this.binary = normalizePythonBinary(config.get<string>('CV_LOCAL_PYTHON_BIN'));
  }

  /** Real minimal encode over a synthetic image — proves interpreter,
   *  runtime, and weights all load, and reports the true dimensionality.
   *  Never rejects. */
  async probe(job: EmbedProbeJob): Promise<EmbedProbeOutcome> {
    if (this.binary === null) {
      return { ok: false, reasonCode: 'LOCAL_RUNTIME_NOT_INSTALLED' };
    }
    let stdout: Buffer;
    try {
      ({ stdout } = await this.runCommand(this.binary, [WORKER_SCRIPT, '--probe'], {
        stdin: Buffer.from(`${buildEmbedProbeHeader(job)}\n`, 'utf8'),
        maxOutputBytes: MAX_WORKER_OUTPUT_BYTES,
        timeoutMs: Math.min(job.timeoutMs, PROBE_TIMEOUT_MS),
        env: buildChildEnv(process.env),
      }));
    } catch (error) {
      return { ok: false, reasonCode: classifyWorkerFailure(error, 'probe') };
    }
    const doc = parseDocument(stdout, 'probe');
    const dim = doc === null ? null : positiveInt(doc.dim);
    if (doc === null || dim === null) {
      return { ok: false, reasonCode: 'RUNTIME_OUTPUT_INVALID' };
    }
    return {
      ok: true,
      dim,
      device: deviceCode(doc.device),
      runtimeVersion: runtimeVersion(doc.runtimeVersion),
      elapsedMs: nonNegativeMs(doc.elapsedMs),
    };
  }

  /** Encode tightly packed RGB24 squares (header order). Never rejects. */
  async embed(job: EmbedJob, imageBytes: Buffer): Promise<EmbedOutcome> {
    if (this.binary === null) {
      return { ok: false, reasonCode: 'LOCAL_RUNTIME_NOT_INSTALLED' };
    }
    const expectedBytes = job.imageCount * job.inputSize * job.inputSize * 3;
    if (
      job.imageCount <= 0 ||
      job.imageCount > MAX_EMBED_IMAGES ||
      job.inputSize < MIN_EMBED_EDGE ||
      job.inputSize > MAX_EMBED_EDGE ||
      expectedBytes > MAX_EMBED_INPUT_BYTES ||
      imageBytes.length !== expectedBytes
    ) {
      // A caller-side byte-math bug, not a worker verdict — refuse to
      // pipe a malformed payload.
      return { ok: false, reasonCode: 'INFERENCE_FAILED' };
    }
    let stdout: Buffer;
    try {
      ({ stdout } = await this.runCommand(this.binary, [WORKER_SCRIPT, '--embed'], {
        stdin: Buffer.concat([
          Buffer.from(`${buildEmbedHeader(job)}\n`, 'utf8'),
          imageBytes,
        ]),
        maxOutputBytes: MAX_WORKER_OUTPUT_BYTES,
        timeoutMs: job.timeoutMs,
        env: buildChildEnv(process.env),
      }));
    } catch (error) {
      return { ok: false, reasonCode: classifyWorkerFailure(error, 'detect') };
    }
    const doc = parseDocument(stdout, 'embed');
    const vectors = doc === null ? null : sanitizeVectors(doc.vectors, job);
    if (doc === null || vectors === null) {
      return { ok: false, reasonCode: 'RUNTIME_OUTPUT_INVALID' };
    }
    return {
      ok: true,
      vectors,
      device: deviceCode(doc.device),
      runtimeVersion: runtimeVersion(doc.runtimeVersion),
      elapsedMs: nonNegativeMs(doc.elapsedMs),
    };
  }
}
