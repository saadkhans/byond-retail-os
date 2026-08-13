import { randomUUID, createHash } from 'node:crypto';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  bufferCarriesSensitiveText,
  containsSensitiveFreeText,
  filenameCarriesSensitiveContent,
} from '../video-ingest/media-safety';
import { FrameTextRecognizerPort } from '../video-ingest/recognition/frame-text-recognizer.port';
import { VideoStoragePort } from '../video-ingest/storage/video-storage.port';
import {
  EMBEDDING_MODEL_KEY,
  EMBEDDING_MODEL_VERSION,
} from '../pickup-fusion/primitives';
import { PickupMediaPort } from './pickup-media.port';

/**
 * A product is INFERENCE-READY only at five or more reference images: one
 * angle of one sample is not a recognizable appearance model, and the
 * validation phase's acceptance gate (real-footage confusion matrix) needs
 * every claimed-ready SKU to have a minimally diverse reference set.
 */
export const PICKUP_MIN_REFERENCE_IMAGES = 5;

const MAX_REFERENCE_IMAGE_BYTES = 8 * 1024 * 1024;
const ACCEPTED_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
]);

/** Extension → mime for ZIP entries (which carry no mime of their own). */
export const REFERENCE_EXTENSION_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

/** SAFE read shape — no storageKey, ever (same rule as video artifacts). */
export interface ReferenceImageView {
  id: string;
  productId: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  checksumSha256: string;
  createdAt: Date;
}

export interface ReferenceLibraryStatus {
  productId: string;
  sku: string;
  name: string;
  barcodes: string[];
  referenceCount: number;
  minRequired: number;
  inferenceReady: boolean;
  embeddingCount: number;
  embeddingModelKey: string;
  embeddingModelVersion: string;
  images: ReferenceImageView[];
}

const REFERENCE_SELECT = {
  id: true,
  productId: true,
  originalFilename: true,
  mimeType: true,
  sizeBytes: true,
  checksumSha256: true,
  createdAt: true,
} as const;

/**
 * Connection-layer Prisma codes that can surface AFTER the server received
 * the INSERT — the statement may have committed before the link died, so
 * these never prove the row does not exist.
 */
const AMBIGUOUS_CONNECTION_CODES = new Set([
  'P1001',
  'P1002',
  'P1008',
  'P1017',
]);

/**
 * True only when the database DEFINITELY rejected the insert (the query
 * engine answered with a request-level error, or the client refused to
 * send at all) — the one case where the just-written bytes are provably
 * orphaned. Anything else (dropped connection, engine panic, unknown
 * error) is ambiguous: the INSERT may have committed server-side.
 */
function isDefiniteInsertFailure(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientValidationError) {
    return true;
  }
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    !AMBIGUOUS_CONNECTION_CODES.has(error.code)
  );
}

/** Basename with a conservative charset — display-only, like video uploads. */
function sanitizeFilename(name: string): string {
  const base = name.replace(/^.*[\\/]/, '').slice(0, 120);
  const safe = base.replace(/[^A-Za-z0-9._-]/g, '_');
  return safe.length > 0 ? safe : 'reference-image';
}

/**
 * DB + storage-adapter managed reference library (replaces the manual
 * `.local/pickup-references/<SKU>` directory contract entirely): uploads
 * land under an internal storage key, are verified to DECODE as real
 * images before the row commits, and are served/deleted only through the
 * authenticated endpoints.
 */
@Injectable()
export class ReferenceImagesService {
  private readonly logger = new Logger(ReferenceImagesService.name);

  constructor(
    private readonly prisma: PrismaService,
    // Byte operations go through the provider-neutral storage PORT and
    // decode-validation through the repository-owned media port — module
    // composition binds the local implementations; nothing here depends on
    // the concrete local adapter or its path capability.
    private readonly storage: VideoStoragePort,
    private readonly media: PickupMediaPort,
    private readonly recognizer: FrameTextRecognizerPort,
  ) {}

  /**
   * The SAME payment-data pixel screen the video-ingest pipeline applies
   * to every frame, applied to a reference image BEFORE any byte becomes
   * durable (AGENTS.md payments invariant). Fail-closed in every
   * direction: a recognizer that does not read real pixels, cannot run,
   * or cannot process the image never yields a pass.
   */
  private async screenReferencePixels(buffer: Buffer): Promise<void> {
    if (
      !this.recognizer.readsRealPixels ||
      !(await this.recognizer.checkToolingReady())
    ) {
      throw new ServiceUnavailableException(
        'Reference uploads are refused: payment-data pixel screening ' +
          'cannot run because the configured frame-text recognizer does ' +
          'not read the real image — configure VIDEO_OCR_ENABLED=true ' +
          '(reference images are never stored unscreened)',
      );
    }
    let text: string;
    try {
      text = await this.recognizer.recognize(buffer);
    } catch {
      // Unreadable image = incomplete screen = refusal, never a pass.
      throw new BadRequestException(
        'The image could not be screened for payment data — upload ' +
          'refused (nothing was stored); PNG or JPEG screens most reliably',
      );
    }
    if (containsSensitiveFreeText(text)) {
      throw new BadRequestException(
        'The image appears to contain payment or credential data and ' +
          'was refused (nothing was stored)',
      );
    }
  }

