import { createHash } from 'node:crypto';
import AdmZip from 'adm-zip';
import { BadRequestException, Injectable } from '@nestjs/common';
import { ProductStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  PICKUP_MIN_REFERENCE_IMAGES,
  REFERENCE_EXTENSION_MIME,
  ReferenceImagesService,
} from './reference-images.service';

/** Hard caps for one archive — production-sanity bounds, not tuning. */
const MAX_ZIP_ENTRIES = 2000;
/**
 * Aggregate INFLATED budget. Every accepted entry's bytes stay resident for
 * the whole request ON TOP of the buffered ZIP itself (256MiB controller
 * cap), so this bound is allocation-aware, not aspirational: 128MiB still
 * fits 16 maximum-size (8MiB) reference photos or hundreds at typical
 * phone-camera sizes — far beyond a legitimate import — while capping the
 * worst-case request footprint at ~384MiB instead of ~768MiB.
 */
const MAX_TOTAL_UNCOMPRESSED_BYTES = 128 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export type RejectionReason =
  | 'UNKNOWN_SKU'
  | 'INVALID_FORMAT'
  | 'NESTED_PATH'
  | 'UNSAFE_PATH'
  | 'TOO_LARGE'
  | 'SIZE_MISMATCH'
  | 'EMPTY_FILE'
  | 'DUPLICATE_IN_ZIP'
  | 'ALREADY_STORED'
  | 'UNDECODABLE';

interface ParsedEntry {
  /** Zip path as display metadata (sanitized on storage). */
  path: string;
  sku: string;
  filename: string;
  mimeType: string | null;
  data: Buffer;
  checksumSha256: string;
}

interface RejectedEntry {
  path: string;
  reason: RejectionReason;
}

export interface ImportPreviewProduct {
  sku: string;
  productId: string;
  name: string;
  existingImages: number;
  newImages: number;
  duplicatesInZip: number;
  alreadyStored: number;
  projectedImages: number;
  projectedInferenceReady: boolean;
  belowMinimumAfterImport: boolean;
  /** Files in the archive under this SKU folder (accepted or not). */
  fileCount: number;
}

export interface ImportPreview {
  matched: ImportPreviewProduct[];
  unknownSkus: { sku: string; fileCount: number }[];
  rejected: RejectedEntry[];
  totals: {
    files: number;
    importable: number;
    rejected: number;
  };
  minRequired: number;
}

export interface ImportReport {
  productsImported: number;
  imagesAccepted: number;
  imagesRejected: number;
  rejections: RejectedEntry[];
  productsNowInferenceReady: { sku: string; productId: string; images: number }[];
  perProduct: {
    sku: string;
    productId: string;
    accepted: number;
    rejected: number;
    totalImages: number;
    inferenceReady: boolean;
  }[];
}

/**
 * ZIP bulk import for the reference library: `<SKU>/<image>` entries are
 * matched against EXACT ACTIVE catalog SKUs (uppercase-normalized — the
 * catalog's own SKU normalization). Unknown folders are REPORTED, never
 * silently turned into products; the catalog stays read-only from here.
 * Storage/dedup/decode-verification all flow through the same
 * ReferenceImagesService contract as single uploads, so an import can
 * never bypass the checks (SHA-256 dedup, decodability gate, managed
 * storage keys). References associate by canonical productId; the SKU and
 * the zip path survive only as display/import metadata.
 */
