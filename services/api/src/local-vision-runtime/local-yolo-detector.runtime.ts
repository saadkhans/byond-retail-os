import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { PickupAnalysisFrameDecoder } from '../pickup-detection/analysis/analysis-frames';
import { AnalysisFrame } from '../pickup-detection/analysis/pickup-analyzer';
import { ExtractionFailedError } from '../video-ingest/extraction/video-frame-extractor.port';
import { LocalVideoStorageAdapter } from '../video-ingest/storage/local-video-storage.adapter';
import { LocalModelRegistry, ModelResolution } from './local-model-registry';
import {
  DetectorFrameResult,
  LocalDetectorRequest,
  LocalDetectorResult,
  LocalDetectorRuntimePort,
  LocalDetectorStatus,
  LocalModelDescriptor,
} from './local-vision-runtime.port';
import {
  MAX_FRAME_EDGE,
  MAX_WORKER_INPUT_BYTES,
  ProbeOutcome,
  PythonYoloWorkerRunner,
  WorkerDevice,
} from './python-yolo-worker.runner';

/**
 * LocalDetectorRuntimePort over the safe model registry + the confined
 * Python worker. Composes the local storage adapter (the ONLY place a
 * storage key becomes a filesystem path — internalPathFor is a
 * local-adapter extension) with the existing confined ffmpeg rawvideo
 * decoder, exactly as LocalPickupMediaAdapter does, so the worker only
 * ever sees downscaled analysis frames of an UPLOADED, screened clip.
 *
 * READ-ONLY: the single database access is a tenant-scoped video asset
 * read. Never throws; every failure is a classified code.
 */

export const DEFAULT_ANALYSIS_WIDTH = 640;
export const MAX_ANALYSIS_FRAMES = 32;
export const MAX_DETECTIONS_PER_FRAME = 32;
export const DEFAULT_FPS = 2;
export const DEFAULT_CONF_THRESHOLD = 0.25;
export const DEFAULT_TIMEOUT_MS = 60_000;
/** Probe memo TTL — same cadence as the registry and ffmpeg readiness. */
export const PROBE_CACHE_TTL_MS = 60_000;

function boundedNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

/**
 * Analysis geometry for the worker: aspect-preserving downscale to the
 * default analysis width AND the worker's edge ceiling (a very tall
 * portrait source must not produce a frame the protocol refuses),
 * even-dimensioned for the rawvideo decoder, never upscaled. Exported
 * for tests.
 */
export function boundedAnalysisGeometry(source: {
  width: number;
  height: number;
}): { width: number; height: number } {
  const scale = Math.min(
    1,
    DEFAULT_ANALYSIS_WIDTH / source.width,
    MAX_FRAME_EDGE / source.height,
    MAX_FRAME_EDGE / source.width,
  );
  const even = (value: number) => {
    const rounded = Math.max(16, Math.round(value));
    return rounded - (rounded % 2);
  };
  return { width: even(source.width * scale), height: even(source.height * scale) };
}

/** Cadence that decodes at most MAX_ANALYSIS_FRAMES frames for the clip
 *  (floored to a millifps): the decoder never retains frames the worker
 *  would only discard again. Exported for tests. */
export function effectiveSamplingFps(fps: number, durationMs: number): number {
  const cap = (MAX_ANALYSIS_FRAMES * 1000) / Math.max(1, durationMs);
  return Math.max(0.001, Math.floor(Math.min(fps, cap) * 1000) / 1000);
}

/** Evenly subsample to at most `limit` frames, keeping clip order.
 *  Exported for tests. */
export function subsampleFrames<T>(frames: T[], limit: number): T[] {
  if (frames.length <= limit) {
    return frames;
  }
  const picked: T[] = [];
  for (let i = 0; i < limit; i += 1) {
    picked.push(frames[Math.floor((i * frames.length) / limit)]);
  }
  return picked;
}

