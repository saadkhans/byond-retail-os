import { ProductStatus } from '@prisma/client';
import type {
  LocalEmbeddingRuntimePort,
} from '../../local-vision-runtime/local-vision-runtime.port';
import { PickupAnalysisFrameDecoder } from '../../pickup-detection/analysis/analysis-frames';
import { RgbImage } from '../../pickup-detection/analysis/product-matcher';
import { PrismaService } from '../../prisma/prisma.service';
import { LocalVideoStorageAdapter } from '../../video-ingest/storage/local-video-storage.adapter';
import { CandidateSignal, VisualRetriever } from '../ports';
import { cosineSimilarity } from '../primitives';

/**
 * Phase 24 — LOCAL image-embedding retrieval over the reference library.
 *
 * Replaces the HOG-and-colour vectors with real embeddings from the local
 * open_clip-class encoder behind LocalEmbeddingRuntimePort. Same index
 * contract as the HOG adapter (requirement 7): one vector row per
 * (reference image, model key) under its OWN key, so both generations
 * coexist in `ProductReferenceEmbedding` and switching providers never
 * destroys the other index. Retrieval is exact cosine NN, per-product
 * score = best reference similarity. The adapter owns NO media path
 * knowledge beyond the same storage + decoder seam the HOG adapter uses,
 * and it never sees the runtime's model location.
 */

export const CLIP_MODEL_KEY = 'clip-local';
/** How many reference images a single ensureIndex pass embeds per worker
 *  call (the runtime batches further at its protocol ceiling). */
export const INDEX_BATCH_SIZE = 32;
/** Reference vectors of other tenants are never loaded; within a tenant
 *  the catalog is small enough for exact NN (the HOG adapter's assumption). */
const TOP3_DETAIL = 3;

interface ReferenceVectorRow {
  productId: string;
  sku: string;
  vector: number[];
}

/** Per-product aggregation: best similarity and the mean of the top three,
 *  the latter carried as evidence detail only. Exported for tests. */
export function aggregateByProduct(
  similarities: { productId: string; sku: string; similarity: number }[],
): CandidateSignal[] {
  const byProduct = new Map<string, { sku: string; scores: number[] }>();
  for (const row of similarities) {
    const entry = byProduct.get(row.productId) ?? { sku: row.sku, scores: [] };
    entry.scores.push(row.similarity);
    byProduct.set(row.productId, entry);
  }
  const signals: CandidateSignal[] = [];
  for (const [productId, entry] of byProduct) {
    const sorted = [...entry.scores].sort((a, b) => b - a);
    const top = sorted.slice(0, TOP3_DETAIL);
    const meanTop = top.reduce((sum, value) => sum + value, 0) / top.length;
    signals.push({
      productId,
      sku: entry.sku,
      score: Math.round(sorted[0] * 10_000) / 10_000,
      detail: `${CLIP_MODEL_KEY} top3=${(Math.round(meanTop * 1000) / 1000).toFixed(3)}`,
    });
  }
  return signals.sort((a, b) => b.score - a.score);
}

function asVector(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }
  const out: number[] = [];
  for (const entry of value) {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) {
      return null;
    }
    out.push(entry);
  }
  return out;
}

