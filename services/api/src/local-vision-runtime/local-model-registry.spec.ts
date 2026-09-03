import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { LocalModelRegistry, parseManifest } from './local-model-registry';

function configWith(values: Record<string, string | undefined>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    modelId: 'yolo-retail-v1',
    task: 'detect',
    runtime: 'ultralytics',
    file: 'model.pt',
    version: '1.0.0',
    inputSize: 640,
    classes: ['person', 'hand', 'bottle', 'cup', 'shelf'],
    roles: { PRODUCT: ['bottle', 'cup'], HAND: ['hand'], PERSON: ['person'] },
    ...overrides,
  };
}

describe('LocalModelRegistry', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'byond-model-registry-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function seedModel(
    modelId: string,
    doc: unknown,
    weightsName: string | null = 'model.pt',
  ) {
    const dir = join(root, modelId);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'manifest.json'),
      typeof doc === 'string' ? doc : JSON.stringify(doc),
    );
    if (weightsName) {
      await writeFile(join(dir, weightsName), Buffer.alloc(16));
    }
  }

  it('reports MODEL_NOT_CONFIGURED when no model id is set', async () => {
    const registry = new LocalModelRegistry(
      configWith({ CV_LOCAL_MODEL_ROOT: root }),
    );
    expect(await registry.resolve()).toEqual({
      ok: false,
      reasonCode: 'MODEL_NOT_CONFIGURED',
    });
  });

  it('reports MODEL_ROOT_NOT_FOUND when the root is missing', async () => {
    const registry = new LocalModelRegistry(
      configWith({
        CV_LOCAL_MODEL_ROOT: join(root, 'does-not-exist'),
        CV_LOCAL_YOLO_MODEL_ID: 'yolo-retail-v1',
      }),
    );
    expect(await registry.resolve()).toEqual({
      ok: false,
      reasonCode: 'MODEL_ROOT_NOT_FOUND',
    });
  });

  it('reports MODEL_NOT_FOUND when the model directory or weights are absent', async () => {
    const missingDir = new LocalModelRegistry(
      configWith({
        CV_LOCAL_MODEL_ROOT: root,
        CV_LOCAL_YOLO_MODEL_ID: 'yolo-retail-v1',
      }),
    );
    expect(await missingDir.resolve()).toEqual({
      ok: false,
      reasonCode: 'MODEL_NOT_FOUND',
    });

    await seedModel('yolo-retail-v1', manifest(), null);
    const missingWeights = new LocalModelRegistry(
      configWith({
        CV_LOCAL_MODEL_ROOT: root,
        CV_LOCAL_YOLO_MODEL_ID: 'yolo-retail-v1',
      }),
    );
    expect(await missingWeights.resolve()).toEqual({
      ok: false,
      reasonCode: 'MODEL_NOT_FOUND',
    });
  });

  it.each(['../escape', '..', 'a/b', 'C:\\x', 'UPPER', 'sp ace'])(
    'rejects traversal-shaped or unsafe model id %p without touching the model',
    async (modelId) => {
      await seedModel('yolo-retail-v1', manifest());
      const registry = new LocalModelRegistry(
        configWith({ CV_LOCAL_MODEL_ROOT: root, CV_LOCAL_YOLO_MODEL_ID: modelId }),
      );
      expect(await registry.resolve()).toEqual({
        ok: false,
        reasonCode: 'MODEL_MANIFEST_INVALID',
      });
    },
  );

  it.each([
    '../outside.pt',
    '..\\outside.pt',
    '/abs/model.pt',
    'C:\\weights\\model.pt',
    'sub/model.pt',
    'model.exe',
    'model',
  ])('rejects a manifest weights file reference %p', async (file) => {
    await seedModel('yolo-retail-v1', manifest({ file }));
    const registry = new LocalModelRegistry(
      configWith({
        CV_LOCAL_MODEL_ROOT: root,
        CV_LOCAL_YOLO_MODEL_ID: 'yolo-retail-v1',
      }),
    );
    expect(await registry.resolve()).toEqual({
      ok: false,
      reasonCode: 'MODEL_MANIFEST_INVALID',
    });
  });

  it('rejects malformed manifests (bad JSON, wrong task/runtime, bad input size, bad class names)', async () => {
    const cases: unknown[] = [
      '{not json',
      manifest({ task: 'classify' }),
      manifest({ runtime: 'onnxruntime' }),
      manifest({ inputSize: 650 }),
      manifest({ inputSize: 64 }),
      manifest({ classes: [] }),
      manifest({ classes: ['ok', '../evil'] }),
      manifest({ version: 'v/1' }),
      manifest({ roles: {} }),
      manifest({ roles: { WEAPON: ['bottle'] } }),
    ];
    for (const doc of cases) {
      await seedModel('yolo-retail-v1', doc);
      const registry = new LocalModelRegistry(
        configWith({
          CV_LOCAL_MODEL_ROOT: root,
          CV_LOCAL_YOLO_MODEL_ID: 'yolo-retail-v1',
        }),
      );
      expect(await registry.resolve()).toEqual({
        ok: false,
        reasonCode: 'MODEL_MANIFEST_INVALID',
      });
    }
  });

  it('rejects a role naming a class that is not in the class list, or one class in two roles', () => {
    expect(
      parseManifest(manifest({ roles: { PRODUCT: ['bottle'], HAND: ['glove'] } })),
    ).toBeNull();
    expect(
      parseManifest(
        manifest({ roles: { PRODUCT: ['bottle'], OBJECT: ['bottle'] } }),
      ),
    ).toBeNull();
  });

  it('rejects a model directory that is a link escaping the root (symlink/junction confinement)', async () => {
    // The root only CONTAINS a link named like a valid model id; its
    // target lives outside. String-prefix checks pass, the real path
    // does not — the registry must refuse rather than hand the worker a
    // file outside the configured root.
    const outside = await mkdtemp(join(tmpdir(), 'byond-outside-models-'));
    try {
      await writeFile(join(outside, 'manifest.json'), JSON.stringify(manifest()));
      await writeFile(join(outside, 'model.pt'), Buffer.alloc(16));
      await symlink(outside, join(root, 'yolo-retail-v1'), 'junction');
      const registry = new LocalModelRegistry(
        configWith({
          CV_LOCAL_MODEL_ROOT: root,
          CV_LOCAL_YOLO_MODEL_ID: 'yolo-retail-v1',
        }),
      );
      const resolution = await registry.resolve();
      expect(resolution).toEqual({ ok: false, reasonCode: 'MODEL_MANIFEST_INVALID' });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('reports MODEL_MANIFEST_MISMATCH when the manifest id differs from the configured key', async () => {
    await seedModel('yolo-retail-v1', manifest({ modelId: 'other-model' }));
    const registry = new LocalModelRegistry(
      configWith({
        CV_LOCAL_MODEL_ROOT: root,
        CV_LOCAL_YOLO_MODEL_ID: 'yolo-retail-v1',
      }),
    );
    expect(await registry.resolve()).toEqual({
      ok: false,
      reasonCode: 'MODEL_MANIFEST_MISMATCH',
    });
  });

  it('resolves a valid model to a PATH-FREE descriptor with role mapping', async () => {
    await seedModel('yolo-retail-v1', manifest());
    const registry = new LocalModelRegistry(
      configWith({
        CV_LOCAL_MODEL_ROOT: root,
        CV_LOCAL_YOLO_MODEL_ID: 'yolo-retail-v1',
      }),
    );
    const resolution = await registry.resolve();
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) {
      return;
    }
    expect(resolution.descriptor).toEqual({
      modelId: 'yolo-retail-v1',
      task: 'DETECT',
      runtime: 'ULTRALYTICS',
      format: 'PT',
      version: '1.0.0',
      inputSize: 640,
      classCount: 5,
      roleClassCounts: { PRODUCT: 2, HAND: 1, PERSON: 1, OBJECT: 0 },
    });
    expect(resolution.classRoles).toEqual([
      'PERSON',
      'HAND',
      'PRODUCT',
      'PRODUCT',
      null,
    ]);
    // The absolute weights path lives ONLY on internalModelFile.
    expect(resolution.internalModelFile.startsWith(root)).toBe(true);
    const serialized = JSON.stringify(resolution.descriptor);
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain('model.pt');
    expect(serialized).not.toContain('manifest');
    expect(serialized).not.toMatch(/[\\/]/);
  });

  it('labels .onnx weights as ONNX and anchors a relative root at the repo root', async () => {
    await seedModel('yolo-retail-v1', manifest({ file: 'model.onnx' }), 'model.onnx');
    const registry = new LocalModelRegistry(
      configWith({
        CV_LOCAL_MODEL_ROOT: root,
        CV_LOCAL_YOLO_MODEL_ID: 'yolo-retail-v1',
      }),
    );
    const resolution = await registry.resolve();
    expect(resolution.ok && resolution.descriptor.format).toBe('ONNX');

    // Relative root: never resolved against an absolute temp dir here,
    // just prove it does not throw and reports a classified code.
    const relative = new LocalModelRegistry(
      configWith({
        CV_LOCAL_MODEL_ROOT: 'definitely/missing/registry',
        CV_LOCAL_YOLO_MODEL_ID: 'yolo-retail-v1',
      }),
    );
    expect(await relative.resolve()).toEqual({
      ok: false,
      reasonCode: 'MODEL_ROOT_NOT_FOUND',
    });
  });

  it('caches the resolution and collapses concurrent callers', async () => {
    await seedModel('yolo-retail-v1', manifest());
    const registry = new LocalModelRegistry(
      configWith({
        CV_LOCAL_MODEL_ROOT: root,
        CV_LOCAL_YOLO_MODEL_ID: 'yolo-retail-v1',
      }),
    );
    const [a, b] = await Promise.all([registry.resolve(), registry.resolve()]);
    expect(a).toBe(b);
    // Deleting the weights after a cached resolution keeps the cached
    // answer inside the TTL (a probe TTL, not a per-call stat).
    await rm(join(root, 'yolo-retail-v1', 'model.pt'));
    expect((await registry.resolve()).ok).toBe(true);
  });
});
