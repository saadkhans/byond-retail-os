import type {
  EmbeddingImageInput,
  LocalEmbeddingResult,
  LocalEmbeddingRuntimePort,
  LocalEmbeddingStatus,
} from '../../local-vision-runtime/local-vision-runtime.port';
import { PickupAnalysisFrameDecoder } from '../../pickup-detection/analysis/analysis-frames';
import { PrismaService } from '../../prisma/prisma.service';
import { LocalVideoStorageAdapter } from '../../video-ingest/storage/local-video-storage.adapter';
import { ClipLocalVisualRetriever, aggregateByProduct } from './clip-retriever';

const READY: LocalEmbeddingStatus = {
  availability: 'READY',
  reasonCode: null,
  model: {
    modelId: 'clip-vit-b32',
    task: 'EMBED',
    runtime: 'OPEN_CLIP',
    format: 'HUB_CACHE',
    arch: 'ViT-B-32',
    pretrained: 'laion2b_s34b_b79k',
    dim: 3,
    version: 'laion2b',
    inputSize: 16,
  },
  device: 'CPU',
  runtimeVersion: '2.26.1',
};

const UNAVAILABLE: LocalEmbeddingStatus = {
  availability: 'UNAVAILABLE',
  reasonCode: 'LOCAL_RUNTIME_NOT_INSTALLED',
  model: null,
  device: null,
  runtimeVersion: null,
};

interface HarnessOptions {
  status?: LocalEmbeddingStatus;
  /** Vector the runtime returns for the i-th image of a call. */
  vectorFor?: (index: number, image: EmbeddingImageInput) => number[];
  images?: { id: string; productId: string; storageKey: string; indexed: boolean }[];
  rows?: { productId: string; sku: string; vector: number[] }[];
  decodeError?: boolean;
}

function buildHarness(options: HarnessOptions = {}) {
  const created: Record<string, unknown>[] = [];
  const findManyWhere: unknown[] = [];
  const prisma = {
    productReferenceImage: {
      findMany: jest.fn(async () =>
        (options.images ?? []).map((image) => ({
          id: image.id,
          productId: image.productId,
          storageKey: image.storageKey,
          embeddings: image.indexed ? [{ id: `e-${image.id}` }] : [],
        })),
      ),
    },
    productReferenceEmbedding: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { id: 'new' };
      }),
      findMany: jest.fn(async ({ where }: { where: unknown }) => {
        findManyWhere.push(where);
        return (options.rows ?? []).map((row) => ({
          productId: row.productId,
          vector: row.vector,
          product: { sku: row.sku },
        }));
      }),
      findFirst: jest.fn(async () => ((options.rows ?? []).length ? { id: 'x' } : null)),
    },
  } as unknown as PrismaService;
  const storage = {
    internalPathFor: (key: string) => `C:\\store\\${key}`,
  } as unknown as LocalVideoStorageAdapter;
  const decodeCalls: { path: string; edge: number }[] = [];
  const decoder = {
    decodeReferenceImageFit: jest.fn(async (path: string, edge: number) => {
      decodeCalls.push({ path, edge });
      if (options.decodeError) {
        throw new Error('undecodable');
      }
      return { width: edge, height: edge, rgb: Buffer.alloc(edge * edge * 3, 1) };
    }),
  } as unknown as PickupAnalysisFrameDecoder;
  const embedCalls: EmbeddingImageInput[][] = [];
  const runtime: LocalEmbeddingRuntimePort = {
    status: jest.fn(async () => options.status ?? READY),
    describeModel: jest.fn(async () => (options.status ?? READY).model ?? null),
    embed: jest.fn(async (images: EmbeddingImageInput[]): Promise<LocalEmbeddingResult> => {
      embedCalls.push(images);
      const status = options.status ?? READY;
      if (status.availability !== 'READY') {
        return {
          status: 'UNAVAILABLE',
          reasonCode: status.reasonCode,
          model: null,
          device: null,
          vectors: null,
          dim: null,
          elapsedMs: null,
        };
      }
      return {
        status: 'OK',
        reasonCode: null,
        model: status.model,
        device: 'CPU',
        vectors: images.map((image, index) =>
          options.vectorFor ? options.vectorFor(index, image) : [1, 0, 0],
        ),
        dim: 3,
        elapsedMs: 2,
      };
    }),
  };
  const retriever = new ClipLocalVisualRetriever(prisma, storage, decoder, runtime, 'laion2b');
  return { retriever, created, findManyWhere, decodeCalls, embedCalls };
}

function crop(value: number) {
  return { width: 4, height: 8, rgb: Buffer.alloc(4 * 8 * 3, value) };
}

describe('aggregateByProduct', () => {
  it('takes the best reference per product and reports the top-3 mean as detail', () => {
    const signals = aggregateByProduct([
      { productId: 'p1', sku: 'A', similarity: 0.2 },
      { productId: 'p1', sku: 'A', similarity: 0.9 },
      { productId: 'p1', sku: 'A', similarity: 0.7 },
      { productId: 'p1', sku: 'A', similarity: 0.1 },
      { productId: 'p2', sku: 'B', similarity: 0.5 },
    ]);
    expect(signals.map((row) => [row.sku, row.score])).toEqual([
      ['A', 0.9],
      ['B', 0.5],
    ]);
    expect(signals[0].detail).toBe('clip-local top3=0.600');
  });
});

