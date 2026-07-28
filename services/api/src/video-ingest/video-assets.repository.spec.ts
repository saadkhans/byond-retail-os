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

  it('locks the SESSION-derived unit and validates the CURRENT unit for a session-only upload', async () => {
    // The session's unitId/locationId pair is a historical copy; the fix
    // requires the unit advisory lock (learned via a preliminary session
    // read, canonical order) and a CURRENT-unit read before persisting.
    const tx = makeTx();
    const { repository } = makeRepository(tx);
    await repository.createAsset(
      TENANT,
      { ...baseAssetData, sessionId: 'session-1' },
      () => ({ tenantId: TENANT, actorEmail: 'x', action: 'CREATE' }) as never,
    );
    // Preliminary session read + locked re-read.
    expect(tx.checkoutSession.findFirst).toHaveBeenCalledTimes(2);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw.mock.calls[0][1]).toBe(`retail-unit:${TENANT}:unit-1`);
    // The CURRENT unit is read under the lock (not the session's copy).
    expect(tx.retailUnit.findFirst).toHaveBeenCalledTimes(1);
  });

  it('rejects a session-only upload whose unit was re-homed to another store', async () => {
    // The session carries the HISTORICAL unit/store pair; the unit now
    // lives in store-B. Persisting the stale pair would make enqueue()
    // reject the asset's crops with unit-location-mismatch later.
    const tx = makeTx();
    tx.retailUnit.findFirst.mockResolvedValue({
      id: 'unit-1',
      locationId: 'store-B',
    });
    const { repository, auditLog } = makeRepository(tx);
    const result = await repository.createAsset(
      TENANT,
      { ...baseAssetData, sessionId: 'session-1' },
      () => ({ tenantId: TENANT, actorEmail: 'x', action: 'CREATE' }) as never,
    );
    expect(result).toBe('session-location-mismatch');
    expect(tx.videoAsset.create).not.toHaveBeenCalled();
    expect(auditLog.record).not.toHaveBeenCalled();
  });

  it('rejects a session that moved units between the preliminary read and the locks', async () => {
    const tx = makeTx();
    tx.checkoutSession.findFirst
      .mockResolvedValueOnce({ unitId: 'unit-1' }) // preliminary
      .mockResolvedValueOnce({
        id: 'session-1',
        unitId: 'unit-MOVED',
        locationId: 'loc-1',
      }); // locked re-read
    const { repository } = makeRepository(tx);
    const result = await repository.createAsset(
      TENANT,
      { ...baseAssetData, sessionId: 'session-1' },
      () => ({ tenantId: TENANT, actorEmail: 'x', action: 'CREATE' }) as never,
    );
    expect(result).toBe('session-unit-mismatch');
    expect(tx.videoAsset.create).not.toHaveBeenCalled();
  });

  it('rejects a session-only upload whose current unit no longer exists', async () => {
    const tx = makeTx();
    tx.retailUnit.findFirst.mockResolvedValue(null);
    const { repository } = makeRepository(tx);
    const result = await repository.createAsset(
      TENANT,
      { ...baseAssetData, sessionId: 'session-1' },
      () => ({ tenantId: TENANT, actorEmail: 'x', action: 'CREATE' }) as never,
    );
    expect(result).toBe('unit-not-found');
  });

  it('persists every new asset as PENDING_MEDIA (forced at the persistence layer)', async () => {
    // The row commits BEFORE the media write, so it must land in the
    // NON-SCREENABLE staging state: a QUARANTINED row here would be
    // screenable before its bytes existed (the Finding A race). No
    // caller-supplied field can override the forced status; the service
    // publishes PENDING_MEDIA → QUARANTINED only after put succeeds.
    const tx = makeTx();
    const { repository } = makeRepository(tx);
    await repository.createAsset(
      TENANT,
      { ...baseAssetData },
      () => ({ tenantId: TENANT, actorEmail: 'x', action: 'CREATE' }) as never,
    );
    const [{ data }] = tx.videoAsset.create.mock.calls[0] as unknown as [
      { data: { status: VideoAssetStatus } },
    ];
    expect(data.status).toBe(VideoAssetStatus.PENDING_MEDIA);
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

  it('linkArtifactToInferenceJob requires a non-deleted parent IN THE WRITE itself', async () => {
    // The earlier read is not enough: a DELETE can commit between the read
    // and the updateMany. The conditional write must atomically require
    // the parent not deleted.
    const tx = makeTx();
    tx.videoArtifact.findFirst.mockResolvedValueOnce({
      id: 'artifact-1',
      inferenceJobId: null,
    });
    tx.videoArtifact.findFirstOrThrow.mockResolvedValueOnce({
      id: 'artifact-1',
      inferenceJobId: 'job-1',
    });
    const { repository } = makeRepository(tx);
    const result = await repository.linkArtifactToInferenceJob(
      TENANT,
      'artifact-1',
      'job-1',
      () => ({ tenantId: TENANT, actorEmail: 'x', action: 'UPDATE' }) as never,
    );
    expect(result).toEqual({ id: 'artifact-1', inferenceJobId: 'job-1' });
    const [{ where }] = tx.videoArtifact.updateMany.mock
      .calls[0] as unknown as [
      {
        where: {
          inferenceJobId: null;
          videoAsset: { deletedAt: null };
        };
      },
    ];
    expect(where.inferenceJobId).toBeNull();
    expect(where.videoAsset).toEqual({ deletedAt: null });
  });

  it('linkArtifactToInferenceJob returns null when the parent was deleted mid-flight', async () => {
    const tx = makeTx();
    tx.videoArtifact.findFirst
      .mockResolvedValueOnce({ id: 'artifact-1', inferenceJobId: null }) // read
      .mockResolvedValueOnce(null); // zero-count recheck: parent now deleted
    tx.videoArtifact.updateMany.mockResolvedValue({ count: 0 });
    const { repository, auditLog } = makeRepository(tx);
    const result = await repository.linkArtifactToInferenceJob(
      TENANT,
      'artifact-1',
      'job-1',
      () => ({ tenantId: TENANT, actorEmail: 'x', action: 'UPDATE' }) as never,
    );
    expect(result).toBeNull();
    expect(auditLog.record).not.toHaveBeenCalled();
  });

  it('linkArtifactToInferenceJob reports already-linked when a concurrent link zeroed the write', async () => {
    const tx = makeTx();
    tx.videoArtifact.findFirst
      .mockResolvedValueOnce({ id: 'artifact-1', inferenceJobId: null }) // read
      .mockResolvedValueOnce({ id: 'artifact-1' }); // recheck: still visible
    tx.videoArtifact.updateMany.mockResolvedValue({ count: 0 });
    const { repository } = makeRepository(tx);
    const result = await repository.linkArtifactToInferenceJob(
      TENANT,
      'artifact-1',
      'job-1',
      () => ({ tenantId: TENANT, actorEmail: 'x', action: 'UPDATE' }) as never,
    );
    expect(result).toBe('already-linked');
  });
});

