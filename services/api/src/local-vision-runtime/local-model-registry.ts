import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DetectorRole,
  LocalEmbeddingModelDescriptor,
  LocalModelDescriptor,
  LocalRuntimeReasonCode,
} from './local-vision-runtime.port';

/**
 * SAFE LOCAL MODEL REGISTRY.
 *
 * Models are external, gitignored artifacts under ONE operator-configured
 * root (CV_LOCAL_MODEL_ROOT, default `<repo>/ml/models`):
 *
 *   <root>/<modelId>/manifest.json
 *   <root>/<modelId>/<manifest.file>        (.pt or .onnx weights; an
 *                                            open_clip HUB_CACHE model has
 *                                            no file at all)
 *
 * The API selects a model by REGISTRY KEY only (CV_LOCAL_YOLO_MODEL_ID for
 * the detector, CV_LOCAL_EMBED_MODEL_ID for the embedding encoder) — never
 * by path. Every filesystem access re-verifies the resolved path stays
 * INSIDE the root (charset allowlist + traversal rejection +
 * resolved-prefix re-check, the same discipline as the local video
 * storage adapter), the manifest is rebuilt field-by-field through an
 * allowlist, and the ONLY thing that ever carries an absolute path is
 * `internalModelFile` on the resolution — a process-internal capability
 * in the spirit of the local storage adapter's path seam, never part of
 * a status, result, response, log line, or error.
 */

const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MODEL_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(pt|onnx)$/;
const CLASS_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/;
const VERSION_PATTERN = /^[A-Za-z0-9._-]{1,32}$/;
/** open_clip architecture names and pretrained tags: safe tokens only —
 *  a tag is looked up in the runtime's own local cache, never opened as
 *  a path by this process. */
const ARCH_PATTERN = /^[A-Za-z0-9._-]{1,48}$/;
const PRETRAINED_TAG_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export const MAX_MANIFEST_BYTES = 64 * 1024;
export const MAX_MODEL_FILE_BYTES = 2 * 1024 * 1024 * 1024;
export const MIN_INPUT_SIZE = 320;
export const MAX_INPUT_SIZE = 1280;
export const MAX_CLASSES = 1024;
/** Embedding encoders take a small square input (224 for ViT-B-32). */
export const MIN_EMBED_INPUT_SIZE = 64;
export const MAX_EMBED_INPUT_SIZE = 1024;
export const MIN_EMBED_DIM = 16;
export const MAX_EMBED_DIM = 4096;
/** Resolution cache TTL — same cadence as the ffmpeg tooling probe. */
export const REGISTRY_CACHE_TTL_MS = 60_000;

const ROLE_ORDER: DetectorRole[] = ['PRODUCT', 'HAND', 'PERSON', 'OBJECT'];

export type ModelResolution =
  | {
      ok: true;
      descriptor: LocalModelDescriptor;
      /** Model class index → generic role, or null when the manifest maps
       *  the class to no role (the runtime DROPS such detections). */
      classRoles: (DetectorRole | null)[];
      /**
       * Absolute filesystem path of the weights file — a capability of
       * THIS local registry for the local worker runner only. It must
       * never leave the process: not in statuses, results, API responses,
       * error messages, or persisted rows.
       */
      internalModelFile: string;
    }
  | { ok: false; reasonCode: LocalRuntimeReasonCode };

export type EmbeddingModelResolution =
  | {
      ok: true;
      descriptor: LocalEmbeddingModelDescriptor;
      /** Absolute checkpoint path for a PT model, or null for a HUB_CACHE
       *  model (the worker resolves the pretrained tag through the
       *  runtime's own cache). Process-internal — never leaves. */
      internalModelFile: string | null;
    }
  | { ok: false; reasonCode: LocalRuntimeReasonCode };

/** Reject any shape that could escape the root, then re-check the resolved
 *  prefix so even a shape the charset missed cannot leave it. */