describe('ClipLocalVisualRetriever.ensureIndex', () => {
  it('embeds only images lacking a clip-local vector, decoded as letterboxed squares', async () => {
    const { retriever, created, decodeCalls, embedCalls } = buildHarness({
      images: [
        { id: 'i1', productId: 'p1', storageKey: 'ref/a.jpg', indexed: true },
        { id: 'i2', productId: 'p1', storageKey: 'ref/b.jpg', indexed: false },
        { id: 'i3', productId: 'p2', storageKey: 'ref/c.jpg', indexed: false },
      ],
    });
    expect(await retriever.ensureIndex('tenant-a')).toEqual({ indexed: 2, total: 3 });
    expect(decodeCalls).toEqual([
      { path: 'C:\\store\\ref/b.jpg', edge: 16 },
      { path: 'C:\\store\\ref/c.jpg', edge: 16 },
    ]);
    expect(embedCalls).toHaveLength(1);
    expect(created).toEqual([
      expect.objectContaining({
        tenantId: 'tenant-a',
        referenceImageId: 'i2',
        productId: 'p1',
        modelKey: 'clip-local',
        modelVersion: 'laion2b',
        vector: [1, 0, 0],
      }),
      expect.objectContaining({ referenceImageId: 'i3', productId: 'p2' }),
    ]);
  });

  it('indexes nothing when the encoder is unavailable (no fabricated vectors)', async () => {
    const { retriever, created, embedCalls } = buildHarness({
      status: UNAVAILABLE,
      images: [{ id: 'i1', productId: 'p1', storageKey: 'ref/a.jpg', indexed: false }],
    });
    expect(await retriever.ensureIndex('tenant-a')).toEqual({ indexed: 0, total: 1 });
    expect(created).toHaveLength(0);
    expect(embedCalls).toHaveLength(0);
  });

  it('skips undecodable images and surfaces the shortfall via totals', async () => {
    const { retriever, created } = buildHarness({
      decodeError: true,
      images: [{ id: 'i1', productId: 'p1', storageKey: 'ref/a.jpg', indexed: false }],
    });
    expect(await retriever.ensureIndex('tenant-a')).toEqual({ indexed: 0, total: 1 });
    expect(created).toHaveLength(0);
  });
});

describe('ClipLocalVisualRetriever.retrieve', () => {
  const rows = [
    { productId: 'p1', sku: 'WATER', vector: [1, 0, 0] },
    { productId: 'p1', sku: 'WATER', vector: [0.6, 0.8, 0] },
    { productId: 'p2', sku: 'NESCAFE', vector: [0, 1, 0] },
    { productId: 'p3', sku: 'CHIPS', vector: [0, 0, 1] },
  ];

  it('ranks products by best cosine similarity, tenant- and model-scoped', async () => {
    const { retriever, findManyWhere } = buildHarness({
      rows,
      vectorFor: () => [1, 0, 0],
    });
    const signals = await retriever.retrieve('tenant-a', crop(1), 2);
    expect(signals.map((row) => [row.sku, row.score])).toEqual([
      ['WATER', 1],
      ['NESCAFE', 0],
    ]);
    expect(signals[0].detail).toBe('clip-local@laion2b crops=1');
    expect(findManyWhere[0]).toEqual({
      tenantId: 'tenant-a',
      modelKey: 'clip-local',
      product: { status: 'ACTIVE' },
    });
  });

  it('returns nothing when the encoder is unavailable or the index is empty', async () => {
    const down = buildHarness({ status: UNAVAILABLE, rows });
    expect(await down.retriever.retrieve('tenant-a', crop(1), 5)).toEqual([]);
    const empty = buildHarness({ rows: [] });
    expect(await empty.retriever.retrieve('tenant-a', crop(1), 5)).toEqual([]);
  });

  it('retrieveMany averages the per-crop best scores across crops', async () => {
    const { retriever, embedCalls } = buildHarness({
      rows,
      vectorFor: (index) => (index === 0 ? [1, 0, 0] : [0, 1, 0]),
    });
    const signals = await retriever.retrieveMany('tenant-a', [crop(1), crop(2)], 3);
    expect(embedCalls).toHaveLength(1);
    expect(embedCalls[0]).toHaveLength(2);
    const bySku = Object.fromEntries(signals.map((row) => [row.sku, row.score]));
    // WATER: crop1 best 1.0, crop2 best 0.8 → 0.9; NESCAFE: 0 and 1 → 0.5.
    expect(bySku.WATER).toBeCloseTo(0.9, 4);
    expect(bySku.NESCAFE).toBeCloseTo(0.5, 4);
    expect(bySku.CHIPS).toBe(0);
    expect(signals[0].detail).toBe('clip-local@laion2b crops=2');
  });
});

describe('ClipLocalVisualRetriever.checkReady', () => {
  it('is ready only with a READY encoder and a non-empty index', async () => {
    expect(await buildHarness({ rows: [{ productId: 'p', sku: 'S', vector: [1, 0, 0] }] }).retriever.checkReady()).toBe(true);
    expect(await buildHarness({ rows: [] }).retriever.checkReady()).toBe(false);
    expect(
      await buildHarness({ status: UNAVAILABLE, rows: [{ productId: 'p', sku: 'S', vector: [1, 0, 0] }] }).retriever.checkReady(),
    ).toBe(false);
  });

  it('declares its own model key and the encoder version as the index generation', () => {
    const { retriever } = buildHarness();
    expect(retriever.embeddingModelKey).toBe('clip-local');
    expect(retriever.embeddingModelVersion).toBe('laion2b');
    expect(retriever.adapterKey).toBe('clip-local-retriever');
  });
});