describe('decision/preview serialization on the asset advisory lock', () => {
  // Finding B regression pins: every screening-decision CAS
  // (transitionStatus) and the preview's final serve authorization take
  // the SAME pg_advisory_xact_lock, so a preview can never be audited or
  // served for an asset whose terminal decision committed first. The key
  // assertions mirror the unit-lock tests: $queryRaw is a tagged template,
  // so calls[n][1] is the interpolated advisory-lock key.
  it('transitionStatus takes the asset advisory lock inside its transaction', async () => {
    const tx = makeTx();
    tx.videoAsset.findFirst.mockResolvedValue({
      id: 'asset-1',
      status: VideoAssetStatus.QUARANTINED,
    });
    tx.videoAsset.findFirstOrThrow.mockResolvedValue({
      id: 'asset-1',
      status: VideoAssetStatus.UPLOADED,
    });
    const { repository, auditLog } = makeRepository(tx);
    const result = await repository.transitionStatus(
      TENANT,
      'asset-1',
      [VideoAssetStatus.QUARANTINED],
      { status: VideoAssetStatus.UPLOADED },
      () => ({ tenantId: TENANT, actorEmail: 'x', action: 'UPDATE' }) as never,
    );
    expect(result).toEqual({ id: 'asset-1', status: VideoAssetStatus.UPLOADED });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw.mock.calls[0][1]).toBe(`video-asset:${TENANT}:asset-1`);
    // The lock precedes the CAS read (the whole point of serializing).
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.videoAsset.findFirst.mock.invocationCallOrder[0],
    );
    expect(auditLog.record).toHaveBeenCalledTimes(1);
  });

  it('transitionStatus clears the screening inspection evidence on EVERY transition', async () => {
    // Finding D invalidation rule: evidence is single-use and
    // QUARANTINED-scoped — approve consumes it, reject/publish/delete make
    // it moot, and a later fresh QUARANTINED publish must start with none.
    const tx = makeTx();
    tx.videoAsset.findFirst.mockResolvedValue({
      id: 'asset-1',
      status: VideoAssetStatus.QUARANTINED,
    });
    const { repository } = makeRepository(tx);
    await repository.transitionStatus(
      TENANT,
      'asset-1',
      [VideoAssetStatus.QUARANTINED],
      { status: VideoAssetStatus.UPLOADED },
      () => ({ tenantId: TENANT, actorEmail: 'x', action: 'UPDATE' }) as never,
    );
    const [{ data }] = tx.videoAsset.updateMany.mock.calls[0] as unknown as [
      { data: Record<string, unknown> },
    ];
    expect(data.status).toBe(VideoAssetStatus.UPLOADED);
    expect(data.screeningInspectedAt).toBeNull();
    expect(data.screeningInspectedBy).toBeNull();
    expect(data.screeningInspectedFrames).toBeNull();
  });

  it('transitionStatus runs the guard INSIDE the locked transaction — a guard veto writes and audits NOTHING', async () => {
    // The APPROVE evidence gate rides this guard: it sees the CURRENT row
    // under the advisory lock, and its controlled throw aborts the
    // transaction before any update or audit.
    const tx = makeTx();
    tx.videoAsset.findFirst.mockResolvedValue({
      id: 'asset-1',
      status: VideoAssetStatus.QUARANTINED,
      screeningInspectedAt: null,
      screeningInspectedFrames: null,
    });
    const { repository, auditLog } = makeRepository(tx);
    const guard = jest.fn(() => {
      throw new Error('no inspection evidence');
    });
    await expect(
      repository.transitionStatus(
        TENANT,
        'asset-1',
        [VideoAssetStatus.QUARANTINED],
        { status: VideoAssetStatus.UPLOADED },
        () =>
          ({ tenantId: TENANT, actorEmail: 'x', action: 'UPDATE' }) as never,
        guard,
      ),
    ).rejects.toThrow('no inspection evidence');
    // The guard saw the LOCKED re-read's row…
    expect(guard).toHaveBeenCalledWith(
      expect.objectContaining({ status: VideoAssetStatus.QUARANTINED }),
    );
    // …and its veto prevented both the write and the audit.
    expect(tx.videoAsset.updateMany).not.toHaveBeenCalled();
    expect(auditLog.record).not.toHaveBeenCalled();
  });

  it('authorizeScreeningPreviewServe takes the SAME lock, re-reads, audits the QUARANTINED serve, and STAMPS the inspection evidence in one transaction', async () => {
    const tx = makeTx();
    tx.videoAsset.findFirst.mockResolvedValue({
      status: VideoAssetStatus.QUARANTINED,
    });
    const { repository, auditLog } = makeRepository(tx);
    const entry = {
      tenantId: TENANT,
      actorEmail: 'x',
      action: 'READ',
    } as never;
    const result = await repository.authorizeScreeningPreviewServe(
      TENANT,
      'asset-1',
      { actorId: 'screener-1', servedFrameCount: 6 },
      () => entry,
    );
    expect(result).toBe(VideoAssetStatus.QUARANTINED);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw.mock.calls[0][1]).toBe(`video-asset:${TENANT}:asset-1`);
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.videoAsset.findFirst.mock.invocationCallOrder[0],
    );
    // Evidence stamped INSIDE the same guarded transaction, still CAS-ed on
    // QUARANTINED (a decision cannot have interleaved under the lock).
    expect(tx.videoAsset.updateMany).toHaveBeenCalledTimes(1);
    const [{ where, data }] = tx.videoAsset.updateMany.mock
      .calls[0] as unknown as [
      { where: Record<string, unknown>; data: Record<string, unknown> },
    ];
    expect(where.status).toBe(VideoAssetStatus.QUARANTINED);
    expect(where.deletedAt).toBeNull();
    expect(data.screeningInspectedAt).toBeInstanceOf(Date);
    expect(data.screeningInspectedBy).toBe('screener-1');
    expect(data.screeningInspectedFrames).toBe(6);
    // The READ audit is written INSIDE the guarded transaction (tx handle).
    expect(auditLog.record).toHaveBeenCalledTimes(1);
    expect(auditLog.record).toHaveBeenCalledWith(entry, tx);
  });

  it('authorizeScreeningPreviewServe stamps NO evidence for a zero-frame serve (audited, but nothing was inspected)', async () => {
    // frameCount > 0 requirement: a preview whose every sample position was
    // skipped served nothing — the READ is audited, but approval evidence
    // must NOT exist (zero-frame evidence is impossible to create).
    const tx = makeTx();
    tx.videoAsset.findFirst.mockResolvedValue({
      status: VideoAssetStatus.QUARANTINED,
    });
    const { repository, auditLog } = makeRepository(tx);
    const result = await repository.authorizeScreeningPreviewServe(
      TENANT,
      'asset-1',
      { actorId: 'screener-1', servedFrameCount: 0 },
      () => ({ tenantId: TENANT, actorEmail: 'x', action: 'READ' }) as never,
    );
    expect(result).toBe(VideoAssetStatus.QUARANTINED);
    expect(tx.videoAsset.updateMany).not.toHaveBeenCalled();
    expect(auditLog.record).toHaveBeenCalledTimes(1);
  });

  it('authorizeScreeningPreviewServe reports a committed decision WITHOUT auditing or stamping evidence', async () => {
    // A decision serialized ahead of the guard: the re-read sees the
    // terminal status — no READ audit may be written (nothing is served)
    // and no evidence may be stamped (the asset is no longer approvable).
    const tx = makeTx();
    tx.videoAsset.findFirst.mockResolvedValue({
      status: VideoAssetStatus.REJECTED,
    });
    const { repository, auditLog } = makeRepository(tx);
    const result = await repository.authorizeScreeningPreviewServe(
      TENANT,
      'asset-1',
      { actorId: 'screener-1', servedFrameCount: 6 },
      () => ({ tenantId: TENANT, actorEmail: 'x', action: 'READ' }) as never,
    );
    expect(result).toBe(VideoAssetStatus.REJECTED);
    expect(auditLog.record).not.toHaveBeenCalled();
    expect(tx.videoAsset.updateMany).not.toHaveBeenCalled();
  });

  it('authorizeScreeningPreviewServe returns null for a deleted/missing asset WITHOUT auditing or stamping', async () => {
    const tx = makeTx();
    tx.videoAsset.findFirst.mockResolvedValue(null);
    const { repository, auditLog } = makeRepository(tx);
    const result = await repository.authorizeScreeningPreviewServe(
      TENANT,
      'asset-1',
      { actorId: 'screener-1', servedFrameCount: 6 },
      () => ({ tenantId: TENANT, actorEmail: 'x', action: 'READ' }) as never,
    );
    expect(result).toBeNull();
    expect(auditLog.record).not.toHaveBeenCalled();
    expect(tx.videoAsset.updateMany).not.toHaveBeenCalled();
  });

  it('softDelete clears the inspection evidence alongside the deletedAt stamp', async () => {
    // Lifecycle-exit invalidation: a deleted asset can never be approved,
    // so no dormant evidence survives the soft delete.
    const tx = makeTx();
    tx.videoAsset.findFirst.mockResolvedValue({
      id: 'asset-1',
      status: VideoAssetStatus.QUARANTINED,
    });
    const { repository } = makeRepository(tx);
    await repository.softDelete(
      TENANT,
      'asset-1',
      () => ({ tenantId: TENANT, actorEmail: 'x', action: 'DELETE' }) as never,
    );
    const [{ data }] = tx.videoAsset.updateMany.mock.calls[0] as unknown as [
      { data: Record<string, unknown> },
    ];
    expect(data.deletedAt).toBeInstanceOf(Date);
    expect(data.screeningInspectedAt).toBeNull();
    expect(data.screeningInspectedBy).toBeNull();
    expect(data.screeningInspectedFrames).toBeNull();
  });

  it('softDelete takes the SAME asset advisory lock before its reads (deletion serializes with the preview guard)', async () => {
    // Finding H regression pin: without the lock, a preview's final
    // guarded authorization could re-read QUARANTINED, a concurrent
    // delete could commit, and the preview would still audit its READ and
    // serve frames for a deleted asset. Taking the lock FIRST makes the
    // preview's guard cover deletion exactly as it covers decisions.
    const tx = makeTx();
    tx.videoAsset.findFirst.mockResolvedValue({
      id: 'asset-1',
      status: VideoAssetStatus.QUARANTINED,
    });
    const { repository } = makeRepository(tx);
    await repository.softDelete(
      TENANT,
      'asset-1',
      () => ({ tenantId: TENANT, actorEmail: 'x', action: 'DELETE' }) as never,
    );
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw.mock.calls[0][1]).toBe(`video-asset:${TENANT}:asset-1`);
    // The lock precedes the not-yet-deleted read (and thus the CAS).
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.videoAsset.findFirst.mock.invocationCallOrder[0],
    );
  });
});

