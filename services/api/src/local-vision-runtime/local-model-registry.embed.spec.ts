import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { LocalModelRegistry, parseEmbedManifest } from './local-model-registry';

function configWith(values: Record<string, string | undefined>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

function embedManifest(overrides: Record<string, unknown> = {}) {
  return {
    modelId: 'clip-vit-b32',
    task: 'embed',
    runtime: 'open_clip',
    arch: 'ViT-B-32',
    pretrained: 'laion2b_s34b_b79k',
    dim: 512,
    version: 'laion2b',
    inputSize: 224,
    ...overrides,
  };
}

describe('parseEmbedManifest', () => {
  it('accepts a HUB_CACHE manifest (pretrained tag, no file)', () => {
    expect(parseEmbedManifest(embedManifest())).toEqual({
      modelId: 'clip-vit-b32',
      file: null,
      pretrained: 'laion2b_s34b_b79k',
      arch: 'ViT-B-32',
      dim: 512,
      version: 'laion2b',
      inputSize: 224,
    });
  });

  it('accepts a checkpoint manifest (file, no tag) and defaults inputSize', () => {
    const parsed = parseEmbedManifest(
      embedManifest({ pretrained: undefined, file: 'clip.pt', inputSize: undefined }),
    );
    expect(parsed?.file).toBe('clip.pt');
    expect(parsed?.pretrained).toBeNull();
    expect(parsed?.inputSize).toBe(224);
  });

  it('rejects both or neither weight sources, wrong task/runtime, unsafe tokens, bad dims', () => {
    expect(parseEmbedManifest(embedManifest({ file: 'clip.pt' }))).toBeNull();
    expect(parseEmbedManifest(embedManifest({ pretrained: undefined }))).toBeNull();
    expect(parseEmbedManifest(embedManifest({ task: 'detect' }))).toBeNull();
    expect(parseEmbedManifest(embedManifest({ runtime: 'ultralytics' }))).toBeNull();
    expect(parseEmbedManifest(embedManifest({ pretrained: '../escape' }))).toBeNull();
    expect(parseEmbedManifest(embedManifest({ pretrained: 'http://x/y' }))).toBeNull();
    expect(parseEmbedManifest(embedManifest({ arch: 'ViT B 32' }))).toBeNull();
    expect(parseEmbedManifest(embedManifest({ dim: 8 }))).toBeNull();
    expect(parseEmbedManifest(embedManifest({ dim: 512.5 }))).toBeNull();
    expect(parseEmbedManifest(embedManifest({ inputSize: 16 }))).toBeNull();
    expect(
      parseEmbedManifest(embedManifest({ pretrained: undefined, file: 'weights.onnx' })),
    ).toBeNull();
    expect(parseEmbedManifest(embedManifest({ modelId: '../x' }))).toBeNull();
    expect(parseEmbedManifest(null)).toBeNull();
  });
});

describe('LocalModelRegistry.resolveEmbedding', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'byond-embed-registry-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function seed(modelId: string, doc: unknown, weightsName: string | null = null) {
    const dir = join(root, modelId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(doc));
    if (weightsName) {
      await writeFile(join(dir, weightsName), Buffer.alloc(16));
    }
  }

  it('reports MODEL_NOT_CONFIGURED when no embed model id is set', async () => {
    const registry = new LocalModelRegistry(configWith({ CV_LOCAL_MODEL_ROOT: root }));
    expect(await registry.resolveEmbedding()).toEqual({
      ok: false,
      reasonCode: 'MODEL_NOT_CONFIGURED',
    });
  });

  it('resolves a HUB_CACHE model with no weights file and no path in the descriptor', async () => {
    await seed('clip-vit-b32', embedManifest());
    const registry = new LocalModelRegistry(
      configWith({ CV_LOCAL_MODEL_ROOT: root, CV_LOCAL_EMBED_MODEL_ID: 'clip-vit-b32' }),
    );
    const resolution = await registry.resolveEmbedding();
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.internalModelFile).toBeNull();
    expect(resolution.descriptor).toEqual({
      modelId: 'clip-vit-b32',
      task: 'EMBED',
      runtime: 'OPEN_CLIP',
      format: 'HUB_CACHE',
      arch: 'ViT-B-32',
      pretrained: 'laion2b_s34b_b79k',
      dim: 512,
      version: 'laion2b',
      inputSize: 224,
    });
    expect(JSON.stringify(resolution.descriptor)).not.toContain(root);
  });

  it('resolves a checkpoint model and confines the file inside the root', async () => {
    await seed('clip-ft', embedManifest({ modelId: 'clip-ft', pretrained: undefined, file: 'clip.pt' }), 'clip.pt');
    const registry = new LocalModelRegistry(
      configWith({ CV_LOCAL_MODEL_ROOT: root, CV_LOCAL_EMBED_MODEL_ID: 'clip-ft' }),
    );
    const resolution = await registry.resolveEmbedding();
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.descriptor.format).toBe('PT');
    expect(resolution.internalModelFile).toContain('clip.pt');
    expect(JSON.stringify(resolution.descriptor)).not.toContain('clip.pt');
  });

  it('reports MODEL_NOT_FOUND when the checkpoint named by the manifest is missing', async () => {
    await seed('clip-ft', embedManifest({ modelId: 'clip-ft', pretrained: undefined, file: 'clip.pt' }));
    const registry = new LocalModelRegistry(
      configWith({ CV_LOCAL_MODEL_ROOT: root, CV_LOCAL_EMBED_MODEL_ID: 'clip-ft' }),
    );
    expect(await registry.resolveEmbedding()).toEqual({ ok: false, reasonCode: 'MODEL_NOT_FOUND' });
  });

  it('rejects a manifest whose id differs from the directory / configured key', async () => {
    await seed('clip-vit-b32', embedManifest({ modelId: 'other' }));
    const registry = new LocalModelRegistry(
      configWith({ CV_LOCAL_MODEL_ROOT: root, CV_LOCAL_EMBED_MODEL_ID: 'clip-vit-b32' }),
    );
    expect(await registry.resolveEmbedding()).toEqual({
      ok: false,
      reasonCode: 'MODEL_MANIFEST_MISMATCH',
    });
  });

  it('rejects a DETECT manifest configured as the embed model', async () => {
    await seed('yolo', {
      modelId: 'yolo',
      task: 'detect',
      runtime: 'ultralytics',
      file: 'model.pt',
      version: '1',
      inputSize: 640,
      classes: ['bottle'],
      roles: { PRODUCT: ['bottle'] },
    }, 'model.pt');
    const registry = new LocalModelRegistry(
      configWith({ CV_LOCAL_MODEL_ROOT: root, CV_LOCAL_EMBED_MODEL_ID: 'yolo' }),
    );
    expect(await registry.resolveEmbedding()).toEqual({
      ok: false,
      reasonCode: 'MODEL_MANIFEST_INVALID',
    });
  });

  it('keeps the detect and embed slots independent', async () => {
    await seed('clip-vit-b32', embedManifest());
    const registry = new LocalModelRegistry(
      configWith({
        CV_LOCAL_MODEL_ROOT: root,
        CV_LOCAL_EMBED_MODEL_ID: 'clip-vit-b32',
        CV_LOCAL_YOLO_MODEL_ID: 'missing-yolo',
      }),
    );
    expect((await registry.resolveEmbedding()).ok).toBe(true);
    expect(await registry.resolve()).toEqual({ ok: false, reasonCode: 'MODEL_NOT_FOUND' });
  });
});
