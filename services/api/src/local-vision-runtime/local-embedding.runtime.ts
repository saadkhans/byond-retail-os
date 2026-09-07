import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isWellFormedImage, letterboxSquare } from './image-prep';
import {
  EmbeddingModelResolution,
  LocalModelRegistry,
} from './local-model-registry';
import {
  EmbeddingImageInput,
  LocalEmbeddingModelDescriptor,
  LocalEmbeddingResult,
  LocalEmbeddingRuntimePort,
  LocalEmbeddingStatus,
  LocalRuntimeReasonCode,
} from './local-vision-runtime.port';
import { WorkerJobGate } from './local-yolo-detector.runtime';
import {
  EmbedProbeOutcome,
  MAX_EMBED_IMAGES,
  PythonEmbedWorkerRunner,
} from './python-embed-worker.runner';
import { WorkerDevice } from './python-yolo-worker.runner';

/**
 * LocalEmbeddingRuntimePort over the safe model registry + the confined
 * Python open_clip worker (Phase 24). Inputs are crops/reference images
 * the CALLER already holds as RGB buffers; this runtime letterboxes them
 * to the model's square input, batches them, and returns L2-normalized
 * vectors. No media is located or decoded here and no table is touched —
 * it is a pure compute seam behind a port.
 */

export const DEFAULT_EMBED_TIMEOUT_MS = 60_000;
export const EMBED_PROBE_CACHE_TTL_MS = 60_000;

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

@Injectable()
export class LocalEmbeddingRuntime implements LocalEmbeddingRuntimePort {
  private readonly timeoutMs: number;
  private readonly device: WorkerDevice;
  private probeCache: { key: string; outcome: EmbedProbeOutcome; checkedAtMs: number } | null =
    null;
  private probeInFlight: { key: string; promise: Promise<EmbedProbeOutcome> } | null = null;
  /** Own gate: one embedding worker process at a time, bounded waiting
   *  line (the YOLO runtime keeps its own — the two models never share a
   *  process, so they do not need to share a line). */
  private readonly gate = new WorkerJobGate();

  constructor(
    config: ConfigService,
    private readonly registry: LocalModelRegistry,
    private readonly runner: PythonEmbedWorkerRunner,
  ) {
    this.timeoutMs = Math.round(
      boundedNumber(
        config.get('CV_LOCAL_EMBED_TIMEOUT_MS'),
        DEFAULT_EMBED_TIMEOUT_MS,
        5_000,
        300_000,
      ),
    );
    const device = (config.get<string>('CV_LOCAL_YOLO_DEVICE') ?? 'auto').trim().toLowerCase();
    this.device = device === 'cpu' || device === 'cuda' ? device : 'auto';
  }

  async status(): Promise<LocalEmbeddingStatus> {
    try {
      const { availability, reasonCode, model, device, runtimeVersion } =
        await this.resolveStatus();
      return { availability, reasonCode, model, device, runtimeVersion };
    } catch {
      return {
        availability: 'UNAVAILABLE',
        reasonCode: 'LOCAL_RUNTIME_PROBE_FAILED',
        model: null,
        device: null,
        runtimeVersion: null,
      };
    }
  }

  async embed(images: EmbeddingImageInput[]): Promise<LocalEmbeddingResult> {
    try {
      return await this.runEmbed(images);
    } catch {
      return this.failure('FAILED', 'INFERENCE_FAILED', null);
    }
  }

  private async resolveStatus(): Promise<
    LocalEmbeddingStatus & { resolution: EmbeddingModelResolution | null }
  > {
    const resolution = await this.registry.resolveEmbedding();
    if (!resolution.ok) {
      return {
        availability: 'UNAVAILABLE',
        reasonCode: resolution.reasonCode,
        model: null,
        device: null,
        runtimeVersion: null,
        resolution,
      };
    }
    const probe = await this.probe(resolution);
    if (!probe.ok) {
      return {
        availability: 'UNAVAILABLE',
        reasonCode: probe.reasonCode,
        model: resolution.descriptor,
        device: null,
        runtimeVersion: null,
        resolution,
      };
    }
    // The manifest DECLARES the dimensionality every stored vector has;
    // an encoder that produces another length would silently corrupt
    // the index, so it fails CLOSED here.
    if (probe.dim !== resolution.descriptor.dim) {
      return {
        availability: 'UNAVAILABLE',
        reasonCode: 'MODEL_MANIFEST_MISMATCH',
        model: resolution.descriptor,
        device: probe.device,
        runtimeVersion: probe.runtimeVersion,
        resolution,
      };
    }
    return {
      availability: 'READY',
      reasonCode: null,
      model: resolution.descriptor,
      device: probe.device,
      runtimeVersion: probe.runtimeVersion,
      resolution,
    };
  }

