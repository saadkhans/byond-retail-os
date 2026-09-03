/**
 * PURE port types for the LOCAL detector runtime (no I/O, no Nest).
 *
 * Everything crossing this boundary is already SAFE OUTPUT: classified
 * codes, clamped numbers, normalized boxes, and opaque model ids. A
 * runtime implementation must never place a filesystem path, model file
 * name, interpreter location, argv, stderr, traceback, or raw frame data
 * in any of these structures — the pretrained-vision module persists and
 * serves them (after its own allowlist rebuild), so a leak here would be
 * a leak to the API.
 */

/** Generic detector roles. NEVER a class-per-SKU classifier: the local
 *  model registry maps a model's own class list onto these roles. */
export type DetectorRole = 'PRODUCT' | 'HAND' | 'PERSON' | 'OBJECT';

export type LocalRuntimeAvailability = 'READY' | 'DISABLED' | 'UNAVAILABLE';

/**
 * Classified availability / failure codes (UPPER_SNAKE, <= 64 chars —
 * they pass the pretrained-vision CODE_PATTERN unchanged). Never a
 * message.
 */
export type LocalRuntimeReasonCode =
  | 'PROVIDER_NOT_ENABLED'
  | 'MODEL_NOT_CONFIGURED'
  | 'MODEL_ROOT_NOT_CONFIGURED'
  | 'MODEL_ROOT_NOT_FOUND'
  | 'MODEL_NOT_FOUND'
  | 'MODEL_MANIFEST_INVALID'
  | 'MODEL_MANIFEST_MISMATCH'
  | 'MODEL_FILE_TOO_LARGE'
  | 'LOCAL_RUNTIME_NOT_INSTALLED'
  | 'LOCAL_RUNTIME_PROBE_FAILED'
  | 'MODEL_LOAD_FAILED'
  | 'INFERENCE_FAILED'
  | 'INFERENCE_TIMEOUT'
  | 'RUNTIME_OUTPUT_INVALID'
  | 'RUNTIME_OUTPUT_TOO_LARGE'
  | 'CLIP_NOT_FOUND'
  | 'CLIP_NOT_DECODABLE'
  | 'NO_FRAMES_DECODED';

/** Public, path-free description of the model the runtime would run. */
export interface LocalModelDescriptor {
  /** Registry key, ^[a-z0-9][a-z0-9._-]{0,63}$ — never a path. */
  modelId: string;
  task: 'DETECT';
  /** Which local runtime family executes the model. */
  runtime: 'ULTRALYTICS';
  format: 'PT' | 'ONNX';
  /** Operator-declared model version label, ^[A-Za-z0-9._-]{1,32}$. */
  version: string;
  inputSize: number;
  classCount: number;
  /** How many model classes map onto each role (0 = role unsupported —
   *  e.g. a COCO model has no HAND class, so a hand signal must come
   *  from another provider). */
  roleClassCounts: Record<DetectorRole, number>;
}

export interface LocalDetectorStatus {
  availability: LocalRuntimeAvailability;
  reasonCode: LocalRuntimeReasonCode | null;
  model: LocalModelDescriptor | null;
  /** 'CPU' | 'CUDA' | null — reported by the probe, never a device path. */
  device: 'CPU' | 'CUDA' | null;
  /** Runtime family version label as reported by the worker, sanitized
   *  to ^[0-9A-Za-z._-]{1,32}$ (e.g. '8.3.40'); null when unknown. */
  runtimeVersion: string | null;
}

export interface NormalizedDetectorBox {
  /** 0..1 in the analysis frame. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DetectorDetection {
  role: DetectorRole;
  /** Index into the model's class list (the registry validated it). */
  classIndex: number;
  confidence: number;
  box: NormalizedDetectorBox;
}

export interface DetectorFrameResult {
  frameIndex: number;
  timestampMs: number;
  detections: DetectorDetection[];
}

export interface LocalDetectorRequest {
  tenantId: string;
  videoAssetId: string;
}

export interface LocalDetectorResult {
  status: 'OK' | 'UNAVAILABLE' | 'FAILED';
  reasonCode: LocalRuntimeReasonCode | null;
  model: LocalModelDescriptor | null;
  device: 'CPU' | 'CUDA' | null;
  /** Analysis-frame geometry the boxes are normalized against. */
  analysisDims: { width: number; height: number } | null;
  /** Sampling actually used (frames per second, may be downsampled). */
  sampledFps: number | null;
  frames: DetectorFrameResult[];
  elapsedMs: number | null;
}

/**
 * The LOCAL detector runtime port. Implementations resolve the clip
 * themselves (tenant-scoped read of the video asset), decode analysis
 * frames through the existing confined ffmpeg decoder, run the local
 * model, and return SAFE OUTPUT only. They must never throw for a
 * missing runtime/model — they report UNAVAILABLE with a code — and
 * must never mutate any table.
 */
export interface LocalDetectorRuntimePort {
  status(): Promise<LocalDetectorStatus>;
  detect(request: LocalDetectorRequest): Promise<LocalDetectorResult>;
}
