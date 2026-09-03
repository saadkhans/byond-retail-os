import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DetectorRole,
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
 *   <root>/<modelId>/<manifest.file>        (.pt or .onnx weights)
 *
 * The API selects a model by REGISTRY KEY only (CV_LOCAL_YOLO_MODEL_ID) —
 * never by path. Every filesystem access re-verifies the resolved path
 * stays INSIDE the root (charset allowlist + traversal rejection +
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

export const MAX_MANIFEST_BYTES = 64 * 1024;
export const MAX_MODEL_FILE_BYTES = 2 * 1024 * 1024 * 1024;
export const MIN_INPUT_SIZE = 320;
export const MAX_INPUT_SIZE = 1280;
export const MAX_CLASSES = 1024;
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
 * Second confinement layer for the two files the registry actually
 * opens: resolve symlinks/junctions on BOTH sides and re-check the
 * prefix, so a link planted inside the root can never point the worker
 * at a file outside it. Null when the real path escapes or cannot be
 * resolved.
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
 * Allowlist rebuild of a manifest document. Anything not explicitly
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

@Injectable()
export class LocalModelRegistry {
  private readonly root: string;
  private readonly configuredModelId: string | null;
  private cache: { resolution: ModelResolution; checkedAtMs: number } | null =
    null;
  private inFlight: Promise<ModelResolution> | null = null;

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
    const configuredId = config.get<string>('CV_LOCAL_YOLO_MODEL_ID');
    this.configuredModelId =
      typeof configuredId === 'string' && configuredId.trim().length > 0
        ? configuredId.trim()
        : null;
  }

  /** Cached (60 s TTL, single in-flight) resolution. Never rejects. */
  resolve(): Promise<ModelResolution> {
    const cached = this.cache;
    if (
      cached !== null &&
      Date.now() - cached.checkedAtMs < REGISTRY_CACHE_TTL_MS
    ) {
      return Promise.resolve(cached.resolution);
    }
    if (this.inFlight !== null) {
      return this.inFlight;
    }
    const pending = this.resolveUncached()
      .catch(
        (): ModelResolution => ({
          ok: false,
          reasonCode: 'MODEL_MANIFEST_INVALID',
        }),
      )
      .then((resolution) => {
        this.cache = { resolution, checkedAtMs: Date.now() };
        this.inFlight = null;
        return resolution;
      });
    this.inFlight = pending;
    return pending;
  }

  private async resolveUncached(): Promise<ModelResolution> {
    if (this.configuredModelId === null) {
      return { ok: false, reasonCode: 'MODEL_NOT_CONFIGURED' };
    }
    if (
      !MODEL_ID_PATTERN.test(this.configuredModelId) ||
      this.configuredModelId.includes('..')
    ) {
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
    const modelDir = resolveWithinRoot(this.root, this.configuredModelId);
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
    let parsed: ParsedManifest | null;
    try {
      parsed = parseManifest(JSON.parse(manifestBytes.toString('utf8')));
    } catch {
      parsed = null;
    }
    if (parsed === null) {
      return { ok: false, reasonCode: 'MODEL_MANIFEST_INVALID' };
    }
    if (parsed.modelId !== this.configuredModelId) {
      return { ok: false, reasonCode: 'MODEL_MANIFEST_MISMATCH' };
    }
    const modelFile = resolveWithinRoot(modelDir, parsed.file);
    if (modelFile === null) {
      return { ok: false, reasonCode: 'MODEL_MANIFEST_INVALID' };
    }
    let realModelFile: string;
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
      realModelFile = confined;
    } catch {
      return { ok: false, reasonCode: 'MODEL_NOT_FOUND' };
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
        roleClassCounts: { ...parsed.roleClassCounts },
      },
      classRoles: [...parsed.classRoles],
      internalModelFile: realModelFile,
    };
  }
}
