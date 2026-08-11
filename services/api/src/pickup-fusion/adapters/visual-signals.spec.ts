import { ProductStatus } from '@prisma/client';
import { RgbImage } from '../../pickup-detection/analysis/product-matcher';
import { computeDescriptor } from '../primitives';
import { HogLabVisualRetriever } from './visual-signals';

/**
 * ACTIVE-only retrieval guarantee: the embedding index and the
 * nearest-neighbour query are constrained to ACTIVE products — the same
 * rule the classical path's reference library enforces. A retired
 * (DRAFT/DISCONTINUED/ARCHIVED) product with stored reference vectors
 * must never re-enter fusion as a retrieval candidate, no matter how
 * perfect the visual match.
 */

const CROP: RgbImage = (() => {
  const width = 16;
  const height = 16;
  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0; i < rgb.length; i += 3) {
    const on = (i / 3) % 4 < 2;
    rgb[i] = on ? 40 : 200;
    rgb[i + 1] = on ? 80 : 120;
    rgb[i + 2] = on ? 210 : 60;
  }
  return { width, height, rgb };
})();

/** Prisma stand-in that HONORS the product-status filter like the DB. */
function statusFiltered<T extends { product: { status: ProductStatus } }>(
  rows: T[],
) {
  return jest.fn(
    async (args: { where: { product?: { status?: ProductStatus } } }) =>
      rows.filter(
        (row) =>
          args.where.product?.status === undefined ||
          row.product.status === args.where.product.status,
      ),
  );
}

describe('HogLabVisualRetriever ACTIVE-only candidates', () => {
  it('retrieve: a perfect-match vector on an inactive product is never returned', async () => {
    // Both products carry the QUERY DESCRIPTOR ITSELF as their stored
    // vector — cosine similarity 1.0, the strongest possible signal.
    const vector = [...computeDescriptor(CROP)];
    const findMany = statusFiltered([
      {
        productId: 'p-active',
        vector,
        product: { sku: 'ACTIVE-1', status: ProductStatus.ACTIVE },
      },
      {
        productId: 'p-retired',
        vector,
        product: { sku: 'RETIRED-1', status: ProductStatus.DISCONTINUED },
      },
    ]);
    const retriever = new HogLabVisualRetriever(
      { productReferenceEmbedding: { findMany } } as never,
      { internalPathFor: () => '/x' } as never,
      { decodeReferenceImage: jest.fn() } as never,
    );

    const results = await retriever.retrieve('tenant-1', CROP, 5);

    expect(results.map((signal) => signal.sku)).toEqual(['ACTIVE-1']);
    expect(results.map((signal) => signal.sku)).not.toContain('RETIRED-1');
    // The constraint must live IN THE QUERY, not in post-filtering.
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          product: { status: ProductStatus.ACTIVE },
        }),
      }),
    );
  });

  it('ensureIndex: only ACTIVE products are (back)filled into the index', async () => {
    const decodeReferenceImage = jest.fn(async () => CROP);
    const embeddingCreate = jest.fn(
      async (_args: { data: { productId: string } }) => ({ id: 'vec-1' }),
    );
    const findMany = statusFiltered([
      {
        id: 'img-active',
        productId: 'p-active',
        storageKey: 'k-active',
        embeddings: [],
        product: { status: ProductStatus.ACTIVE },
      },
      {
        id: 'img-retired',
        productId: 'p-retired',
        storageKey: 'k-retired',
        embeddings: [],
        product: { status: ProductStatus.ARCHIVED },
      },
    ]);
    const retriever = new HogLabVisualRetriever(
      {
        productReferenceImage: { findMany },
        productReferenceEmbedding: { create: embeddingCreate },
      } as never,
      { internalPathFor: (key: string) => key } as never,
      { decodeReferenceImage } as never,
    );

    const outcome = await retriever.ensureIndex('tenant-1');

    // The archived product's image is invisible to the index pass.
    expect(outcome).toEqual({ indexed: 1, total: 1 });
    expect(decodeReferenceImage).toHaveBeenCalledTimes(1);
    expect(decodeReferenceImage).toHaveBeenCalledWith('k-active');
    expect(embeddingCreate).toHaveBeenCalledTimes(1);
    expect(embeddingCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ productId: 'p-active' }),
      }),
    );
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          product: { status: ProductStatus.ACTIVE },
        }),
      }),
    );
  });
});