  private probe(
    resolution: Extract<EmbeddingModelResolution, { ok: true }>,
  ): Promise<EmbedProbeOutcome> {
    const key = `${resolution.internalModelFile ?? ''}|${resolution.descriptor.pretrained ?? ''}|${resolution.descriptor.arch}|${resolution.descriptor.inputSize}|${this.device}`;
    const cached = this.probeCache;
    if (
      cached !== null &&
      cached.key === key &&
      Date.now() - cached.checkedAtMs < EMBED_PROBE_CACHE_TTL_MS
    ) {
      return Promise.resolve(cached.outcome);
    }
    if (this.probeInFlight !== null && this.probeInFlight.key === key) {
      return this.probeInFlight.promise;
    }
    const gated = this.gate.run(() =>
      this.runner.probe({
        modelFile: resolution.internalModelFile,
        pretrained: resolution.descriptor.pretrained,
        arch: resolution.descriptor.arch,
        inputSize: resolution.descriptor.inputSize,
        device: this.device,
        timeoutMs: this.timeoutMs,
      }),
    );
    if (gated === null) {
      return Promise.resolve({ ok: false, reasonCode: 'RUNTIME_BUSY' });
    }
    const promise = gated
      .catch(
        (): EmbedProbeOutcome => ({ ok: false, reasonCode: 'LOCAL_RUNTIME_PROBE_FAILED' }),
      )
      .then((outcome) => {
        this.probeCache = { key, outcome, checkedAtMs: Date.now() };
        if (this.probeInFlight?.key === key) {
          this.probeInFlight = null;
        }
        return outcome;
      });
    this.probeInFlight = { key, promise };
    return promise;
  }

  private failure(
    status: 'UNAVAILABLE' | 'FAILED',
    reasonCode: LocalRuntimeReasonCode,
    model: LocalEmbeddingModelDescriptor | null,
  ): LocalEmbeddingResult {
    return {
      status,
      reasonCode,
      model,
      device: null,
      vectors: null,
      dim: model?.dim ?? null,
      elapsedMs: null,
    };
  }

  private async runEmbed(images: EmbeddingImageInput[]): Promise<LocalEmbeddingResult> {
    const status = await this.resolveStatus();
    if (status.availability !== 'READY' || !status.resolution?.ok) {
      return this.failure(
        'UNAVAILABLE',
        status.reasonCode ?? 'LOCAL_RUNTIME_PROBE_FAILED',
        status.model,
      );
    }
    const resolution = status.resolution;
    const descriptor = resolution.descriptor;
    if (images.length === 0 || images.some((image) => !isWellFormedImage(image))) {
      return this.failure('FAILED', 'INFERENCE_FAILED', descriptor);
    }
    const edge = descriptor.inputSize;
    const squares = images.map((image) => letterboxSquare(image, edge));
    const vectors: number[][] = [];
    let device: LocalEmbeddingResult['device'] = null;
    let elapsedMs = 0;
    for (let offset = 0; offset < squares.length; offset += MAX_EMBED_IMAGES) {
      const batch = squares.slice(offset, offset + MAX_EMBED_IMAGES);
      const gated = this.gate.run(() =>
        this.runner.embed(
          {
            modelFile: resolution.internalModelFile,
            pretrained: descriptor.pretrained,
            arch: descriptor.arch,
            inputSize: edge,
            device: this.device,
            timeoutMs: this.timeoutMs,
            dim: descriptor.dim,
            imageCount: batch.length,
          },
          Buffer.concat(batch.map((image) => image.rgb)),
        ),
      );
      if (gated === null) {
        return this.failure('UNAVAILABLE', 'RUNTIME_BUSY', descriptor);
      }
      const outcome = await gated;
      if (!outcome.ok) {
        return this.failure('FAILED', outcome.reasonCode, descriptor);
      }
      vectors.push(...outcome.vectors);
      device = outcome.device ?? device;
      elapsedMs += outcome.elapsedMs ?? 0;
    }
    return {
      status: 'OK',
      reasonCode: null,
      model: descriptor,
      device,
      vectors,
      dim: descriptor.dim,
      elapsedMs,
    };
  }
}