function resolveWithinRoot(root: string, segment: string): string | null {
  if (
    segment.length === 0 ||
    segment.includes('..') ||
    segment.includes('/') ||
    segment.includes('\\') ||
    segment.includes(':') ||
    isAbsolute(segment)
  ) {
    return null;
  }
  const resolved = resolve(root, segment);
  if (resolved === root || !resolved.startsWith(root + sep)) {
    return null;
  }
  return resolved;
}

/**
 * Second confinement layer for the files the registry actually opens:
 * resolve symlinks/junctions on BOTH sides and re-check the prefix, so a
 * link planted inside the root can never point the worker at a file
 * outside it. Null when the real path escapes or cannot be resolved.
 */
async function confinedRealPath(
  root: string,
  target: string,
): Promise<string | null> {
  try {
    const [realRoot, realTarget] = await Promise.all([
      realpath(root),
      realpath(target),
    ]);
    return realTarget.startsWith(realRoot + sep) ? realTarget : null;
  } catch {
    return null;
  }
}

interface ParsedManifest {
  modelId: string;
  file: string;
  version: string;
  inputSize: number;
  classes: string[];
  classRoles: (DetectorRole | null)[];
  roleClassCounts: Record<DetectorRole, number>;
  format: 'PT' | 'ONNX';
}

/**
 * Allowlist rebuild of a DETECT manifest document. Anything not explicitly
 * picked and validated here is discarded; any violation rejects the whole
 * manifest (no partial trust). Exported for tests.
 */
export function parseManifest(raw: unknown): ParsedManifest | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const doc = raw as Record<string, unknown>;
  const modelId = doc.modelId;
  const file = doc.file;
  const version = doc.version;
  const inputSize = doc.inputSize;
  const classes = doc.classes;
  if (
    typeof modelId !== 'string' ||
    !MODEL_ID_PATTERN.test(modelId) ||
    modelId.includes('..') ||
    doc.task !== 'detect' ||
    doc.runtime !== 'ultralytics' ||
    typeof file !== 'string' ||
    !MODEL_FILE_PATTERN.test(file) ||
    file.includes('..') ||
    typeof version !== 'string' ||
    !VERSION_PATTERN.test(version) ||
    typeof inputSize !== 'number' ||
    !Number.isInteger(inputSize) ||
    inputSize < MIN_INPUT_SIZE ||
    inputSize > MAX_INPUT_SIZE ||
    inputSize % 32 !== 0 ||
    !Array.isArray(classes) ||
    classes.length === 0 ||
    classes.length > MAX_CLASSES
  ) {
    return null;
  }
  const classNames: string[] = [];
  for (const name of classes) {
    if (typeof name !== 'string' || !CLASS_NAME_PATTERN.test(name)) {
      return null;
    }
    classNames.push(name);
  }
  const rolesDoc = doc.roles;
  if (!rolesDoc || typeof rolesDoc !== 'object' || Array.isArray(rolesDoc)) {
    return null;
  }
  const roles = rolesDoc as Record<string, unknown>;
  for (const key of Object.keys(roles)) {
    if (!ROLE_ORDER.includes(key as DetectorRole)) {
      return null;
    }
  }
  const classRoles: (DetectorRole | null)[] = classNames.map(() => null);
  const roleClassCounts: Record<DetectorRole, number> = {
    PRODUCT: 0,
    HAND: 0,
    PERSON: 0,
    OBJECT: 0,
  };
  for (const role of ROLE_ORDER) {
    const names = roles[role];
    if (names === undefined) {
      continue;
    }
    if (!Array.isArray(names)) {
      return null;
    }
    for (const name of names) {
      if (typeof name !== 'string') {
        return null;
      }
      const index = classNames.indexOf(name);
      // Unknown class name, or one class claimed by two roles → invalid.
      if (index < 0 || classRoles[index] !== null) {
        return null;
      }
      classRoles[index] = role;
      roleClassCounts[role] += 1;
    }
  }
  if (Object.values(roleClassCounts).every((count) => count === 0)) {
    return null;
  }
  return {
    modelId,
    file,
    version,
    inputSize,
    classes: classNames,
    classRoles,
    roleClassCounts,
    format: file.toLowerCase().endsWith('.onnx') ? 'ONNX' : 'PT',
  };
}