@Injectable()
export class LocalYoloDetectorRuntime implements LocalDetectorRuntimePort {
  private readonly enabled: boolean;
  private readonly fps: number;
  private readonly confThreshold: number;
  private readonly timeoutMs: number;
  private readonly device: WorkerDevice;
  private probeCache: {
    key: string;
    outcome: ProbeOutcome;
    checkedAtMs: number;
  } | null = null;
  private probeInFlight: { key: string; promise: Promise<ProbeOutcome> } | null =
    null;

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly registry: LocalModelRegistry,
    private readonly runner: PythonYoloWorkerRunner,
    private readonly storage: LocalVideoStorageAdapter,
    private readonly decoder: PickupAnalysisFrameDecoder,
  ) {
    // Same parsing as the pretrained-vision registry: the YOLO slot is
    // enabled by yolo_local or hybrid; anything else keeps it DISABLED
    // and this runtime never touches disk or spawns anything.
    const provider = (config.get<string>('CV_PRETRAINED_PROVIDER') ?? 'classical')
      .trim()
      .toLowerCase();
    this.enabled = provider === 'yolo_local' || provider === 'hybrid';
    this.fps = boundedNumber(config.get('CV_LOCAL_YOLO_FPS'), DEFAULT_FPS, 0.5, 8);
    this.confThreshold = boundedNumber(
      config.get('CV_LOCAL_YOLO_CONF_THRESHOLD'),
      DEFAULT_CONF_THRESHOLD,
      0,
      1,
    );
    this.timeoutMs = Math.round(
      boundedNumber(
        config.get('CV_LOCAL_YOLO_TIMEOUT_MS'),
        DEFAULT_TIMEOUT_MS,
        5_000,
        300_000,
      ),
    );
    const device = (config.get<string>('CV_LOCAL_YOLO_DEVICE') ?? 'auto')
      .trim()
      .toLowerCase();
    this.device = device === 'cpu' || device === 'cuda' ? device : 'auto';
  }

  async status(): Promise<LocalDetectorStatus> {
    try {
      // Strip the process-internal resolution (it carries the absolute
      // weights path) — a status is SAFE OUTPUT only.
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

  async detect(request: LocalDetectorRequest): Promise<LocalDetectorResult> {
    try {
      return await this.runDetect(request);
    } catch {
      return this.failure('FAILED', 'INFERENCE_FAILED', null);
    }
  }

  private async resolveStatus(): Promise<
    LocalDetectorStatus & { resolution: ModelResolution | null }
  > {
    if (!this.enabled) {
      return {
        availability: 'DISABLED',
        reasonCode: 'PROVIDER_NOT_ENABLED',
        model: null,
        device: null,
        runtimeVersion: null,
        resolution: null,
      };
    }
    const resolution = await this.registry.resolve();
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
    if (probe.classCount !== resolution.descriptor.classCount) {
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

  /** Memoized real-inference probe (60 s TTL, single in-flight), keyed on
   *  the resolved weights + input size + device so a registry change
   *  re-probes. */
  private probe(
    resolution: Extract<ModelResolution, { ok: true }>,
  ): Promise<ProbeOutcome> {
    const key = `${resolution.internalModelFile}|${resolution.descriptor.inputSize}|${this.device}`;
    const cached = this.probeCache;
    if (
      cached !== null &&
      cached.key === key &&
      Date.now() - cached.checkedAtMs < PROBE_CACHE_TTL_MS
    ) {
      return Promise.resolve(cached.outcome);
    }
    if (this.probeInFlight !== null && this.probeInFlight.key === key) {
      return this.probeInFlight.promise;
    }
    const promise = this.runner
      .probe({
        modelFile: resolution.internalModelFile,
        inputSize: resolution.descriptor.inputSize,
        device: this.device,
        timeoutMs: this.timeoutMs,
      })
      .catch(
        (): ProbeOutcome => ({
          ok: false,
          reasonCode: 'LOCAL_RUNTIME_PROBE_FAILED',
        }),
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
    reasonCode: LocalDetectorResult['reasonCode'],
    model: LocalModelDescriptor | null,
  ): LocalDetectorResult {
    return {
      status,
      reasonCode,
      model,
      device: null,
      analysisDims: null,
      sampledFps: null,
      frames: [],
      elapsedMs: null,
    };
  }

  private async runDetect(
    request: LocalDetectorRequest,
  ): Promise<LocalDetectorResult> {
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

    // Tenant-scoped READ of the uploaded clip — the only database access.
    const asset = await this.prisma.videoAsset.findFirst({
      where: { id: request.videoAssetId, tenantId: request.tenantId },
      select: {
        storageKey: true,
        width: true,
        height: true,
        durationMs: true,
        status: true,
      },
    });
    if (!asset) {
      return this.failure('UNAVAILABLE', 'CLIP_NOT_FOUND', descriptor);
    }
    if (
      !asset.storageKey ||
      typeof asset.width !== 'number' ||
      typeof asset.height !== 'number' ||
      typeof asset.durationMs !== 'number' ||
      asset.width <= 0 ||
      asset.height <= 0 ||
      asset.durationMs <= 0
    ) {
      return this.failure('UNAVAILABLE', 'CLIP_NOT_DECODABLE', descriptor);
    }

    const geometry = boundedAnalysisGeometry({
      width: asset.width,
      height: asset.height,
    });
    const samplingFps = effectiveSamplingFps(this.fps, asset.durationMs);
    let decoded: AnalysisFrame[];
    try {
      decoded = await this.decoder.decodeAnalysisFrames(
        this.storage.internalPathFor(asset.storageKey),
        samplingFps,
        geometry,
        asset.durationMs,
      );
    } catch (error) {
      return this.failure(
        'UNAVAILABLE',
        error instanceof ExtractionFailedError
          ? 'NO_FRAMES_DECODED'
          : 'CLIP_NOT_DECODABLE',
        descriptor,
      );
    }
    if (decoded.length === 0) {
      return this.failure('UNAVAILABLE', 'NO_FRAMES_DECODED', descriptor);
    }
    const frames = subsampleFrames(decoded, MAX_ANALYSIS_FRAMES);
    const frameBytes = geometry.width * geometry.height * 3;
    if (
      frames.length * frameBytes > MAX_WORKER_INPUT_BYTES ||
      frames.some((frame) => frame.rgb.length !== frameBytes)
    ) {
      return this.failure('FAILED', 'INFERENCE_FAILED', descriptor);
    }
    const sampledFps =
      frames.length === decoded.length
        ? samplingFps
        : Math.round((frames.length * 1000 * 1000) / asset.durationMs) / 1000;

    const outcome = await this.runner.detect(
      {
        modelFile: resolution.internalModelFile,
        inputSize: descriptor.inputSize,
        device: this.device,
        timeoutMs: this.timeoutMs,
        confThreshold: this.confThreshold,
        maxDetectionsPerFrame: MAX_DETECTIONS_PER_FRAME,
        width: geometry.width,
        height: geometry.height,
        frames: frames.map((frame, index) => ({
          index,
          timestampMs: frame.timestampMs,
        })),
        classCount: descriptor.classCount,
      },
      Buffer.concat(frames.map((frame) => frame.rgb)),
    );
    if (!outcome.ok) {
      return this.failure('FAILED', outcome.reasonCode, descriptor);
    }

    const byIndex = new Map(outcome.frames.map((frame) => [frame.index, frame]));
    const results: DetectorFrameResult[] = frames.map((frame, index) => {
      const workerFrame = byIndex.get(index);
      return {
        frameIndex: index,
        timestampMs: frame.timestampMs,
        detections: (workerFrame?.detections ?? []).flatMap((detection) => {
          const role = resolution.classRoles[detection.classIndex] ?? null;
          // Classes the manifest maps to no role are DROPPED — a
          // detector never names anything outside the generic roles.
          return role === null
            ? []
            : [
                {
                  role,
                  classIndex: detection.classIndex,
                  confidence: detection.confidence,
                  box: detection.box,
                },
              ];
        }),
      };
    });
    return {
      status: 'OK',
      reasonCode: null,
      model: descriptor,
      device: outcome.device,
      analysisDims: { width: geometry.width, height: geometry.height },
      sampledFps,
      frames: results,
      elapsedMs: outcome.elapsedMs,
    };
  }
}
