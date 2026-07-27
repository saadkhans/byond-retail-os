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
  $queryRaw: jest.Mock;
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
  videoArtifact: {
    create: jest.Mock;
    findFirst: jest.Mock;
    findFirstOrThrow: jest.Mock;
    findMany: jest.Mock;
    updateMany: jest.Mock;
  };
  videoExtractionRequest: { findFirst: jest.Mock; create: jest.Mock };
}

function makeTx(overrides: Partial<Record<string, unknown>> = {}): TxStub {
  return {
    $queryRaw: jest.fn(async () => []),
    location: { findFirst: jest.fn(async () => ({ id: 'loc-1' })) },
    retailUnit: {
      findFirst: jest.fn(async () => ({ id: 'unit-1', locationId: 'loc-1' })),
    },
    device: {
      findFirst: jest.fn(async () => ({
        id: 'device-1',
        unitId: 'unit-1',
        unit: { locationId: 'loc-1' },
      })),
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
      findMany: jest.fn(async () => []),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    videoExtractionRequest: {
      findFirst: jest.fn(async () => null),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'req-1',
        ...data,
      })),
    },
    ...(overrides as object),
  } as TxStub;
}

function makeRepository(tx: TxStub) {
  const prisma = {
    $transaction: jest.fn(async (fn: (t: TxStub) => Promise<unknown>) => fn(tx)),
    // Non-transactional reads — capture the where clauses for scoping tests.
    videoArtifact: {
      findFirst: jest.fn(async () => null),
      findMany: jest.fn(async () => []),
    },
    videoAsset: { findFirst: jest.fn(async () => null) },
    videoExtractionRequest: { findFirst: jest.fn(async () => null) },
  };
  const auditLog = { record: jest.fn(async () => undefined) };
  const repository = new VideoAssetsRepository(
    prisma as never,
    auditLog as never,
  );
  return { repository, auditLog, prisma };
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

  it('rejects a device whose UNIT-DERIVED store mismatches when unitId is omitted', async () => {
    // locationId = store-A, device attached to a unit in store-B, NO unitId
    // in the request: the omitted intermediate must not launder the
    // mismatch.
    const tx = makeTx();
    tx.device.findFirst.mockResolvedValue({
      id: 'device-1',
      unitId: 'unit-9',
      unit: { locationId: 'store-B' },
    });
    const { repository } = makeRepository(tx);
    const result = await repository.createAsset(
      TENANT,
      { ...baseAssetData, locationId: 'loc-1', deviceId: 'device-1' },
      () => ({ tenantId: TENANT, actorEmail: 'x', action: 'CREATE' }) as never,
    );
    expect(result).toBe('device-location-mismatch');
  });

  it('rejects a session on a different unit than the DEVICE-DERIVED unit', async () => {
    const tx = makeTx();
    tx.checkoutSession.findFirst.mockResolvedValue({
      id: 'session-1',
      unitId: 'other-unit',
      locationId: 'loc-1',
    });
    const { repository } = makeRepository(tx);
    // No unitId — the effective unit derives from the device.
    const result = await repository.createAsset(
      TENANT,
      { ...baseAssetData, deviceId: 'device-1', sessionId: 'session-1' },
      () => ({ tenantId: TENANT, actorEmail: 'x', action: 'CREATE' }) as never,
    );
    expect(result).toBe('session-unit-mismatch');
  });

  it('serializes with unit/device mutations via the shared advisory locks', async () => {
    const tx = makeTx();
    const { repository } = makeRepository(tx);
    await repository.createAsset(
      TENANT,
      { ...baseAssetData, unitId: 'unit-1', deviceId: 'device-1' },
      () => ({ tenantId: TENANT, actorEmail: 'x', action: 'CREATE' }) as never,
    );
    // Unit lock first, then device lock — same order as enqueue/checkout.
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
    // $queryRaw is a tagged template: interpolated values follow the
    // strings array, so calls[n][1] is the advisory-lock key.
    expect(tx.$queryRaw.mock.calls[0][1]).toBe(`retail-unit:${TENANT}:unit-1`);
    expect(tx.$queryRaw.mock.calls[1][1]).toBe(`device:${TENANT}:device-1`);
  });

  it('PERSISTS the derived unit/store for a device-only upload (locks both)', async () => {
    // Validation deriving the hierarchy but inserting nulls would strand
    // the asset: inference-job → VisionEvent conversion requires store +
    // unit. The derived bindings must land in the row, and the DERIVED
    // unit must be locked (canonical unit-then-device order via the
    // preliminary device read).
    const tx = makeTx();
    const { repository } = makeRepository(tx);
    await repository.createAsset(
      TENANT,
      { ...baseAssetData, deviceId: 'device-1' },
      () => ({ tenantId: TENANT, actorEmail: 'x', action: 'CREATE' }) as never,
    );
    const [{ data }] = tx.videoAsset.create.mock.calls[0] as unknown as [
      { data: { unitId: string; locationId: string } },
    ];
    expect(data.unitId).toBe('unit-1');
    expect(data.locationId).toBe('loc-1');
    // Preliminary device read + locked re-read, plus BOTH advisory locks —
    // DERIVED unit first, then device (canonical order).
    expect(tx.device.findFirst).toHaveBeenCalledTimes(2);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(tx.$queryRaw.mock.calls[0][1]).toBe(`retail-unit:${TENANT}:unit-1`);
    expect(tx.$queryRaw.mock.calls[1][1]).toBe(`device:${TENANT}:device-1`);
  });

  it('locks the DERIVED unit and persists it for a device+store upload without unitId', async () => {
    // Finding 2 flow: deviceId + locationId, no unitId. The device's unit
    // must be advisory-locked BEFORE its locationId is read/compared, so a
    // concurrent UnitsRepository.update() (which moves a unit's store under
    // the same unit lock) cannot re-home the unit between the comparison
    // and the insert — and the derived unitId must land on the row.
    const tx = makeTx();
    const { repository } = makeRepository(tx);
    await repository.createAsset(
      TENANT,
      { ...baseAssetData, locationId: 'loc-1', deviceId: 'device-1' },
      () => ({ tenantId: TENANT, actorEmail: 'x', action: 'CREATE' }) as never,
    );
    // The unit lock precedes the LOCKED device re-read that reads
    // unit.locationId (the preliminary read only learns the unit id).
    expect(tx.$queryRaw.mock.calls[0][1]).toBe(`retail-unit:${TENANT}:unit-1`);
    expect(tx.$queryRaw.mock.calls[1][1]).toBe(`device:${TENANT}:device-1`);
    const [{ data }] = tx.videoAsset.create.mock.calls[0] as unknown as [
      { data: { unitId: string; locationId: string } },
    ];
    expect(data.unitId).toBe('unit-1');
    expect(data.locationId).toBe('loc-1');
  });

  it('rejects a device that moved units between the preliminary read and the locks', async () => {
    const tx = makeTx();
    tx.device.findFirst
      .mockResolvedValueOnce({ unitId: 'unit-1' }) // preliminary
      .mockResolvedValueOnce({
        id: 'device-1',
        unitId: 'unit-MOVED',
        unit: { locationId: 'loc-9' },
      }); // locked re-read
    const { repository } = makeRepository(tx);
    const result = await repository.createAsset(
      TENANT,
      { ...baseAssetData, deviceId: 'device-1' },
      () => ({ tenantId: TENANT, actorEmail: 'x', action: 'CREATE' }) as never,
    );
    expect(result).toBe('device-unit-mismatch');
  });

  it('PERSISTS the session-derived unit/store for a session-only upload', async () => {
    const tx = makeTx();
    const { repository } = makeRepository(tx);
    await repository.createAsset(
      TENANT,
      { ...baseAssetData, sessionId: 'session-1' },
      () => ({ tenantId: TENANT, actorEmail: 'x', action: 'CREATE' }) as never,
    );
    const [{ data }] = tx.videoAsset.create.mock.calls[0] as unknown as [
      { data: { unitId: string; locationId: string } },
    ];
    expect(data.unitId).toBe('unit-1');
    expect(data.locationId).toBe('loc-1');
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

describe('deleted-parent scoping on artifact reads', () => {
  // Regression pins for the Codex fix: after DELETE /video-assets/:id the
  // deletion boundary must apply to the asset's artifacts too — reverting
  // the where-clause scoping fails these.
  it('findArtifactById reads only artifacts of a NON-DELETED asset', async () => {
    const { repository, prisma } = makeRepository(makeTx());
    await repository.findArtifactById(TENANT, 'artifact-1');
    const [{ where }] = prisma.videoArtifact.findFirst.mock
      .calls[0] as unknown as [
      { where: { tenantId: string; videoAsset: { deletedAt: null } } },
    ];
    expect(where.tenantId).toBe(TENANT);
    expect(where.videoAsset).toEqual({ deletedAt: null });
  });

  it('listArtifacts reads only artifacts of a NON-DELETED asset', async () => {
    const { repository, prisma } = makeRepository(makeTx());
    await repository.listArtifacts(TENANT, 'asset-1');
    const [{ where }] = prisma.videoArtifact.findMany.mock
      .calls[0] as unknown as [
      { where: { videoAsset: { deletedAt: null } } },
    ];
    expect(where.videoAsset).toEqual({ deletedAt: null });
  });

  it('linkArtifactToInferenceJob refuses a deleted asset’s crop', async () => {
    const tx = makeTx();
    // The tx read carries the deleted-parent scoping; simulate "not found
    // because parent is deleted".
    tx.videoArtifact.findFirst.mockResolvedValue(null);
    const { repository } = makeRepository(tx);
    const result = await repository.linkArtifactToInferenceJob(
      TENANT,
      'artifact-1',
      'job-1',
      () => ({ tenantId: TENANT, actorEmail: 'x', action: 'UPDATE' }) as never,
    );
    expect(result).toBeNull();
    const [{ where }] = tx.videoArtifact.findFirst.mock
      .calls[0] as unknown as [{ where: { videoAsset: { deletedAt: null } } }];
    expect(where.videoAsset).toEqual({ deletedAt: null });
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
      undefined,
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
      undefined,
      items,
      () => ({ tenantId: TENANT, actorEmail: 'x', action: 'CREATE' }) as never,
      () => ({ tenantId: TENANT, actorEmail: 'x', action: 'UPDATE' }) as never,
    );
    expect(result).not.toBeNull();
    expect(result).not.toBe('key-conflict');
    const batch = result as Exclude<typeof result, 'key-conflict' | null>;
    expect(batch.artifacts).toHaveLength(2);
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

  it('records the extraction request in the SAME transaction as its batch', async () => {
    const tx = makeTx();
    const { repository } = makeRepository(tx);
    const result = await repository.createArtifactsBatch(
      TENANT,
      'asset-1',
      [VideoAssetStatus.VALIDATED],
      'op-key-1',
      items,
      () => ({ tenantId: TENANT, actorEmail: 'x', action: 'CREATE' }) as never,
      () => ({ tenantId: TENANT, actorEmail: 'x', action: 'UPDATE' }) as never,
    );
    const batch = result as Exclude<typeof result, 'key-conflict' | null>;
    expect(batch.replayed).toBe(false);
    const [{ data }] = tx.videoExtractionRequest.create.mock.calls[0] as [
      { data: { idempotencyKey: string; artifactIds: string[] } },
    ];
    expect(data.idempotencyKey).toBe('op-key-1');
    expect(data.artifactIds).toHaveLength(2);
  });

  it('REPLAYS a committed identical request instead of appending a new batch', async () => {
    const tx = makeTx();
    tx.videoExtractionRequest.findFirst.mockResolvedValue({
      id: 'req-1',
      videoAssetId: 'asset-1',
      idempotencyKey: 'op-key-1',
      artifactIds: ['artifact-9'],
    });
    tx.videoArtifact.findMany = jest.fn(async () => [
      { id: 'artifact-9', artifactType: VideoArtifactType.FRAME },
    ]);
    const { repository, auditLog } = makeRepository(tx);
    const result = await repository.createArtifactsBatch(
      TENANT,
      'asset-1',
      [VideoAssetStatus.VALIDATED],
      'op-key-1',
      items,
      () => ({ tenantId: TENANT, actorEmail: 'x', action: 'CREATE' }) as never,
      () => ({ tenantId: TENANT, actorEmail: 'x', action: 'UPDATE' }) as never,
    );
    const batch = result as Exclude<typeof result, 'key-conflict' | null>;
    expect(batch.replayed).toBe(true);
    expect(batch.artifacts.map((artifact) => artifact.id)).toEqual([
      'artifact-9',
    ]);
    // Nothing appended, nothing re-audited, no status flip.
    expect(tx.videoArtifact.create).not.toHaveBeenCalled();
    expect(tx.videoAsset.updateMany).not.toHaveBeenCalled();
    expect(auditLog.record).not.toHaveBeenCalled();
  });

  it('refuses to replay a key that belongs to a different asset', async () => {
    const tx = makeTx();
    tx.videoExtractionRequest.findFirst.mockResolvedValue({
      id: 'req-1',
      videoAssetId: 'OTHER-asset',
      idempotencyKey: 'op-key-1',
      artifactIds: [],
    });
    const { repository } = makeRepository(tx);
    const result = await repository.createArtifactsBatch(
      TENANT,
      'asset-1',
      [VideoAssetStatus.VALIDATED],
      'op-key-1',
      items,
      () => ({ tenantId: TENANT, actorEmail: 'x', action: 'CREATE' }) as never,
      () => ({ tenantId: TENANT, actorEmail: 'x', action: 'UPDATE' }) as never,
    );
    expect(result).toBe('key-conflict');
  });
});