interface ParsedEmbedManifest {
  modelId: string;
  /** Checkpoint file name (PT) or null (HUB_CACHE via `pretrained`). */
  file: string | null;
  pretrained: string | null;
  arch: string;
  dim: number;
  version: string;
  inputSize: number;
}

/**
 * Allowlist rebuild of an EMBED manifest document (open_clip-class
 * encoder). Exactly one of `file` (a .pt checkpoint inside the model
 * directory) or `pretrained` (an open_clip cache tag) must be present.
 * Exported for tests.
 */
export function parseEmbedManifest(raw: unknown): ParsedEmbedManifest | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const doc = raw as Record<string, unknown>;
  const modelId = doc.modelId;
  const version = doc.version;
  const arch = doc.arch;
  const dim = doc.dim;
  const inputSize = doc.inputSize ?? 224;
  const file = doc.file;
  const pretrained = doc.pretrained;
  if (
    typeof modelId !== 'string' ||
    !MODEL_ID_PATTERN.test(modelId) ||
    modelId.includes('..') ||
    doc.task !== 'embed' ||
    doc.runtime !== 'open_clip' ||
    typeof version !== 'string' ||
    !VERSION_PATTERN.test(version) ||
    typeof arch !== 'string' ||
    !ARCH_PATTERN.test(arch) ||
    typeof dim !== 'number' ||
    !Number.isInteger(dim) ||
    dim < MIN_EMBED_DIM ||
    dim > MAX_EMBED_DIM ||
    typeof inputSize !== 'number' ||
    !Number.isInteger(inputSize) ||
    inputSize < MIN_EMBED_INPUT_SIZE ||
    inputSize > MAX_EMBED_INPUT_SIZE
  ) {
    return null;
  }
  const hasFile = file !== undefined && file !== null;
  const hasTag = pretrained !== undefined && pretrained !== null;
  if (hasFile === hasTag) {
    return null;
  }
  if (hasFile) {
    if (
      typeof file !== 'string' ||
      !MODEL_FILE_PATTERN.test(file) ||
      !file.toLowerCase().endsWith('.pt') ||
      file.includes('..')
    ) {
      return null;
    }
    return { modelId, file, pretrained: null, arch, dim, version, inputSize };
  }
  if (typeof pretrained !== 'string' || !PRETRAINED_TAG_PATTERN.test(pretrained)) {
    return null;
  }
  return { modelId, file: null, pretrained, arch, dim, version, inputSize };
}

/**
 * Ordered class-identity digest shared with the worker protocol: sha256
 * over the class names joined by a newline, first 32 hex characters. The
 * Python worker computes the identical digest over `model.names` in
 * index order, so a manifest that lists the right NUMBER of classes in
 * the wrong ORDER (or for different weights) is rejected at probe time.
 */
export function classListDigest(classes: readonly string[]): string {
  return createHash('sha256')
    .update(classes.join(String.fromCharCode(10)), 'utf8')
    .digest('hex')
    .slice(0, 32);
}

type ManifestLoad =
  | { ok: true; modelDir: string; document: unknown }
  | { ok: false; reasonCode: LocalRuntimeReasonCode };

interface CacheSlot<T> {
  cache: { resolution: T; checkedAtMs: number } | null;
  inFlight: Promise<T> | null;
}

@Injectable()
export class LocalModelRegistry {
  private readonly root: string;
  private readonly configuredModelId: string | null;
  private readonly configuredEmbedModelId: string | null;
  private readonly detectSlot: CacheSlot<ModelResolution> = {
    cache: null,
    inFlight: null,
  };
  private readonly embedSlot: CacheSlot<EmbeddingModelResolution> = {
    cache: null,
    inFlight: null,
  };