@Injectable()
export class ReferenceImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly referenceImages: ReferenceImagesService,
  ) {}

  /** Parse + classify every entry. Pure validation — never writes. */
  private parseArchive(zipBuffer: Buffer): {
    entries: ParsedEntry[];
    rejected: RejectedEntry[];
  } {
    let zip: AdmZip;
    try {
      zip = new AdmZip(zipBuffer);
    } catch {
      throw new BadRequestException('The upload is not a readable ZIP archive');
    }
    const zipEntries = zip.getEntries().filter((entry) => !entry.isDirectory);
    if (zipEntries.length === 0) {
      throw new BadRequestException('The ZIP archive contains no files');
    }
    if (zipEntries.length > MAX_ZIP_ENTRIES) {
      throw new BadRequestException(
        `The ZIP archive exceeds ${MAX_ZIP_ENTRIES} files`,
      );
    }
    const entries: ParsedEntry[] = [];
    const rejected: RejectedEntry[] = [];
    let totalBytes = 0;
    for (const entry of zipEntries) {
      const path = entry.entryName.replace(/\\/g, '/');
      // macOS metadata noise is silently irrelevant, not a rejection.
      if (path.startsWith('__MACOSX/') || path.endsWith('.DS_Store')) {
        continue;
      }
      const segments = path.split('/').filter((segment) => segment.length > 0);
      if (segments.some((segment) => segment === '..' || segment === '.')) {
        rejected.push({ path, reason: 'UNSAFE_PATH' });
        continue;
      }
      if (segments.length !== 2) {
        // The contract is exactly `<SKU>/<image>` — deeper nesting is a
        // structure error the operator should see, not guess about.
        rejected.push({ path, reason: 'NESTED_PATH' });
        continue;
      }
      const [skuSegment, filename] = segments;
      const extension = filename.split('.').pop()?.toLowerCase() ?? '';
      const mimeType = REFERENCE_EXTENSION_MIME[extension] ?? null;
      if (mimeType === null) {
        rejected.push({ path, reason: 'INVALID_FORMAT' });
        continue;
      }
      // Judge the DECLARED uncompressed size BEFORE inflating anything: a
      // highly compressed entry (ZIP bomb) would otherwise be allocated
      // and inflated in full before the per-image or aggregate limits
      // ever ran, exhausting API memory inside one request.
      const declaredBytes = entry.header.size;
      if (declaredBytes === 0) {
        // A zero-byte image is never importable — and a zero declared size
        // is the one shape adm-zip's declared-size inflation cap cannot
        // bound (it disables the cap), so it must never reach getData().
        rejected.push({ path, reason: 'EMPTY_FILE' });
        continue;
      }
      if (declaredBytes > MAX_IMAGE_BYTES) {
        rejected.push({ path, reason: 'TOO_LARGE' });
        continue;
      }
      if (totalBytes + declaredBytes > MAX_TOTAL_UNCOMPRESSED_BYTES) {
        throw new BadRequestException(
          'The ZIP archive exceeds the total uncompressed size limit',
        );
      }
      let data: Buffer;
      try {
        // adm-zip caps inflation at the declared size, so an understated
        // header makes zlib throw here instead of allocating the real
        // payload; corrupt entries (bad CRC) surface the same way.
        data = entry.getData();
      } catch {
        rejected.push({ path, reason: 'SIZE_MISMATCH' });
        continue;
      }
      // Headers can lie: the ACTUAL inflated length is authoritative. Any
      // disagreement with the declared size that the pre-inflation gates
      // trusted marks the entry hostile — reject it, never import it.
      if (data.length !== declaredBytes) {
        rejected.push({ path, reason: 'SIZE_MISMATCH' });
        continue;
      }
      if (data.length > MAX_IMAGE_BYTES) {
        rejected.push({ path, reason: 'TOO_LARGE' });
        continue;
      }
      totalBytes += data.length;
      if (totalBytes > MAX_TOTAL_UNCOMPRESSED_BYTES) {
        throw new BadRequestException(
          'The ZIP archive exceeds the total uncompressed size limit',
        );
      }
      entries.push({
        path,
        sku: skuSegment.toUpperCase(),
        filename,
        mimeType,
        data,
        checksumSha256: createHash('sha256').update(data).digest('hex'),
      });
    }
    return { entries, rejected };
  }

  /** Shared classification for preview AND commit — one truth. */
  private async classify(tenantId: string, zipBuffer: Buffer) {
    const { entries, rejected } = this.parseArchive(zipBuffer);
    const skus = [...new Set(entries.map((entry) => entry.sku))];
    // EXACT ACTIVE SKUs only (requirement 4): a draft/archived product is
    // not a valid import target, and nothing is ever created here.
    const products = await this.prisma.product.findMany({
      where: { tenantId, sku: { in: skus }, status: ProductStatus.ACTIVE },
      select: { id: true, sku: true, name: true },
    });
    const productBySku = new Map(products.map((p) => [p.sku, p]));
    const existingCounts = await this.prisma.productReferenceImage.groupBy({
      by: ['productId'],
      where: { tenantId, productId: { in: products.map((p) => p.id) } },
      _count: { _all: true },
    });
    const existingByProduct = new Map(
      existingCounts.map((g) => [g.productId, g._count._all]),
    );
    const storedChecksums = await this.prisma.productReferenceImage.findMany({
      where: { tenantId, productId: { in: products.map((p) => p.id) } },
      select: { productId: true, checksumSha256: true },
    });
    const storedSet = new Set(
      storedChecksums.map((row) => `${row.productId}:${row.checksumSha256}`),
    );

    const unknownCounts = new Map<string, number>();
    const seenInZip = new Set<string>();
    const importable: (ParsedEntry & { productId: string })[] = [];
    // Rejected entries survive only as classification metadata: their raw
    // bytes are released immediately so the resident inflated set shrinks
    // to what will actually be imported.
    const dropData = (entry: ParsedEntry) => {
      entry.data = Buffer.alloc(0);
    };
    for (const entry of entries) {
      const product = productBySku.get(entry.sku);
      if (!product) {
        unknownCounts.set(entry.sku, (unknownCounts.get(entry.sku) ?? 0) + 1);
        rejected.push({ path: entry.path, reason: 'UNKNOWN_SKU' });
        dropData(entry);
        continue;
      }
      const dedupKey = `${product.id}:${entry.checksumSha256}`;
      if (seenInZip.has(dedupKey)) {
        rejected.push({ path: entry.path, reason: 'DUPLICATE_IN_ZIP' });
        dropData(entry);
        continue;
      }
      seenInZip.add(dedupKey);
      if (storedSet.has(dedupKey)) {
        rejected.push({ path: entry.path, reason: 'ALREADY_STORED' });
        dropData(entry);
        continue;
      }
      importable.push({ ...entry, productId: product.id });
    }
    return {
      entries,
      importable,
      rejected,
      products,
      productBySku,
      existingByProduct,
      unknownCounts,
    };
  }

  async preview(tenantId: string, zipBuffer: Buffer): Promise<ImportPreview> {
    const classified = await this.classify(tenantId, zipBuffer);
    const matched: ImportPreviewProduct[] = classified.products
      .map((product) => {
        const productEntries = classified.entries.filter(
          (entry) => entry.sku === product.sku,
        );
        const newImages = classified.importable.filter(
          (entry) => entry.productId === product.id,
        ).length;
        const duplicatesInZip = classified.rejected.filter(
          (rejection) =>
            rejection.reason === 'DUPLICATE_IN_ZIP' &&
            rejection.path.toUpperCase().startsWith(`${product.sku}/`),
        ).length;
        const alreadyStored = classified.rejected.filter(
          (rejection) =>
            rejection.reason === 'ALREADY_STORED' &&
            rejection.path.toUpperCase().startsWith(`${product.sku}/`),
        ).length;
        const existing = classified.existingByProduct.get(product.id) ?? 0;
        const projected = existing + newImages;
        return {
          sku: product.sku,
          productId: product.id,
          name: product.name,
          existingImages: existing,
          newImages,
          duplicatesInZip,
          alreadyStored,
          projectedImages: projected,
          projectedInferenceReady: projected >= PICKUP_MIN_REFERENCE_IMAGES,
          belowMinimumAfterImport: projected < PICKUP_MIN_REFERENCE_IMAGES,
          fileCount: productEntries.length,
        };
      })
      .sort((a, b) => a.sku.localeCompare(b.sku));
    return {
      matched,
      unknownSkus: [...classified.unknownCounts.entries()]
        .map(([sku, fileCount]) => ({ sku, fileCount }))
        .sort((a, b) => a.sku.localeCompare(b.sku)),
      rejected: classified.rejected,
      totals: {
        files:
          classified.entries.length +
          classified.rejected.filter(
            (rejection) =>
              rejection.reason === 'NESTED_PATH' ||
              rejection.reason === 'UNSAFE_PATH' ||
              rejection.reason === 'INVALID_FORMAT' ||
              rejection.reason === 'EMPTY_FILE' ||
              rejection.reason === 'SIZE_MISMATCH' ||
              rejection.reason === 'TOO_LARGE',
          ).length,
        importable: classified.importable.length,
        rejected: classified.rejected.length,
      },
      minRequired: PICKUP_MIN_REFERENCE_IMAGES,
    };
  }

  async commit(
    tenantId: string,
    zipBuffer: Buffer,
    actorId?: string,
  ): Promise<ImportReport> {
    const classified = await this.classify(tenantId, zipBuffer);
    const rejections: RejectedEntry[] = [...classified.rejected];
    const acceptedByProduct = new Map<string, number>();
    const readyBefore = new Set(
      [...classified.existingByProduct.entries()]
        .filter(([, count]) => count >= PICKUP_MIN_REFERENCE_IMAGES)
        .map(([productId]) => productId),
    );
    for (const entry of classified.importable) {
      try {
        await this.referenceImages.upload(
          tenantId,
          entry.productId,
          {
            buffer: entry.data,
            mimetype: entry.mimeType as string,
            originalname: entry.path,
          },
          actorId,
        );
        acceptedByProduct.set(
          entry.productId,
          (acceptedByProduct.get(entry.productId) ?? 0) + 1,
        );
      } catch (error) {
        // ONLY the single-upload gate's own per-file refusal (undecodable
        // bytes, or the payment-data pixel screen) becomes a per-file
        // rejection. Operational failures — storage writes, database
        // outages, screening tooling unavailable — PROPAGATE and fail the
        // batch: a report that mislabels an infrastructure failure as bad
        // image files sends operators off to discard valid inputs.
        if (error instanceof BadRequestException) {
          rejections.push({ path: entry.path, reason: 'UNDECODABLE' });
        } else {
          throw error;
        }
      }
    }
    const perProduct: ImportReport['perProduct'] = [];
    const nowReady: ImportReport['productsNowInferenceReady'] = [];
    for (const product of classified.products) {
      const accepted = acceptedByProduct.get(product.id) ?? 0;
      const rejectedCount = rejections.filter((rejection) =>
        rejection.path.toUpperCase().startsWith(`${product.sku}/`),
      ).length;
      if (accepted === 0 && rejectedCount === 0) {
        continue;
      }
      const totalImages = await this.prisma.productReferenceImage.count({
        where: { tenantId, productId: product.id },
      });
      const inferenceReady = totalImages >= PICKUP_MIN_REFERENCE_IMAGES;
      perProduct.push({
        sku: product.sku,
        productId: product.id,
        accepted,
        rejected: rejectedCount,
        totalImages,
        inferenceReady,
      });
      if (inferenceReady && !readyBefore.has(product.id)) {
        nowReady.push({
          sku: product.sku,
          productId: product.id,
          images: totalImages,
        });
      }
    }
    return {
      productsImported: [...acceptedByProduct.keys()].length,
      imagesAccepted: [...acceptedByProduct.values()].reduce(
        (sum, count) => sum + count,
        0,
      ),
      imagesRejected: rejections.length,
      rejections,
      productsNowInferenceReady: nowReady,
      perProduct,
    };
  }
}
