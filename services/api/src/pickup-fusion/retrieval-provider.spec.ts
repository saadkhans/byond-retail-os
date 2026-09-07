import { ConfigService } from '@nestjs/config';
import type { LocalEmbeddingRuntimePort } from '../local-vision-runtime/local-vision-runtime.port';
import { PickupAnalysisFrameDecoder } from '../pickup-detection/analysis/analysis-frames';
import { PrismaService } from '../prisma/prisma.service';
import { LocalVideoStorageAdapter } from '../video-ingest/storage/local-video-storage.adapter';
import { ClipLocalVisualRetriever } from './adapters/clip-retriever';
import { HogLabVisualRetriever } from './adapters/visual-signals';
import { buildVisualRetriever, retrievalProviderFrom } from './pickup-fusion.module';

function configWith(values: Record<string, string | undefined>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

const prisma = {} as PrismaService;
const storage = {} as LocalVideoStorageAdapter;
const decoder = {} as PickupAnalysisFrameDecoder;
const runtime = {
  status: jest.fn(),
  embed: jest.fn(),
} as unknown as LocalEmbeddingRuntimePort;

describe('PICKUP_RETRIEVAL_PROVIDER (Phase 24 keyed retrieval binding)', () => {
  it('defaults to the dependency-free HOG index', () => {
    expect(retrievalProviderFrom(configWith({}))).toBe('hog_lab');
    expect(retrievalProviderFrom(configWith({ PICKUP_RETRIEVAL_PROVIDER: 'nonsense' }))).toBe('hog_lab');
    expect(retrievalProviderFrom(configWith({ PICKUP_RETRIEVAL_PROVIDER: ' CLIP_LOCAL ' }))).toBe('clip_local');
  });

  it('binds the CLIP retriever for clip_local with the encoder version as index generation', () => {
    const retriever = buildVisualRetriever('clip_local', prisma, storage, decoder, runtime, 'laion2b');
    expect(retriever).toBeInstanceOf(ClipLocalVisualRetriever);
    expect(retriever.embeddingModelKey).toBe('clip-local');
    expect(retriever.embeddingModelVersion).toBe('laion2b');
  });

  it('binds the HOG retriever for hog_lab (its own key, untouched by the CLIP index)', () => {
    const retriever = buildVisualRetriever('hog_lab', prisma, storage, decoder, runtime, 'laion2b');
    expect(retriever).toBeInstanceOf(HogLabVisualRetriever);
    expect(retriever.embeddingModelKey).toBe('hog-lab-v1');
  });

  it('only falls back to HOG when NO embedding runtime is bound at all (DI absence, not runtime state)', () => {
    const retriever = buildVisualRetriever('clip_local', prisma, storage, decoder, null, 'x');
    expect(retriever).toBeInstanceOf(HogLabVisualRetriever);
  });
});