  private async requireProduct(tenantId: string, productId: string) {
    const product = await this.prisma.product.findFirst({
      where: { tenantId, id: productId },
      select: {
        id: true,
        sku: true,
        name: true,
        barcodes: { select: { value: true } },
      },
    });
    if (!product) {
      throw new NotFoundException('Product not found in this tenant');
    }
    return product;
  }

  async upload(
    tenantId: string,
    productId: string,
    file: { buffer: Buffer; mimetype: string; originalname: string },
    actorId?: string,
  ): Promise<ReferenceImageView> {
    const product = await this.requireProduct(tenantId, productId);
    if (!ACCEPTED_MIME_TYPES.has(file.mimetype)) {
      throw new BadRequestException(
        'Reference images must be PNG, JPEG, or WEBP',
      );
    }
    if (file.buffer.length === 0 || file.buffer.length > MAX_REFERENCE_IMAGE_BYTES) {
      throw new BadRequestException(
        `Reference images must be 1 byte to ${MAX_REFERENCE_IMAGE_BYTES} bytes`,
      );
    }
    // The SAME filename policy the video pipeline applies: a credential-
    // or payment-bearing name must never reach a database row. RAW and
    // sanitized forms are both screened (the ZIP bulk-import path funnels
    // through here too, so import paths get the identical gate).
    if (
      filenameCarriesSensitiveContent(file.originalname) ||
      filenameCarriesSensitiveContent(sanitizeFilename(file.originalname))
    ) {
      throw new BadRequestException(
        'Filename must not contain credential- or payment-bearing content',
      );
    }
    const checksumSha256 = createHash('sha256')
      .update(file.buffer)
      .digest('hex');
    const duplicate = await this.prisma.productReferenceImage.findFirst({
      where: { tenantId, productId, checksumSha256 },
      select: REFERENCE_SELECT,
    });
    if (duplicate) {
      // Same bytes for the same product — idempotent, not an error.
      return duplicate;
    }
    // Raw-byte text screen BEFORE the bytes touch storage: a perfectly
    // decodable image can still smuggle a PAN or credential through
    // EXIF/comment metadata or bytes appended after the image terminator —
    // regions the pixel OCR never renders. Same payload detector the
    // video-ingest upload gate applies to every buffer.
    if (bufferCarriesSensitiveText(file.buffer)) {
      throw new BadRequestException(
        'The image carries credential- or payment-bearing text and was ' +
          'refused (nothing was stored)',
      );
    }
    // Payment-data pixel screen BEFORE the bytes touch storage.
    await this.screenReferencePixels(file.buffer);
    const extension =
      file.mimetype === 'image/png'
        ? 'png'
        : file.mimetype === 'image/webp'
          ? 'webp'
          : 'jpg';
    const storageKey = `references/${tenantId}/${product.id}/${randomUUID()}.${extension}`;
    await this.storage.put(storageKey, file.buffer);
    // The gate that keeps the library honest: bytes that do not DECODE as
    // an image can never become a reference row (they would silently
    // weaken every later match). Failure removes the stored bytes.
    try {
      await this.media.decodeReferenceImage(storageKey);
    } catch {
      await this.storage.delete(storageKey).catch(() => undefined);
      throw new BadRequestException(
        'The uploaded file could not be decoded as an image',
      );
    }
    try {
      return await this.prisma.productReferenceImage.create({
        data: {
          tenantId,
          productId: product.id,
          originalFilename: sanitizeFilename(file.originalname),
          mimeType: file.mimetype,
          sizeBytes: file.buffer.length,
          checksumSha256,
          storageKey,
          createdById: actorId ?? null,
        },
        select: REFERENCE_SELECT,
      });
    } catch (error) {
      if (isDefiniteInsertFailure(error)) {
        // The database provably rejected the insert, so the just-written
        // bytes are orphaned (no row will ever reference them) — cleanup
        // is best-effort; a cleanup error must never mask the DB failure.
        await this.storage.delete(storageKey).catch(() => undefined);
        // Two byte-identical uploads racing past the preliminary duplicate
        // query both write files, then collide on the unique constraint.
        // The loser must REPLAY the winning row — the caller asked for
        // exactly what now exists.
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          const winner = await this.prisma.productReferenceImage.findFirst({
            where: { tenantId, productId, checksumSha256 },
            select: REFERENCE_SELECT,
          });
          if (winner) {
            return winner;
          }
        }
        throw error;
      }
      // AMBIGUOUS failure (connection dropped, engine panic, unknown
      // error): the INSERT may have committed before the error surfaced.
      // Deleting here could orphan a COMMITTED row from its bytes, so
      // reconcile via the unique (tenantId, productId, checksumSha256)
      // key instead — a hit means the row exists and the upload succeeded.
      try {
        const committed = await this.prisma.productReferenceImage.findFirst({
          where: { tenantId, productId, checksumSha256 },
          select: REFERENCE_SELECT,
        });
        if (committed) {
          return committed;
        }
      } catch {
        // Reconciliation itself failed — fall through to the safe default.
      }
      // Unable to prove the insert did NOT commit: leave the bytes in
      // place (an orphaned file is harmless; a committed row without
      // bytes would 404 on serve) and surface the original failure.
      this.logger.warn(
        `Ambiguous insert failure for reference image ${storageKey}; ` +
          'reconciliation found no row — keeping stored bytes in place',
      );
      throw error;
    }
  }

  async status(
    tenantId: string,
    productId: string,
  ): Promise<ReferenceLibraryStatus> {
    const product = await this.requireProduct(tenantId, productId);
    const images = await this.prisma.productReferenceImage.findMany({
      where: { tenantId, productId },
      select: REFERENCE_SELECT,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const embeddingCount = await this.prisma.productReferenceEmbedding.count({
      where: { tenantId, productId, modelKey: EMBEDDING_MODEL_KEY },
    });
    return {
      productId: product.id,
      sku: product.sku,
      name: product.name,
      barcodes: product.barcodes.map((barcode) => barcode.value),
      referenceCount: images.length,
      minRequired: PICKUP_MIN_REFERENCE_IMAGES,
      inferenceReady: images.length >= PICKUP_MIN_REFERENCE_IMAGES,
      embeddingCount,
      embeddingModelKey: EMBEDDING_MODEL_KEY,
      embeddingModelVersion: EMBEDDING_MODEL_VERSION,
      images,
    };
  }

  /** Ready overview for every product carrying at least one image, plus
   *  per-product counts — the library page's product picker annotation. */
  async overview(tenantId: string): Promise<
    {
      productId: string;
      sku: string;
      name: string;
      referenceCount: number;
      embeddingCount: number;
      inferenceReady: boolean;
    }[]
  > {
    const grouped = await this.prisma.productReferenceImage.groupBy({
      by: ['productId'],
      where: { tenantId },
      _count: { _all: true },
    });
    const embeddings = await this.prisma.productReferenceEmbedding.groupBy({
      by: ['productId'],
      where: { tenantId, modelKey: EMBEDDING_MODEL_KEY },
      _count: { _all: true },
    });
    const products = await this.prisma.product.findMany({
      where: { tenantId, id: { in: grouped.map((g) => g.productId) } },
      select: { id: true, sku: true, name: true },
    });
    const countByProduct = new Map(
      grouped.map((g) => [g.productId, g._count._all]),
    );
    const embeddingByProduct = new Map(
      embeddings.map((g) => [g.productId, g._count._all]),
    );
    return products
      .map((product) => ({
        productId: product.id,
        sku: product.sku,
        name: product.name,
        referenceCount: countByProduct.get(product.id) ?? 0,
        embeddingCount: embeddingByProduct.get(product.id) ?? 0,
        inferenceReady:
          (countByProduct.get(product.id) ?? 0) >= PICKUP_MIN_REFERENCE_IMAGES,
      }))
      .sort((a, b) => a.sku.localeCompare(b.sku));
  }

  async imageBytes(
    tenantId: string,
    productId: string,
    imageId: string,
  ): Promise<{ data: Buffer; mimeType: string }> {
    const row = await this.prisma.productReferenceImage.findFirst({
      where: { tenantId, productId, id: imageId },
    });
    if (!row) {
      throw new NotFoundException('Reference image not found');
    }
    try {
      return {
        data: await this.storage.read(row.storageKey),
        mimeType: row.mimeType,
      };
    } catch {
      throw new NotFoundException('The stored reference image is unavailable');
    }
  }

  async remove(
    tenantId: string,
    productId: string,
    imageId: string,
  ): Promise<void> {
    const row = await this.prisma.productReferenceImage.findFirst({
      where: { tenantId, productId, id: imageId },
    });
    if (!row) {
      throw new NotFoundException('Reference image not found');
    }
    // Row first (authorization boundary), bytes second: an orphaned file
    // is harmless and unreachable; a row without bytes would 404 on serve.
    // The destructive write carries tenantId itself via the id_tenantId
    // composite key — never trust the lookup above to have scoped it.
    await this.prisma.productReferenceImage.delete({
      where: { id_tenantId: { id: row.id, tenantId } },
    });
    await this.storage.delete(row.storageKey).catch(() => undefined);
  }
}