describe('VideoAssetsRepository.recordMediaRemovalCompleted', () => {
  // Findings I + K regression pins: the DB marker CAS — not the storage
  // adapter's stat-then-rm report — is the exactly-once authority for the
  // media-removal completion audit entry.
  it('claims the marker and writes the completion audit in ONE transaction', async () => {
    const tx = makeTx();
    const { repository, auditLog } = makeRepository(tx);
    const entry = {
      tenantId: TENANT,
      actorEmail: 'x',
      action: 'DELETE',
    } as never;
    const result = await repository.recordMediaRemovalCompleted(
      TENANT,
      'asset-1',
      () => entry,
    );
    expect(result).toBe('recorded');
    const [{ where, data }] = tx.videoAsset.updateMany.mock
      .calls[0] as unknown as [
      { where: Record<string, unknown>; data: Record<string, unknown> },
    ];
    // The CAS predicate: only a not-yet-recorded removal can claim.
    expect(where.tenantId).toBe(TENANT);
    expect(where.id).toBe('asset-1');
    expect(where.mediaRemovedAt).toBeNull();
    expect(data.mediaRemovedAt).toBeInstanceOf(Date);
    // The completion audit commits in the SAME transaction (tx handle).
    expect(auditLog.record).toHaveBeenCalledTimes(1);
    expect(auditLog.record).toHaveBeenCalledWith(entry, tx);
  });

  it('a second completion attempt loses the CAS and writes NO second audit', async () => {
    // Two concurrent-ish removals (initial + idempotent replay) may both
    // see bytes on disk — only the marker winner records completion; the
    // loser reports already-recorded and the audit trail keeps exactly
    // one completion entry.
    const tx = makeTx();
    tx.videoAsset.updateMany.mockResolvedValue({ count: 0 });
    const { repository, auditLog } = makeRepository(tx);
    const result = await repository.recordMediaRemovalCompleted(
      TENANT,
      'asset-1',
      () => ({ tenantId: TENANT, actorEmail: 'x', action: 'DELETE' }) as never,
    );
    expect(result).toBe('already-recorded');
    expect(auditLog.record).not.toHaveBeenCalled();
  });
});

