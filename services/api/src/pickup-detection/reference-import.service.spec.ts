import { createHash } from 'node:crypto';
import AdmZip from 'adm-zip';
import { BadRequestException } from '@nestjs/common';
import { ReferenceImportService } from './reference-import.service';

/**
 * Importer contract tests over in-memory ZIP fixtures: classification
 * (matched/unknown/duplicate/invalid/structure), the never-create-products
 * rule, and the commit report — with the single-upload service mocked, so
 * these prove the IMPORT layer (the upload gate has its own tests).
 */

const TENANT = 'tenant-1';

const PRODUCTS = [
  { id: 'p-aqua', sku: 'AQUAFINA-500ML', name: 'Aquafina 500ml' },
  { id: 'p-cola', sku: 'COCA-COLA-330ML', name: 'Coca-Cola 330ml' },
];

function pngBytes(seed: number): Buffer {
  // Distinct bytes per seed; content is irrelevant (decode gate is mocked).
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, seed, seed + 1, seed + 2]);
}

function buildZip(
  entries: { path: string; data: Buffer }[],
): Buffer {
  const zip = new AdmZip();
  for (const entry of entries) {
    zip.addFile(entry.path, entry.data);
  }
  return zip.toBuffer();
}

function buildService(options: {
  existingCounts?: Record<string, number>;
  storedChecksums?: { productId: string; checksumSha256: string }[];
  uploadFails?: boolean;
} = {}) {
  const uploaded: { productId: string; originalname: string }[] = [];
  const prisma = {
    product: {
      findMany: jest.fn(async ({ where }: { where: { sku: { in: string[] } } }) =>
        PRODUCTS.filter((product) => where.sku.in.includes(product.sku)),
      ),
    },
    productReferenceImage: {
      groupBy: jest.fn(async () =>
        Object.entries(options.existingCounts ?? {}).map(([productId, count]) => ({
          productId,
          _count: { _all: count },
        })),
      ),
      findMany: jest.fn(async () => options.storedChecksums ?? []),
      count: jest.fn(
        async ({ where }: { where: { productId: string } }) =>
          (options.existingCounts?.[where.productId] ?? 0) +
          uploaded.filter((u) => u.productId === where.productId).length,
      ),
    },
  };
  const referenceImages = {
    upload: jest.fn(
      async (
        _tenantId: string,
        productId: string,
        file: { originalname: string },
      ) => {
        if (options.uploadFails) {
          throw new BadRequestException('undecodable');
        }
        uploaded.push({ productId, originalname: file.originalname });
        return { id: `img-${uploaded.length}` };
      },
    ),
  };
  const service = new ReferenceImportService(
    prisma as never,
    referenceImages as never,
  );
  return { service, prisma, referenceImages, uploaded };
}

