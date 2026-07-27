import { VideoArtifactType, VideoAssetStatus } from '@prisma/client';
import { VideoAssetsRepository } from './video-assets.repository';

/**
 * Pins the two repository behaviors Codex review called out:
 * 1. upload context must form ONE consistent hierarchy (same rules and
 *    rejection vocabulary as PrismaInferenceQueue.enqueue), checked inside
 *    the create transaction;
 * 2. an extraction batch publishes atomically — artifact rows, artifact
 *    audits, and the READY flip in one transaction, none of it when the
 *    status CAS loses.
 * The Prisma client is stubbed; $transaction runs the callback with a tx
 * stub so the assertions cover the REAL repository logic.
 */

const TENANT = 'tenant-1';

interface TxStub {
  location: { findFirst: jest.Mock };
  retailUnit: { findFirst: jest.Mock };
  device: { findFirst: jest.Mock };
  checkoutSession: { findFirst: jest.Mock };
  videoAsset: {
    create: jest.Mock;
    findFirst: jest.Mock;
    findFirstOrThrow: jest.Mock;
    updateMany: jest.Mock;
  };
  videoArtifact: { create: jest.Mock; findFirst: jest.Mock; findFirstOrThrow: jest.Mock; updateMany: jest.Mock };
}

function makeTx(overrides: Partial<Record<string, unknown>> = {}): TxStub {
  return {
    location: { findFirst: jest.fn(async () => ({ id: 'loc-1' })) },
    retailUnit: {
      findFirst: jest.fn(async () => ({ id: 'unit-1', locationId: 'loc-1' })),
    },
    device: {
      findFirst: jest.fn(async () => ({ id: 'device-1', unitId: 'unit-1' })),
    },
    checkoutSession: {
      findFirst: jest.fn(async () => ({
        id: 'session-1',
        unitId: 'unit-1',
        locationId: 'loc-1',
      })),
    },
    videoAsset: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'asset-1',
        ...data,
      })),
      findFirst: jest.fn(async () => ({
        id: 'asset-1',
        status: VideoAssetStatus.VALIDATED,
      })),
      findFirstOrThrow: jest.fn(async () => ({
        id: 'asset-1',
        status: VideoAssetStatus.READY,
      })),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    videoArtifact: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'artifact-1',
        ...data,
      })),
      findFirst: jest.fn(async () => null),
      findFirstOrThrow: jest.fn(async () => null),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    ...(overrides as object),
  } as TxStub;
}

function makeRepository(tx: TxStub) {
  const prisma = {
    $transaction: jest.fn(async (fn: (t: TxStub) => Promise<unknown>) => fn(tx)),
  };
  const auditLog = { record: jest.fn(async () => undefined) };
  const repository = new VideoAssetsRepository(
    prisma as never,
    auditLog as never,
  );
  return { repository, auditLog };
}

const baseAssetData = {
  originalFilename: 'clip.mp4',
  mimeType: 'video/mp4',
  sizeBytes: 100,
  storageKey: 'tenant-1/u/original.mp4',
  checksumSha256: 'abc',
};