  constructor(config: ConfigService) {
    const configuredRoot = config.get<string>('CV_LOCAL_MODEL_ROOT');
    // Relative roots anchor at the REPO root (the API runs from
    // services/api), matching the video storage default. Resolved once.
    const repoRoot = resolve(process.cwd(), '..', '..');
    this.root = resolve(
      configuredRoot && configuredRoot.trim().length > 0
        ? isAbsolute(configuredRoot)
          ? configuredRoot
          : resolve(repoRoot, configuredRoot)
        : resolve(repoRoot, 'ml', 'models'),
    );
    this.configuredModelId = trimmedOrNull(config.get<string>('CV_LOCAL_YOLO_MODEL_ID'));
    this.configuredEmbedModelId = trimmedOrNull(
      config.get<string>('CV_LOCAL_EMBED_MODEL_ID'),
    );
  }

  /** Cached (60 s TTL, single in-flight) DETECT resolution. Never rejects. */
  resolve(): Promise<ModelResolution> {
    return this.cached(this.detectSlot, () => this.resolveUncached(), {
      ok: false,
      reasonCode: 'MODEL_MANIFEST_INVALID',
    });
  }

  /** Cached (60 s TTL, single in-flight) EMBED resolution. Never rejects. */
  resolveEmbedding(): Promise<EmbeddingModelResolution> {
    return this.cached(this.embedSlot, () => this.resolveEmbeddingUncached(), {
      ok: false,
      reasonCode: 'MODEL_MANIFEST_INVALID',
    });
  }

  private cached<T>(
    slot: CacheSlot<T>,
    compute: () => Promise<T>,
    onThrow: T,
  ): Promise<T> {
    const cached = slot.cache;
    if (
      cached !== null &&
      Date.now() - cached.checkedAtMs < REGISTRY_CACHE_TTL_MS
    ) {
      return Promise.resolve(cached.resolution);
    }
    if (slot.inFlight !== null) {
      return slot.inFlight;
    }
    const pending = compute()
      .catch((): T => onThrow)
      .then((resolution) => {
        slot.cache = { resolution, checkedAtMs: Date.now() };
        slot.inFlight = null;
        return resolution;
      });
    slot.inFlight = pending;
    return pending;
  }

  /** Locate `<root>/<modelId>/manifest.json` under every confinement rule
   *  and parse it as JSON — the shared first half of both resolutions. */
  private async loadManifest(modelId: string | null): Promise<ManifestLoad> {
    if (modelId === null) {
      return { ok: false, reasonCode: 'MODEL_NOT_CONFIGURED' };
    }
    if (!MODEL_ID_PATTERN.test(modelId) || modelId.includes('..')) {
      return { ok: false, reasonCode: 'MODEL_MANIFEST_INVALID' };
    }
    try {
      const rootStat = await stat(this.root);
      if (!rootStat.isDirectory()) {
        return { ok: false, reasonCode: 'MODEL_ROOT_NOT_FOUND' };
      }
    } catch {
      return { ok: false, reasonCode: 'MODEL_ROOT_NOT_FOUND' };
    }
    const modelDir = resolveWithinRoot(this.root, modelId);
    if (modelDir === null) {
      return { ok: false, reasonCode: 'MODEL_MANIFEST_INVALID' };
    }
    const manifestPath = resolveWithinRoot(modelDir, 'manifest.json');
    if (manifestPath === null) {
      return { ok: false, reasonCode: 'MODEL_MANIFEST_INVALID' };
    }
    let manifestBytes: Buffer;
    try {
      const manifestStat = await stat(manifestPath);
      if (!manifestStat.isFile()) {
        return { ok: false, reasonCode: 'MODEL_NOT_FOUND' };
      }
      if (manifestStat.size > MAX_MANIFEST_BYTES) {
        return { ok: false, reasonCode: 'MODEL_MANIFEST_INVALID' };
      }
      const realManifest = await confinedRealPath(this.root, manifestPath);
      if (realManifest === null) {
        return { ok: false, reasonCode: 'MODEL_MANIFEST_INVALID' };
      }
      manifestBytes = await readFile(realManifest);
      // Re-check after the read: the file may have grown between stat
      // and read, and the parser must never see more than the cap.
      if (manifestBytes.length > MAX_MANIFEST_BYTES) {
        return { ok: false, reasonCode: 'MODEL_MANIFEST_INVALID' };
      }
    } catch {
      return { ok: false, reasonCode: 'MODEL_NOT_FOUND' };
    }
    try {
      return {
        ok: true,
        modelDir,
        document: JSON.parse(manifestBytes.toString('utf8')),
      };
    } catch {
      return { ok: false, reasonCode: 'MODEL_MANIFEST_INVALID' };
    }
  }