describe('ReferenceImportService.preview', () => {
  it('classifies matched, unknown, duplicate, and invalid entries', async () => {
    const duplicate = pngBytes(1);
    const zip = buildZip([
      { path: 'AQUAFINA-500ML/front.png', data: pngBytes(1) },
      { path: 'AQUAFINA-500ML/back.jpg', data: pngBytes(2) },
      { path: 'AQUAFINA-500ML/front-copy.png', data: duplicate }, // dup of front
      { path: 'aquafina-500ml/side.webp', data: pngBytes(3) }, // case-normalized
      { path: 'MYSTERY-SKU/a.png', data: pngBytes(4) },
      { path: 'AQUAFINA-500ML/manual.pdf', data: pngBytes(5) },
      { path: 'AQUAFINA-500ML/deep/nested.png', data: pngBytes(6) },
    ]);
    const { service } = buildService();
    const preview = await service.preview(TENANT, zip);

    const aqua = preview.matched.find((m) => m.sku === 'AQUAFINA-500ML')!;
    expect(aqua.newImages).toBe(3); // front, back, side (case-folded)
    expect(aqua.duplicatesInZip).toBe(1);
    expect(aqua.projectedImages).toBe(3);
    expect(aqua.projectedInferenceReady).toBe(false);
    expect(aqua.belowMinimumAfterImport).toBe(true);

    expect(preview.unknownSkus).toEqual([{ sku: 'MYSTERY-SKU', fileCount: 1 }]);
    expect(
      preview.rejected.some(
        (r) => r.path === 'AQUAFINA-500ML/manual.pdf' && r.reason === 'INVALID_FORMAT',
      ),
    ).toBe(true);
    expect(
      preview.rejected.some(
        (r) =>
          r.path === 'AQUAFINA-500ML/deep/nested.png' &&
          r.reason === 'NESTED_PATH',
      ),
    ).toBe(true);
  });

  it('reports already-stored checksums as duplicates without re-importing', async () => {
    const bytes = pngBytes(9);
    const checksum = createHash('sha256').update(bytes).digest('hex');
    const zip = buildZip([{ path: 'AQUAFINA-500ML/front.png', data: bytes }]);
    const { service } = buildService({
      storedChecksums: [{ productId: 'p-aqua', checksumSha256: checksum }],
    });
    const preview = await service.preview(TENANT, zip);
    expect(preview.matched[0].alreadyStored).toBe(1);
    expect(preview.matched[0].newImages).toBe(0);
  });

  it('projects inference-ready when existing + new crosses five', async () => {
    const zip = buildZip([
      { path: 'COCA-COLA-330ML/a.png', data: pngBytes(1) },
      { path: 'COCA-COLA-330ML/b.png', data: pngBytes(2) },
    ]);
    const { service } = buildService({ existingCounts: { 'p-cola': 3 } });
    const preview = await service.preview(TENANT, zip);
    const cola = preview.matched.find((m) => m.sku === 'COCA-COLA-330ML')!;
    expect(cola.projectedImages).toBe(5);
    expect(cola.projectedInferenceReady).toBe(true);
  });

  it('rejects unsafe traversal paths and refuses non-zip uploads', async () => {
    // adm-zip sanitizes '..' on ADD, so a hostile archive is emulated by
    // byte-patching the stored entry name (same length: 'escape/' →
    // 'a/../b/') — exactly what a crafted zip from another tool contains.
    const benign = buildZip([
      { path: 'escape/evil.png', data: pngBytes(1) },
      { path: 'AQUAFINA-500ML/ok.png', data: pngBytes(2) },
    ]);
    const hostile = Buffer.from(
      benign.toString('latin1').split('escape/').join('a/../b/'),
      'latin1',
    );
    const { service } = buildService();
    const preview = await service.preview(TENANT, hostile);
    expect(
      preview.rejected.some((r) => r.reason === 'UNSAFE_PATH'),
    ).toBe(true);
    await expect(
      service.preview(TENANT, Buffer.from('not a zip at all')),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('ReferenceImportService.commit', () => {
  it('imports through the single-upload gate and reports per product', async () => {
    const zip = buildZip([
      { path: 'AQUAFINA-500ML/1.png', data: pngBytes(1) },
      { path: 'AQUAFINA-500ML/2.jpg', data: pngBytes(2) },
      { path: 'COCA-COLA-330ML/1.webp', data: pngBytes(3) },
      { path: 'MYSTERY-SKU/x.png', data: pngBytes(4) },
    ]);
    const { service, referenceImages, prisma } = buildService({
      existingCounts: { 'p-aqua': 4 },
    });
    const report = await service.commit(TENANT, zip, 'user-1');

    expect(report.productsImported).toBe(2);
    expect(report.imagesAccepted).toBe(3);
    expect(
      report.rejections.some(
        (r) => r.path === 'MYSTERY-SKU/x.png' && r.reason === 'UNKNOWN_SKU',
      ),
    ).toBe(true);
    // The zip path travels as import metadata into the managed upload.
    expect(referenceImages.upload).toHaveBeenCalledWith(
      TENANT,
      'p-aqua',
      expect.objectContaining({ originalname: 'AQUAFINA-500ML/1.png' }),
      'user-1',
    );
    // NEVER creates catalog products — only reads them.
    expect(prisma.product.findMany).toHaveBeenCalled();
    expect((prisma.product as Record<string, unknown>).create).toBeUndefined();
    // 4 existing + 2 accepted = 6 → newly inference-ready.
    expect(report.productsNowInferenceReady).toEqual([
      expect.objectContaining({ sku: 'AQUAFINA-500ML', images: 6 }),
    ]);
  });

  it('records per-file gate refusals as UNDECODABLE without failing the batch', async () => {
    const zip = buildZip([
      { path: 'AQUAFINA-500ML/bad.png', data: pngBytes(1) },
    ]);
    const { service } = buildService({ uploadFails: true });
    const report = await service.commit(TENANT, zip);
    expect(report.imagesAccepted).toBe(0);
    expect(report.rejections).toEqual([
      { path: 'AQUAFINA-500ML/bad.png', reason: 'UNDECODABLE' },
    ]);
  });
});
