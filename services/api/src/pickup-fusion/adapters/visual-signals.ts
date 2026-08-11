import { Injectable } from '@nestjs/common';
import { ProductStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { LocalVideoStorageAdapter } from '../../video-ingest/storage/local-video-storage.adapter';
import { PickupAnalysisFrameDecoder } from '../../pickup-detection/analysis/analysis-frames';
import {
  RgbImage,
  matchProduct,
} from '../../pickup-detection/analysis/product-matcher';
import { PickupReferenceLibrary } from '../../pickup-detection/reference-library';
import { CandidateSignal, ClassicalMatcher, VisualRetriever } from '../ports';
import {
  EMBEDDING_MODEL_KEY,
  EMBEDDING_MODEL_VERSION,
  computeDescriptor,
  cosineSimilarity,
} from '../primitives';

/**
 * Versioned visual-embedding retrieval over the reference library.
 *
 * Index contract (requirement 7): one vector row per (reference image,
 * model key); `ensureIndex` backfills any image missing a vector for THIS
 * model — new uploads therefore become searchable on the next index pass,
 * the DB stays the source of truth, and a future CLIP/DINO adapter
 * backfills alongside these vectors under its own key instead of
 * overwriting them. Retrieval is exact cosine NN (catalog-scale, fine
 * in-process on the edge worker); per-product aggregation takes the best
 * image similarity.
 */
@Injectable()
export class HogLabVisualRetriever implements VisualRetriever {
  readonly adapterKey = 'hog-lab-retriever';
  readonly version = '1.0.0';
  readonly embeddingModelKey = EMBEDDING_MODEL_KEY;
  readonly embeddingModelVersion = EMBEDDING_MODEL_VERSION;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: LocalVideoStorageAdapter,
    private readonly decoder: PickupAnalysisFrameDecoder,
  ) {}

  checkReady(): Promise<boolean> {
    return Promise.resolve(true);
  }

  async ensureIndex(tenantId: string): Promise<{ indexed: number; total: number }> {
    // ACTIVE products only — the same rule the reference library enforces.
    // A retired product keeps its stored images and vectors, but they must
    // not stay searchable; a re-activated product is backfilled on the
    // next index pass.
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
    let indexed = 0;
    for (const image of images) {
      if (image.embeddings.length > 0) {
        continue;
      }
      try {
        const decoded = await this.decoder.decodeReferenceImage(
          this.storage.internalPathFor(image.storageKey),
        );
        const vector = [...computeDescriptor(decoded)];
        await this.prisma.productReferenceEmbedding.create({
          data: {
            tenantId,
            referenceImageId: image.id,
            productId: image.productId,
            modelKey: this.embeddingModelKey,
            modelVersion: this.embeddingModelVersion,
            vector,
          },
        });
        indexed += 1;
      } catch {
        // Undecodable stored image: skipped, surfaced via totals.
      }
    }
    return { indexed, total: images.length };
  }

  async retrieve(
    tenantId: string,
    crop: RgbImage,
    topK: number,
  ): Promise<CandidateSignal[]> {
    const query = computeDescriptor(crop);
    // ACTIVE products only: vectors indexed while a product was active
    // must stop matching the moment it is retired — otherwise a
    // DRAFT/DISCONTINUED/ARCHIVED product with reference images could
    // accumulate retrieval score and re-enter fusion as a candidate.
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
    const bestByProduct = new Map<string, CandidateSignal>();
    for (const row of rows) {
      const similarity = cosineSimilarity(query, row.vector as number[]);
      const existing = bestByProduct.get(row.productId);
      if (!existing || similarity > existing.score) {
        bestByProduct.set(row.productId, {
          productId: row.productId,
          sku: row.product.sku,
          score: similarity,
          detail: `${this.embeddingModelKey}@${this.embeddingModelVersion}`,
        });
      }
    }
    return [...bestByProduct.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
}

/** The UNCHANGED v1 HSV+NCC signal behind the v2 port (requirement 8). */
@Injectable()
export class ClassicalHsvNccMatcher implements ClassicalMatcher {
  readonly adapterKey = 'classical-hsv-histogram+ncc';
  readonly version = '1.0.0';

  constructor(private readonly library: PickupReferenceLibrary) {}

  checkReady(): Promise<boolean> {
    return Promise.resolve(true);
  }

  async match(tenantId: string, crop: RgbImage): Promise<CandidateSignal[]> {
    const { references } = await this.library.load(tenantId);
    return matchProduct(crop, references).map((candidate) => ({
      productId: candidate.productId,
      sku: candidate.sku,
      score: candidate.score,
      detail: 'hsv-histogram+ncc',
    }));
  }
}
