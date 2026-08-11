import { BadRequestException } from '@nestjs/common';
import { GroundTruthEventKind } from '@prisma/client';
import { PickupValidationService } from './pickup-validation.service';
import {
  fusionPredictedSku,
  shadowVerdict,
} from '../pickup-fusion/pickup-fusion.service';

/**
 * Ground-truth save contract (unresponsive-button phase): validation
 * failures are controlled 400s, saves upsert (create OR update, never a
 * second row per video — pinned by the upsert call shape on top of the DB
 * `videoAssetId @unique`), and the shadow verdicts derive from CURRENT
 * truth.
 */

const TENANT = 'tenant-1';
const ASSET = 'asset-1';

function buildService(overrides: {
  asset?: { id: string; durationMs: number | null } | null;
  product?: { id: string } | null;
  existing?: Record<string, unknown> | null;
} = {}) {
  const upsert = jest.fn(async (_args: unknown) => ({}));
  const truthRow = {
    videoAssetId: ASSET,
    eventKind: GroundTruthEventKind.PICKUP,
    productId: 'prod-1',
    actualTimestampMs: 1600,
    quantity: 1,
    note: null,
    updatedAt: new Date(),
    product: { sku: 'WATER-BOTTLE-500ML', name: 'Water Bottle' },
  };
  const prisma = {
    videoAsset: {
      findFirst: jest.fn(async () =>
        overrides.asset === null
          ? null
          : overrides.asset ?? { id: ASSET, durationMs: 5987 },
      ),
    },
    product: {
      findFirst: jest.fn(async () =>
        overrides.product === null ? null : overrides.product ?? { id: 'prod-1' },
      ),
    },
    videoGroundTruth: {
      upsert,
      findFirst: jest.fn(async () => overrides.existing ?? truthRow),
    },
  };
  return { service: new PickupValidationService(prisma as never), prisma, upsert };
}

describe('upsertGroundTruth', () => {
  const valid = {
    eventKind: GroundTruthEventKind.PICKUP,
    productId: 'prod-1',
    actualTimestampMs: 1600,
    quantity: 1,
  };

  it('saves via UPSERT keyed on the video — update and create share one row', async () => {
    const { service, upsert } = buildService();
    await service.upsertGroundTruth(TENANT, ASSET, valid, 'user-1');
    expect(upsert).toHaveBeenCalledTimes(1);
    const args = upsert.mock.calls[0][0] as unknown as {
      where: { videoAssetId: string };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    // Duplicate prevention: the WHERE is the unique per-video key, and the
    // update branch carries the same data as create — a second save can
    // only modify the existing record.
    expect(args.where).toEqual({ videoAssetId: ASSET });
    expect(args.create).toMatchObject({ tenantId: TENANT, videoAssetId: ASSET, productId: 'prod-1', actualTimestampMs: 1600 });
    expect(args.update).toMatchObject({ productId: 'prod-1', actualTimestampMs: 1600, quantity: 1 });
  });

  it('rejects a PICKUP without a product (400, no write)', async () => {
    const { service, upsert } = buildService();
    await expect(
      service.upsertGroundTruth(TENANT, ASSET, { ...valid, productId: null }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('rejects an unknown product id (400, no write)', async () => {
    const { service, upsert } = buildService({ product: null });
    await expect(
      service.upsertGroundTruth(TENANT, ASSET, valid),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('rejects timestamps outside the clip and non-integers (400, no write)', async () => {
    const { service, upsert } = buildService();
    for (const actualTimestampMs of [null, -1, 2.5, 9000]) {
      await expect(
        service.upsertGroundTruth(TENANT, ASSET, {
          ...valid,
          actualTimestampMs: actualTimestampMs as number | null,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(upsert).not.toHaveBeenCalled();
  });

  it('rejects a non-positive quantity (400, no write)', async () => {
    const { service, upsert } = buildService();
    await expect(
      service.upsertGroundTruth(TENANT, ASSET, { ...valid, quantity: 0 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('NONE clears the product/timestamp on the stored row', async () => {
    const { service, upsert } = buildService();
    await service.upsertGroundTruth(TENANT, ASSET, {
      eventKind: GroundTruthEventKind.NONE,
    });
    const args = upsert.mock.calls[0][0] as unknown as { update: Record<string, unknown> };
    expect(args.update).toMatchObject({ productId: null, actualTimestampMs: null });
  });
});

describe('shadow verdict derivation (read-time recompute)', () => {
  const truth = { eventKind: 'PICKUP', sku: 'WATER-BOTTLE-500ML' };

  it('is null without ground truth and flips to correct/incorrect/missed with it', () => {
    expect(shadowVerdict('WATER-BOTTLE-500ML', null)).toBeNull();
    expect(shadowVerdict('WATER-BOTTLE-500ML', truth)).toBe('correct');
    expect(shadowVerdict('SKU-COLA-RED', truth)).toBe('incorrect');
    expect(shadowVerdict(null, truth)).toBe('missed');
    expect(shadowVerdict(null, { eventKind: 'NONE', sku: null })).toBe('true_negative');
    expect(shadowVerdict('X', { eventKind: 'NONE', sku: null })).toBe('false_pickup');
  });

  it("fusion's best answer is the VLM's MATCHED SKU, else the top fused candidate", () => {
    expect(
      fusionPredictedSku({
        vlm: { status: 'VERDICT', verdict: 'MATCH', selectedSku: 'SKU-A' },
        fused: [{ sku: 'SKU-B' }],
      }),
    ).toBe('SKU-A');
    // Non-MATCH verdicts fall back to fusion's top candidate.
    expect(
      fusionPredictedSku({
        vlm: { status: 'VERDICT', verdict: 'AMBIGUOUS', selectedSku: null },
        fused: [{ sku: 'SKU-B' }],
      }),
    ).toBe('SKU-B');
    expect(
      fusionPredictedSku({
        vlm: { status: 'UNAVAILABLE', verdict: null, selectedSku: null },
        fused: [{ sku: 'SKU-B' }],
      }),
    ).toBe('SKU-B');
    // LEGACY rows (pre-strict schema, recorded `choice`) still recompute.
    expect(
      fusionPredictedSku({
        vlm: { status: 'VERDICT', choice: 'SKU-A' },
        fused: [{ sku: 'SKU-B' }],
      }),
    ).toBe('SKU-A');
    expect(
      fusionPredictedSku({ vlm: { status: null }, fused: [] }),
    ).toBeNull();
  });
});