export class ClipLocalVisualRetriever implements VisualRetriever {
  readonly adapterKey = 'clip-local-retriever';
  readonly version = '1.0.0';
  readonly embeddingModelKey = CLIP_MODEL_KEY;
  readonly embeddingModelVersion: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: LocalVideoStorageAdapter,
    private readonly decoder: PickupAnalysisFrameDecoder,
    private readonly runtime: LocalEmbeddingRuntimePort,
    /** Manifest version label of the configured encoder, used as the
     *  index generation label; the module supplies it. */
    modelVersion: string = 'unknown',
  ) {
    this.embeddingModelVersion = modelVersion;
  }

  /** Ready = the local encoder is READY and at least one vector exists
   *  under this model key (an empty index can rank nothing). */
  async checkReady(): Promise<boolean> {
    const status = await this.runtime.status();
    if (status.availability !== 'READY') {
      return false;
    }
    const any = await this.prisma.productReferenceEmbedding.findFirst({
      where: { modelKey: this.embeddingModelKey },
      select: { id: true },
    });
    return any !== null;
  }

  async ensureIndex(tenantId: string): Promise<{ indexed: number; total: number }> {
    const status = await this.runtime.status();
    const images = await this.prisma.productReferenceImage.findMany({
      where: { tenantId, product: { status: ProductStatus.ACTIVE } },
      select: {
        id: true,
        productId: true,
        storageKey: true,
        embeddings: {
          where: { modelKey: this.embeddingModelKey },
          select: { id: true },
        },
      },
    });
    const pending = images.filter((image) => image.embeddings.length === 0);
    if (pending.length === 0 || status.availability !== 'READY' || !status.model) {
      // Nothing to do, or no encoder: an unavailable runtime backfills
      // nothing and the totals surface it (never a fabricated vector).
      return { indexed: 0, total: images.length };
    }
    const edge = status.model.inputSize;
    let indexed = 0;
    for (let offset = 0; offset < pending.length; offset += INDEX_BATCH_SIZE) {
      const batch = pending.slice(offset, offset + INDEX_BATCH_SIZE);
      const decoded: { image: (typeof batch)[number]; pixels: RgbImage }[] = [];
      for (const image of batch) {
        try {
          decoded.push({
            image,
            pixels: await this.decoder.decodeReferenceImageFit(
              this.storage.internalPathFor(image.storageKey),
              edge,
            ),
          });
        } catch {
          // Undecodable stored image: skipped, surfaced via totals.
        }
      }
      if (decoded.length === 0) {
        continue;
      }
      const result = await this.runtime.embed(decoded.map((row) => row.pixels));
      if (result.status !== 'OK' || !result.vectors) {
        // A worker failure mid-index leaves the rows unindexed for the
        // next pass; the totals report the shortfall.
        continue;
      }
      for (let index = 0; index < decoded.length; index += 1) {
        const vector = result.vectors[index];
        if (!vector) {
          continue;
        }
        await this.prisma.productReferenceEmbedding.create({
          data: {
            tenantId,
            referenceImageId: decoded[index].image.id,
            productId: decoded[index].image.productId,
            modelKey: this.embeddingModelKey,
            modelVersion: this.embeddingModelVersion,
            vector,
          },
        });
        indexed += 1;
      }
    }
    return { indexed, total: images.length };
  }

  async retrieve(tenantId: string, crop: RgbImage, topK: number): Promise<CandidateSignal[]> {
    return this.retrieveMany(tenantId, [crop], topK);
  }

  /**
   * Multi-crop voting: every crop is embedded in one worker call, each
   * product's best reference similarity is taken per crop, and the
   * per-crop scores are AVERAGED — a product must look right across the
   * pre/peak/post views, not in one lucky frame. Empty when the encoder
   * is unavailable (the evidence records the adapter as not ready).
   */
  async retrieveMany(
    tenantId: string,
    crops: RgbImage[],
    topK: number,
  ): Promise<CandidateSignal[]> {
    if (crops.length === 0) {
      return [];
    }
    const result = await this.runtime.embed(crops);
    if (result.status !== 'OK' || !result.vectors || result.vectors.length === 0) {
      return [];
    }
    const rows = await this.loadReferenceVectors(tenantId);
    if (rows.length === 0) {
      return [];
    }
    const perCrop = result.vectors.map((query) =>
      aggregateByProduct(
        rows.map((row) => ({
          productId: row.productId,
          sku: row.sku,
          similarity: cosineSimilarity(query, row.vector),
        })),
      ),
    );
    const averaged = new Map<string, { sku: string; sum: number; details: string[] }>();
    for (const signals of perCrop) {
      for (const signal of signals) {
        const entry = averaged.get(signal.productId) ?? { sku: signal.sku, sum: 0, details: [] };
        entry.sum += signal.score;
        if (signal.detail) {
          entry.details.push(signal.detail);
        }
        averaged.set(signal.productId, entry);
      }
    }
    return [...averaged.entries()]
      .map(([productId, entry]) => ({
        productId,
        sku: entry.sku,
        score: Math.round((entry.sum / perCrop.length) * 10_000) / 10_000,
        detail: `${CLIP_MODEL_KEY}@${this.embeddingModelVersion} crops=${perCrop.length}`,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  private async loadReferenceVectors(tenantId: string): Promise<ReferenceVectorRow[]> {
    // ACTIVE products only, tenant-scoped, THIS model key only.
    const rows = await this.prisma.productReferenceEmbedding.findMany({
      where: {
        tenantId,
        modelKey: this.embeddingModelKey,
        product: { status: ProductStatus.ACTIVE },
      },
      select: {
        productId: true,
        vector: true,
        product: { select: { sku: true } },
      },
    });
    const out: ReferenceVectorRow[] = [];
    for (const row of rows) {
      const vector = asVector(row.vector);
      if (vector) {
        out.push({ productId: row.productId, sku: row.product.sku, vector });
      }
    }
    return out;
  }
}
