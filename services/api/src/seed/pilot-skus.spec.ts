import { createHash } from 'crypto';
import {
  PILOT_REFERENCES_PER_SKU,
  PILOT_SKUS,
  renderPilotReferencePng,
  seedPilotSkus,
  shouldSeedPilotSkus,
} from './pilot-skus';

describe('shouldSeedPilotSkus (explicit opt-in gate)', () => {
  it('is OFF by default and for any value other than the literal true', () => {
    expect(shouldSeedPilotSkus({})).toMatchObject({ seed: false });
    expect(shouldSeedPilotSkus({ SEED_PILOT_SKUS: '1' })).toMatchObject({
      seed: false,
    });
    expect(shouldSeedPilotSkus({ SEED_PILOT_SKUS: 'TRUE' })).toMatchObject({
      seed: false,
    });
  });

  it("opts in only on the literal 'true'", () => {
    expect(shouldSeedPilotSkus({ SEED_PILOT_SKUS: 'true' })).toEqual({
      seed: true,
    });
  });
});

describe('renderPilotReferencePng (synthetic, deterministic)', () => {
  const sha = (buffer: Buffer) =>
    createHash('sha256').update(buffer).digest('hex');

  it('is byte-deterministic across runs (checksum dedup relies on it)', () => {
    const first = renderPilotReferencePng(2, 3, PILOT_SKUS[2]);
    const second = renderPilotReferencePng(2, 3, PILOT_SKUS[2]);
    expect(sha(first)).toBe(sha(second));
  });

  it('variants of one SKU and different SKUs all render distinct bytes', () => {
    const hashes = new Set<string>();
    for (const [index, definition] of PILOT_SKUS.entries()) {
      for (let variant = 0; variant < PILOT_REFERENCES_PER_SKU; variant += 1) {
        hashes.add(sha(renderPilotReferencePng(index, variant, definition)));
      }
    }
    expect(hashes.size).toBe(PILOT_SKUS.length * PILOT_REFERENCES_PER_SKU);
  });

  it('renders a valid PNG signature', () => {
    const png = renderPilotReferencePng(0, 0, PILOT_SKUS[0]);
    expect(png.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });
});

function buildStub(sandbox: { id: string } | null) {
  const upserts: unknown[] = [];
  const uploads: { productId: string; checksum: string }[] = [];
  const db = {
    tenant: { findFirst: jest.fn(async () => sandbox) },
    product: {
      upsert: jest.fn(
        async (args: {
          where: { tenantId_sku: { sku: string } };
          update: Record<string, never>;
        }) => {
          upserts.push(args);
          return { id: `p-${args.where.tenantId_sku.sku}`, sku: args.where.tenantId_sku.sku };
        },
      ),
    },
  };
  const uploader = {
    upload: jest.fn(
      async (
        _tenantId: string,
        productId: string,
        file: { buffer: Buffer },
      ) => {
        uploads.push({
          productId,
          checksum: createHash('sha256').update(file.buffer).digest('hex'),
        });
        return {};
      },
    ),
  };
  return { db, uploader, upserts, uploads };
}

describe('seedPilotSkus', () => {
  it('REFUSES without the verified platform-sandbox tenant', async () => {
    const { db, uploader } = buildStub(null);
    await expect(seedPilotSkus(db, uploader)).rejects.toThrow(
      /VERIFIED platform-sandbox/,
    );
    expect(db.product.upsert).not.toHaveBeenCalled();
    expect(uploader.upload).not.toHaveBeenCalled();
  });

  it('resolves the sandbox by the verified marker, never the slug alone', async () => {
    const { db, uploader } = buildStub({ id: 't-sandbox' });
    await seedPilotSkus(db, uploader);
    expect(db.tenant.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ isPlatformSandbox: true }),
      }),
    );
  });

  it('upserts every pilot SKU non-destructively and uploads the full reference set', async () => {
    const { db, uploader, upserts, uploads } = buildStub({ id: 't-sandbox' });
    const result = await seedPilotSkus(db, uploader);
    expect(result.products).toBe(PILOT_SKUS.length);
    expect(upserts).toHaveLength(PILOT_SKUS.length);
    // update: {} — a reseed never rewrites operator catalog state.
    for (const args of upserts as { update: Record<string, never> }[]) {
      expect(args.update).toEqual({});
    }
    expect(uploads).toHaveLength(
      PILOT_SKUS.length * PILOT_REFERENCES_PER_SKU,
    );
  });

  it('a second run produces byte-identical uploads (dedup replays, nothing new)', async () => {
    const first = buildStub({ id: 't-sandbox' });
    await seedPilotSkus(first.db, first.uploader);
    const second = buildStub({ id: 't-sandbox' });
    await seedPilotSkus(second.db, second.uploader);
    expect(second.uploads.map((u) => u.checksum)).toEqual(
      first.uploads.map((u) => u.checksum),
    );
  });
});