  /** Confine and size-check one weights file named by a manifest. */
  private async confinedWeightsFile(
    modelDir: string,
    file: string,
  ): Promise<{ ok: true; path: string } | { ok: false; reasonCode: LocalRuntimeReasonCode }> {
    const modelFile = resolveWithinRoot(modelDir, file);
    if (modelFile === null) {
      return { ok: false, reasonCode: 'MODEL_MANIFEST_INVALID' };
    }
    try {
      const fileStat = await stat(modelFile);
      if (!fileStat.isFile()) {
        return { ok: false, reasonCode: 'MODEL_NOT_FOUND' };
      }
      if (fileStat.size > MAX_MODEL_FILE_BYTES) {
        return { ok: false, reasonCode: 'MODEL_FILE_TOO_LARGE' };
      }
      const confined = await confinedRealPath(this.root, modelFile);
      if (confined === null) {
        return { ok: false, reasonCode: 'MODEL_MANIFEST_INVALID' };
      }
      return { ok: true, path: confined };
    } catch {
      return { ok: false, reasonCode: 'MODEL_NOT_FOUND' };
    }
  }

  private async resolveUncached(): Promise<ModelResolution> {
    const loaded = await this.loadManifest(this.configuredModelId);
    if (!loaded.ok) {
      return loaded;
    }
    const parsed = parseManifest(loaded.document);
    if (parsed === null) {
      return { ok: false, reasonCode: 'MODEL_MANIFEST_INVALID' };
    }
    if (parsed.modelId !== this.configuredModelId) {
      return { ok: false, reasonCode: 'MODEL_MANIFEST_MISMATCH' };
    }
    const weights = await this.confinedWeightsFile(loaded.modelDir, parsed.file);
    if (!weights.ok) {
      return weights;
    }
    return {
      ok: true,
      descriptor: {
        modelId: parsed.modelId,
        task: 'DETECT',
        runtime: 'ULTRALYTICS',
        format: parsed.format,
        version: parsed.version,
        inputSize: parsed.inputSize,
        classCount: parsed.classes.length,
        classDigest: classListDigest(parsed.classes),
        roleClassCounts: { ...parsed.roleClassCounts },
      },
      classRoles: [...parsed.classRoles],
      internalModelFile: weights.path,
    };
  }

  private async resolveEmbeddingUncached(): Promise<EmbeddingModelResolution> {
    const loaded = await this.loadManifest(this.configuredEmbedModelId);
    if (!loaded.ok) {
      return loaded;
    }
    const parsed = parseEmbedManifest(loaded.document);
    if (parsed === null) {
      return { ok: false, reasonCode: 'MODEL_MANIFEST_INVALID' };
    }
    if (parsed.modelId !== this.configuredEmbedModelId) {
      return { ok: false, reasonCode: 'MODEL_MANIFEST_MISMATCH' };
    }
    let internalModelFile: string | null = null;
    if (parsed.file !== null) {
      const weights = await this.confinedWeightsFile(loaded.modelDir, parsed.file);
      if (!weights.ok) {
        return weights;
      }
      internalModelFile = weights.path;
    }
    return {
      ok: true,
      descriptor: {
        modelId: parsed.modelId,
        task: 'EMBED',
        runtime: 'OPEN_CLIP',
        format: parsed.file !== null ? 'PT' : 'HUB_CACHE',
        arch: parsed.arch,
        pretrained: parsed.pretrained,
        dim: parsed.dim,
        version: parsed.version,
        inputSize: parsed.inputSize,
      },
      internalModelFile,
    };
  }
}

function trimmedOrNull(value: string | undefined): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}