describe('VideoAssetsRepository.createAsset hierarchy validation', () => {
  it('rejects a unit that belongs to a different store', async () => {
    const tx = makeTx();
    tx.retailUnit.findFirst.mockResolvedValue({
      id: 'unit-1',
      locationId: 'other-store',
    });
    const { repository, auditLog } = makeRepository(tx);
    const result = await repository.createAsset(
      TENANT,
      { ...baseAssetData, locationId: 'loc-1', unitId: 'unit-1' },
      () => ({ tenantId: TENANT, actorEmail: 'x', action: 'CREATE' }) as never,
    );
    expect(result).toBe('unit-location-mismatch');
    expect(tx.videoAsset.create).not.toHaveBeenCalled();
    expect(auditLog.record).not.toHaveBeenCalled();
  });

  it('rejects a device attached to a different unit', async () => {
    const tx = makeTx();
    tx.device.findFirst.mockResolvedValue({
      id: 'device-1',
      unitId: 'other-unit',
    });
    const { repository } = makeRepository(tx);
    const result = await repository.createAsset(
      TENANT,
      { ...baseAssetData, unitId: 'unit-1', deviceId: 'device-1' },
      () => ({ tenantId: TENANT, actorEmail: 'x', action: 'CREATE' }) as never,
    );
    expect(result).toBe('device-unit-mismatch');
  });

  it('rejects a session whose store differs from the unit-derived store', async () => {
    const tx = makeTx();
    tx.checkoutSession.findFirst.mockResolvedValue({
      id: 'session-1',
      unitId: 'unit-1',
      locationId: 'other-store',
    });
    const { repository } = makeRepository(tx);
    // No explicit locationId: the EFFECTIVE store comes from the unit,
    // exactly like PrismaInferenceQueue.enqueue().
    const result = await repository.createAsset(
      TENANT,
      { ...baseAssetData, unitId: 'unit-1', sessionId: 'session-1' },
      () => ({ tenantId: TENANT, actorEmail: 'x', action: 'CREATE' }) as never,
    );
    expect(result).toBe('session-location-mismatch');
  });

  it('rejects missing references with the enqueue vocabulary', async () => {
    const tx = makeTx();
    tx.location.findFirst.mockResolvedValue(null);
    const { repository } = makeRepository(tx);
    const result = await repository.createAsset(
      TENANT,
      { ...baseAssetData, locationId: 'nope' },
      () => ({ tenantId: TENANT, actorEmail: 'x', action: 'CREATE' }) as never,
    );
    expect(result).toBe('location-not-found');
  });

  it('creates the row and audits when the hierarchy is consistent', async () => {
    const tx = makeTx();
    const { repository, auditLog } = makeRepository(tx);
    const result = await repository.createAsset(
      TENANT,
      {
        ...baseAssetData,
        locationId: 'loc-1',
        unitId: 'unit-1',
        deviceId: 'device-1',
        sessionId: 'session-1',
      },
      () => ({ tenantId: TENANT, actorEmail: 'x', action: 'CREATE' }) as never,
    );
    expect(typeof result).not.toBe('string');
    expect(tx.videoAsset.create).toHaveBeenCalledTimes(1);
    expect(auditLog.record).toHaveBeenCalledTimes(1);
  });
});

describe('VideoAssetsRepository.createArtifactsBatch', () => {
  const items = [
    {
      artifactType: VideoArtifactType.FRAME,
      timestampMs: 0,
      width: 100,
      height: 100,
      mimeType: 'image/png',
      sizeBytes: 10,
      checksumSha256: 'abc',
      storageKey: 'tenant-1/u/artifacts/a.png',
    },
    {
      artifactType: VideoArtifactType.FRAME,
      timestampMs: 1000,
      width: 100,
      height: 100,
      mimeType: 'image/png',
      sizeBytes: 10,
      checksumSha256: 'def',
      storageKey: 'tenant-1/u/artifacts/b.png',
    },
  ];

  it('returns null (nothing committed) when the status CAS loses', async () => {
    const tx = makeTx();
    tx.videoAsset.findFirst.mockResolvedValue({
      id: 'asset-1',
      status: VideoAssetStatus.UPLOADED, // not in the expected set
    });
    const { repository, auditLog } = makeRepository(tx);
    const result = await repository.createArtifactsBatch(
      TENANT,
      'asset-1',
      [VideoAssetStatus.VALIDATED, VideoAssetStatus.READY],
      items,
      () => ({ tenantId: TENANT, actorEmail: 'x', action: 'CREATE' }) as never,
      () => ({ tenantId: TENANT, actorEmail: 'x', action: 'UPDATE' }) as never,
    );
    expect(result).toBeNull();
    expect(tx.videoArtifact.create).not.toHaveBeenCalled();
    expect(auditLog.record).not.toHaveBeenCalled();
  });

  it('publishes every row, every artifact audit, and the READY flip together', async () => {
    const tx = makeTx();
    const { repository, auditLog } = makeRepository(tx);
    const result = await repository.createArtifactsBatch(
      TENANT,
      'asset-1',
      [VideoAssetStatus.VALIDATED],
      items,
      () => ({ tenantId: TENANT, actorEmail: 'x', action: 'CREATE' }) as never,
      () => ({ tenantId: TENANT, actorEmail: 'x', action: 'UPDATE' }) as never,
    );
    expect(result).not.toBeNull();
    expect(result?.artifacts).toHaveLength(2);
    expect(tx.videoArtifact.create).toHaveBeenCalledTimes(2);
    // Two artifact audits + one asset transition audit, all inside the tx.
    expect(auditLog.record).toHaveBeenCalledTimes(3);
    // The flip clears the error columns (status/error CHECK coherence).
    const [{ data }] = tx.videoAsset.updateMany.mock.calls[0] as [
      { data: { status: VideoAssetStatus; errorCode: null } },
    ];
    expect(data.status).toBe(VideoAssetStatus.READY);
    expect(data.errorCode).toBeNull();
  });
});
