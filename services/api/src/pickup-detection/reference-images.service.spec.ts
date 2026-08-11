import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ReferenceImagesService } from './reference-images.service';

/**
 * Upload-gate contract tests for the reference library's payment-data
 * screens (AGENTS.md payments invariant). The pixel OCR screen alone is
 * blind to two channels a decodable image can carry: sensitive TEXT BYTES
 * inside the file (EXIF/comments, or bytes appended after the image
 * terminator) and a sensitive ORIGINAL FILENAME persisted as metadata —
 * both must reject BEFORE anything reaches storage, with the same
 * raw-buffer/filename detectors the video-ingest upload gate uses.
 */

const TENANT = 'tenant-1';
const PRODUCT_ID = 'p-aqua';

/** Decodable-enough PNG-ish bytes; the decode gate itself is mocked. */
function cleanPngBytes(): Buffer {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
}

function buildService() {
  const prisma = {
    product: {
      findFirst: jest.fn(async () => ({
        id: PRODUCT_ID,
        sku: 'AQUAFINA-500ML',
        name: 'Aquafina 500ml',
        barcodes: [],
      })),
    },
    productReferenceImage: {
      findFirst: jest.fn(async () => null),
      create: jest.fn(
        async ({ data }: { data: Record<string, unknown> }) => ({
          id: 'img-1',
          productId: data.productId,
          originalFilename: data.originalFilename,
          mimeType: data.mimeType,
          sizeBytes: data.sizeBytes,
          checksumSha256: data.checksumSha256,
          createdAt: new Date(),
        }),
      ),
    },
  };
  const storage = {
    put: jest.fn(async () => undefined),
    delete: jest.fn(async () => undefined),
    read: jest.fn(async () => Buffer.alloc(0)),
    internalPathFor: jest.fn(() => '/internal/path'),
  };
  const decoder = {
    decodeReferenceImage: jest.fn(async () => ({ width: 4, height: 4 })),
  };
  const recognizer = {
    readsRealPixels: true,
    checkToolingReady: jest.fn(async () => true),
    recognize: jest.fn(async () => 'aquafina water bottle'),
  };
  const service = new ReferenceImagesService(
    prisma as never,
    storage as never,
    decoder as never,
    recognizer as never,
  );
  return { service, prisma, storage, recognizer };
}

describe('ReferenceImagesService.upload payment-data screens', () => {
  it('stores a clean upload (ZIP-path-shaped originalname included)', async () => {
    const { service, storage, prisma } = buildService();
    const view = await service.upload(TENANT, PRODUCT_ID, {
      buffer: cleanPngBytes(),
      mimetype: 'image/png',
      originalname: 'AQUAFINA-500ML/front.png',
    });
    expect(view.id).toBe('img-1');
    expect(storage.put).toHaveBeenCalledTimes(1);
    expect(prisma.productReferenceImage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ originalFilename: 'front.png' }),
      }),
    );
  });

  it('rejects a decodable image carrying sensitive text appended after the terminator', async () => {
    const { service, storage, prisma, recognizer } = buildService();
    // Valid image prefix, PAN smuggled in trailing bytes the OCR never
    // renders — exactly the channel the raw-buffer screen exists for.
    const buffer = Buffer.concat([
      cleanPngBytes(),
      Buffer.from('4111111111111111'),
    ]);
    await expect(
      service.upload(TENANT, PRODUCT_ID, {
        buffer,
        mimetype: 'image/png',
        originalname: 'front.png',
      }),
    ).rejects.toThrow('carries credential- or payment-bearing text');
    // Fail-closed BEFORE anything durable — and before the OCR pass.
    expect(storage.put).not.toHaveBeenCalled();
    expect(prisma.productReferenceImage.create).not.toHaveBeenCalled();
    expect(recognizer.recognize).not.toHaveBeenCalled();
  });

  it('rejects EXIF-style credential text embedded inside the image bytes', async () => {
    const { service, storage } = buildService();
    // A comment/EXIF text atom is just bytes inside the file body.
    const buffer = Buffer.concat([
      cleanPngBytes(),
      Buffer.from('UserComment: password hunter2'),
      cleanPngBytes(),
    ]);
    await expect(
      service.upload(TENANT, PRODUCT_ID, {
        buffer,
        mimetype: 'image/jpeg',
        originalname: 'front.jpg',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(storage.put).not.toHaveBeenCalled();
  });

  it.each(['4111_1111_1111_1111.png', 'cvv123.png', 'password_hunter2.png'])(
    'rejects the sensitive filename %s before anything is stored',
    async (originalname) => {
      const { service, storage, prisma } = buildService();
      await expect(
        service.upload(TENANT, PRODUCT_ID, {
          buffer: cleanPngBytes(),
          mimetype: 'image/png',
          originalname,
        }),
      ).rejects.toThrow(
        'Filename must not contain credential- or payment-bearing content',
      );
      expect(storage.put).not.toHaveBeenCalled();
      expect(prisma.productReferenceImage.create).not.toHaveBeenCalled();
    },
  );
});

describe('ReferenceImagesService.upload insert-failure cleanup', () => {
  function cleanUpload() {
    return {
      buffer: cleanPngBytes(),
      mimetype: 'image/png' as const,
      originalname: 'front.png',
    };
  }

  it('deletes the just-stored bytes and rethrows on a non-P2002 insert failure', async () => {
    const { service, storage, prisma } = buildService();
    const outage = new Error('database connection lost');
    prisma.productReferenceImage.create.mockRejectedValueOnce(outage);
    await expect(
      service.upload(TENANT, PRODUCT_ID, cleanUpload()),
    ).rejects.toBe(outage);
    // The file written before the insert must not survive the failure.
    expect(storage.delete).toHaveBeenCalledTimes(1);
    const [deletedKey] = storage.delete.mock.calls[0] as unknown as [string];
    const [putKey] = storage.put.mock.calls[0] as unknown as [string, Buffer];
    expect(deletedKey).toBe(putKey);
  });

  it('a failing cleanup delete never masks the original insert error', async () => {
    const { service, storage, prisma } = buildService();
    const outage = new Error('foreign key constraint violated');
    prisma.productReferenceImage.create.mockRejectedValueOnce(outage);
    storage.delete.mockRejectedValueOnce(new Error('disk gone too'));
    await expect(
      service.upload(TENANT, PRODUCT_ID, cleanUpload()),
    ).rejects.toBe(outage);
    expect(storage.delete).toHaveBeenCalledTimes(1);
  });

  it('P2002 still deletes the losing bytes and replays the winning row', async () => {
    const { service, storage, prisma } = buildService();
    const collision = new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed',
      { code: 'P2002', clientVersion: 'test' },
    );
    prisma.productReferenceImage.create.mockRejectedValueOnce(collision);
    const winner = {
      id: 'img-winner',
      productId: PRODUCT_ID,
      originalFilename: 'front.png',
      mimeType: 'image/png',
      sizeBytes: cleanPngBytes().length,
      checksumSha256: 'abc',
      createdAt: new Date(),
    };
    // First findFirst is the preliminary duplicate probe (miss); the
    // second is the post-collision replay lookup (hit).
    prisma.productReferenceImage.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(winner as never);
    await expect(
      service.upload(TENANT, PRODUCT_ID, cleanUpload()),
    ).resolves.toEqual(winner);
    expect(storage.delete).toHaveBeenCalledTimes(1);
  });
});
