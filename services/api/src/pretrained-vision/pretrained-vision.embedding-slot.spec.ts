import type {
  LocalEmbeddingRuntimePort,
  LocalEmbeddingStatus,
} from '../local-vision-runtime/local-vision-runtime.port';
import { AdapterAnalysisContext, EmbeddingRetrievalAdapter } from './pretrained-vision.adapters';

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
    dim: 512,
    version: 'laion2b',
    inputSize: 224,
  },
  device: 'CUDA',
  runtimeVersion: '2.26.1',
};

function runtimeWith(status: LocalEmbeddingStatus | Error): LocalEmbeddingRuntimePort {
  return {
    status: jest.fn(async () => {
      if (status instanceof Error) throw status;
      return status;
    }),
    embed: jest.fn(),
  };
}

const ctx: AdapterAnalysisContext = {
  tenantId: 'tenant-a',
  videoAssetId: 'clip-1',
  classical: null,
  analysisDims: null,
  referenceSkus: [{ productId: 'p1', sku: 'WATER' }],
};

describe('EMBEDDING_LOCAL slot with a real local encoder (Phase 24)', () => {
  it('reports READY with the sanitized encoder descriptor and never a path or tag', async () => {
    const adapter = new EmbeddingRetrievalAdapter(true, false, runtimeWith(READY));
    const status = await adapter.status();
    expect(status).toEqual({
      provider: 'EMBEDDING_LOCAL',
      kind: 'EMBEDDING',
      availability: 'READY',
      reasonCode: null,
      stubMode: false,
      runtime: {
        modelId: 'clip-vit-b32',
        runtimeKind: 'OPEN_CLIP',
        format: 'HUB_CACHE',
        version: 'laion2b',
        device: 'CUDA',
      },
    });
    expect(JSON.stringify(status)).not.toContain('laion2b_s34b_b79k');
  });

  it('passes the runtime reason code through when the encoder is unavailable', async () => {
    const adapter = new EmbeddingRetrievalAdapter(
      true,
      false,
      runtimeWith({
        availability: 'UNAVAILABLE',
        reasonCode: 'MODEL_NOT_CONFIGURED',
        model: null,
        device: null,
        runtimeVersion: null,
      }),
    );
    expect(await adapter.status()).toMatchObject({
      availability: 'UNAVAILABLE',
      reasonCode: 'MODEL_NOT_CONFIGURED',
      runtime: null,
    });
    const evidence = await adapter.analyze(ctx);
    expect(evidence.availability).toBe('UNAVAILABLE');
    expect(evidence.reasonCode).toBe('MODEL_NOT_CONFIGURED');
    expect(evidence.synthetic).toBe(false);
  });

  it('classifies a throwing probe as LOCAL_RUNTIME_PROBE_FAILED', async () => {
    const adapter = new EmbeddingRetrievalAdapter(true, false, runtimeWith(new Error('boom')));
    expect((await adapter.status()).reasonCode).toBe('LOCAL_RUNTIME_PROBE_FAILED');
    expect((await adapter.analyze(ctx)).reasonCode).toBe('LOCAL_RUNTIME_PROBE_FAILED');
  });

  it('in real mode the ranking is served by fusion: READY, non-synthetic, no candidates, a code note', async () => {
    const adapter = new EmbeddingRetrievalAdapter(true, false, runtimeWith(READY));
    const evidence = await adapter.analyze(ctx);
    expect(evidence.availability).toBe('READY');
    expect(evidence.synthetic).toBe(false);
    expect(evidence.embeddingCandidates).toEqual([]);
    expect(evidence.notes).toEqual(['EMBEDDING_RANKING_SERVED_BY_FUSION_RETRIEVAL']);
  });

  it('stub mode still wins over a bound runtime, and DISABLED never touches it', async () => {
    const runtime = runtimeWith(READY);
    const stub = new EmbeddingRetrievalAdapter(true, true, runtime);
    expect(await stub.status()).toMatchObject({ availability: 'READY', stubMode: true, runtime: null });
    expect((await stub.analyze(ctx)).synthetic).toBe(true);
    const disabled = new EmbeddingRetrievalAdapter(false, false, runtime);
    expect(await disabled.status()).toMatchObject({ availability: 'DISABLED', reasonCode: 'PROVIDER_NOT_ENABLED' });
    expect(runtime.status).not.toHaveBeenCalled();
  });

  it('without a bound runtime the slot stays UNAVAILABLE exactly as before', async () => {
    const adapter = new EmbeddingRetrievalAdapter(true, false);
    expect(await adapter.status()).toMatchObject({
      availability: 'UNAVAILABLE',
      reasonCode: 'LOCAL_RUNTIME_NOT_INSTALLED',
    });
  });
});