describe('VideoAssetsRepository.listLinkedInferenceJobs', () => {
  it('enumerates linked job ids with status, deduped, WITHOUT a non-deleted-parent filter', async () => {
    // The delete flow runs AFTER the soft-delete committed (and on
    // idempotent replays), so the query must see artifacts of the
    // already-deleted parent — scoping it to non-deleted parents would
    // hide exactly the jobs the delete needs to retire.
    const { repository, prisma } = makeRepository(makeTx());
    prisma.videoArtifact.findMany.mockResolvedValue([
      { inferenceJobId: 'job-1', inferenceJob: { status: 'QUEUED' } },
      { inferenceJobId: 'job-1', inferenceJob: { status: 'QUEUED' } },
      { inferenceJobId: 'job-2', inferenceJob: { status: 'RUNNING' } },
    ] as never);
    const result = await repository.listLinkedInferenceJobs(TENANT, 'asset-1');
    expect(result).toEqual([
      { id: 'job-1', status: 'QUEUED' },
      { id: 'job-2', status: 'RUNNING' },
    ]);
    const [{ where }] = prisma.videoArtifact.findMany.mock
      .calls[0] as unknown as [
      {
        where: {
          tenantId: string;
          videoAssetId: string;
          inferenceJobId: { not: null };
          videoAsset?: unknown;
        };
      },
    ];
    expect(where.tenantId).toBe(TENANT);
    expect(where.videoAssetId).toBe('asset-1');
    expect(where.inferenceJobId).toEqual({ not: null });
    expect(where.videoAsset).toBeUndefined();
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
