import {
  VideoArtifactType,
  VideoAssetStatus,
  VideoMediaWriteState,
} from '@prisma/client';
import {
  EXTRACTION_OPERATION_LOCK_MAX_WAIT_MS,
  EXTRACTION_OPERATION_LOCK_TIMEOUT_MS,
  VideoAssetsRepository,
  videoExtractionOperationLockKey,
} from './video-assets.repository';

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
    // The options argument is captured too: the operation lock passes
    // explicit wait/hold ceilings with its interactive transaction.
    $transaction: jest.fn(
      async (
        fn: (t: TxStub) => Promise<unknown>,
        _options?: { maxWait: number; timeout: number },
      ) => fn(tx),
    ),
    // Non-transactional reads — capture the where clauses for scoping tests.
    videoArtifact: {
      findFirst: jest.fn(async () => null),
      findMany: jest.fn(async () => []),
    },
    videoAsset: {
      findFirst: jest.fn(async () => null),
      // Media-write resolution is a plain, connection-cheap update on the
      // ROOT client — no transaction, no advisory lock.
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
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
      'asset-1',
      'artifact-1',
      'job-1',
      () => ({ tenantId: TENANT, actorEmail: 'x', action: 'UPDATE' }) as never,
    );
    expect(result).toBeNull();
    const [{ where }] = tx.videoArtifact.findFirst.mock
      .calls[0] as unknown as [
      { where: { videoAssetId: string; videoAsset: { deletedAt: null } } },
    ];
    expect(where.videoAsset).toEqual({ deletedAt: null });
    // The read is pinned to the caller's parent asset (the lock key).
    expect(where.videoAssetId).toBe('asset-1');
  });

  it('linkArtifactToInferenceJob takes the PARENT asset advisory lock BEFORE its guarded read (serializes with deletion)', async () => {
    // Codex P1: without the lock, the non-deleted-parent predicate could
    // pass, a DELETE (which holds the lock and enumerates linked jobs to
    // retire) could commit in between, and the link would commit AFTER the
    // enumeration ran — leaving a QUEUED job the delete flow never
    // cancels. Same key/idiom as softDelete/transitionStatus/
    // authorizeScreeningPreviewServe.
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
    await repository.linkArtifactToInferenceJob(
      TENANT,
      'asset-1',
      'artifact-1',
      'job-1',
      () => ({ tenantId: TENANT, actorEmail: 'x', action: 'UPDATE' }) as never,
    );
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    // $queryRaw is a tagged template: calls[0][1] is the interpolated
    // advisory-lock key — the SAME per-asset key deletion locks.
    expect(tx.$queryRaw.mock.calls[0][1]).toBe(`video-asset:${TENANT}:asset-1`);
    // The lock precedes the guarded read (and therefore the write).
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.videoArtifact.findFirst.mock.invocationCallOrder[0],
    );
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
      'asset-1',
      'artifact-1',
      'job-1',
      () => ({ tenantId: TENANT, actorEmail: 'x', action: 'UPDATE' }) as never,
    );
    expect(result).toEqual({ id: 'artifact-1', inferenceJobId: 'job-1' });
    const [{ where }] = tx.videoArtifact.updateMany.mock
      .calls[0] as unknown as [
      {
        where: {
          videoAssetId: string;
          inferenceJobId: null;
          videoAsset: { deletedAt: null };
        };
      },
    ];
    expect(where.inferenceJobId).toBeNull();
    expect(where.videoAsset).toEqual({ deletedAt: null });
    expect(where.videoAssetId).toBe('asset-1');
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
      'asset-1',
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
      'asset-1',
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

  it('softDelete reads the mediaRemovedAt marker INSIDE its locked transaction and reports "media present" honestly', async () => {
    // Codex P2 support: the marker read rides the SAME locked read as the
    // CAS (screening REJECT transitions serialize on the same lock), so
    // the delete audit and the caller's completion decision can never
    // disagree with a concurrent screening removal.
    const tx = makeTx();
    tx.videoAsset.findFirst.mockResolvedValue({
      id: 'asset-1',
      status: VideoAssetStatus.QUARANTINED,
      mediaRemovedAt: null,
    });
    const { repository } = makeRepository(tx);
    const builder = jest.fn(
      () => ({ tenantId: TENANT, actorEmail: 'x', action: 'DELETE' }) as never,
    );
    const result = await repository.softDelete(TENANT, 'asset-1', builder);
    expect(result).toMatchObject({ mediaAlreadyRemoved: false });
    expect(builder).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'asset-1' }),
      false,
      false,
    );
    // The marker AND the durable media-write state are read alongside the
    // safe select in ONE query.
    const [{ select }] = tx.videoAsset.findFirst.mock.calls[0] as unknown as [
      { select: { mediaRemovedAt: boolean; mediaWriteState: boolean } },
    ];
    expect(select.mediaRemovedAt).toBe(true);
    expect(select.mediaWriteState).toBe(true);
  });

  it('softDelete reports an ALREADY-claimed removal marker (screening rejection removed the media first) and strips it from the audit snapshot', async () => {
    const removedAt = new Date('2026-07-01T00:00:00Z');
    const tx = makeTx();
    tx.videoAsset.findFirst.mockResolvedValue({
      id: 'asset-1',
      status: VideoAssetStatus.REJECTED,
      mediaRemovedAt: removedAt,
    });
    const { repository } = makeRepository(tx);
    const builder = jest.fn(
      () => ({ tenantId: TENANT, actorEmail: 'x', action: 'DELETE' }) as never,
    );
    const result = await repository.softDelete(TENANT, 'asset-1', builder);
    expect(result).toMatchObject({ mediaAlreadyRemoved: true });
    // The builder learns the fact as a boolean; the before snapshot keeps
    // the exact VIDEO_ASSET_SELECT shape (no marker column smuggled in).
    expect(builder).toHaveBeenCalledWith(
      expect.not.objectContaining({ mediaRemovedAt: removedAt }),
      true,
      false,
    );
  });

  it('softDelete reports an UNDECIDED media write (a claimed put has not resolved) and strips the column from the audit snapshot', async () => {
    // Item 2: the claim is stamped under THIS lock immediately before the
    // put, so reading it here is authoritative — PENDING means an upload
    // can still land bytes just after the caller drains the prefix, and the
    // caller must therefore withhold its exactly-once completion marker.
    const tx = makeTx();
    tx.videoAsset.findFirst.mockResolvedValue({
      id: 'asset-1',
      status: VideoAssetStatus.PENDING_MEDIA,
      mediaRemovedAt: null,
      mediaWriteState: VideoMediaWriteState.PENDING,
    });
    const { repository } = makeRepository(tx);
    const builder = jest.fn(
      () => ({ tenantId: TENANT, actorEmail: 'x', action: 'DELETE' }) as never,
    );
    const result = await repository.softDelete(TENANT, 'asset-1', builder);
    expect(result).toMatchObject({
      mediaAlreadyRemoved: false,
      mediaWriteUndecided: true,
    });
    expect(builder).toHaveBeenCalledWith(
      expect.not.objectContaining({
        mediaWriteState: VideoMediaWriteState.PENDING,
      }),
      false,
      true,
    );
  });

  it('softDelete treats a RESOLVED (or never-claimed) media write as decided', async () => {
    for (const state of [
      VideoMediaWriteState.SUCCEEDED,
      VideoMediaWriteState.FAILED,
      null,
    ]) {
      const tx = makeTx();
      tx.videoAsset.findFirst.mockResolvedValue({
        id: 'asset-1',
        status: VideoAssetStatus.QUARANTINED,
        mediaRemovedAt: null,
        mediaWriteState: state,
      });
      const { repository } = makeRepository(tx);
      const result = await repository.softDelete(
        TENANT,
        'asset-1',
        () => ({ tenantId: TENANT, actorEmail: 'x', action: 'DELETE' }) as never,
      );
      expect(result).toMatchObject({ mediaWriteUndecided: false });
    }
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

describe('VideoAssetsRepository.beginMediaWriteUnderLock', () => {
  it('takes the SAME asset advisory lock BEFORE the read and CLAIMS the media write on a live asset', async () => {
    // The upload's pre-put step serializes with softDelete on this lock: a
    // 'live' answer means no delete had committed at the moment of the
    // read, and the PENDING claim it stamps in the same transaction is
    // what a later delete OBSERVES instead of inferring the drain.
    const tx = makeTx();
    tx.videoAsset.findFirst.mockResolvedValue({ deletedAt: null });
    const { repository } = makeRepository(tx);
    await expect(
      repository.beginMediaWriteUnderLock(TENANT, 'asset-1'),
    ).resolves.toBe('live');
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw.mock.calls[0][1]).toBe(`video-asset:${TENANT}:asset-1`);
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.videoAsset.findFirst.mock.invocationCallOrder[0],
    );
    // The claim is written in the SAME locked transaction as the read, and
    // re-asserts "not deleted" in the write itself.
    const [{ where, data }] = tx.videoAsset.updateMany.mock
      .calls[0] as unknown as [
      { where: Record<string, unknown>; data: Record<string, unknown> },
    ];
    expect(where).toEqual({
      id: 'asset-1',
      tenantId: TENANT,
      deletedAt: null,
    });
    expect(data).toEqual({ mediaWriteState: VideoMediaWriteState.PENDING });
    expect(tx.videoAsset.findFirst.mock.invocationCallOrder[0]).toBeLessThan(
      tx.videoAsset.updateMany.mock.invocationCallOrder[0],
    );
  });

  it('reports deleted and missing rows honestly and claims NOTHING for them (soft-deleted rows are still READ — no deletedAt filter)', async () => {
    const tx = makeTx();
    tx.videoAsset.findFirst
      .mockResolvedValueOnce({ deletedAt: new Date() })
      .mockResolvedValueOnce(null);
    const { repository } = makeRepository(tx);
    await expect(
      repository.beginMediaWriteUnderLock(TENANT, 'asset-1'),
    ).resolves.toBe('deleted');
    await expect(
      repository.beginMediaWriteUnderLock(TENANT, 'asset-1'),
    ).resolves.toBe('missing');
    // No claim on either path: the caller skips the put entirely, so the
    // state stays NULL ("no media write was ever attempted") and a delete
    // may record its completion.
    expect(tx.videoAsset.updateMany).not.toHaveBeenCalled();
    // Deliberately NO deletedAt filter in the where: the whole point is
    // to SEE a committed soft-delete, not to have it filtered into
    // "missing" ambiguity.
    const [{ where }] = tx.videoAsset.findFirst.mock.calls[0] as unknown as [
      { where: Record<string, unknown> },
    ];
    expect(where).toEqual({ id: 'asset-1', tenantId: TENANT });
  });
});

describe('VideoAssetsRepository.resolveMediaWrite', () => {
  it('resolves PENDING → SUCCEEDED and PENDING → FAILED with a compare-and-set on the claim', async () => {
    const { repository, prisma } = makeRepository(makeTx());
    const updateMany = prisma.videoAsset.updateMany;
    await repository.resolveMediaWrite(TENANT, 'asset-1', 'SUCCEEDED');
    await repository.resolveMediaWrite(TENANT, 'asset-1', 'FAILED');
    const calls = updateMany.mock.calls as unknown as [
      { where: Record<string, unknown>; data: Record<string, unknown> },
    ][];
    for (const [call] of calls) {
      // CAS on the claim: a stale resolution can never decide a state the
      // row never claimed, nor overwrite an already-decided one.
      expect(call.where).toEqual({
        id: 'asset-1',
        tenantId: TENANT,
        mediaWriteState: VideoMediaWriteState.PENDING,
      });
    }
    expect(calls[0][0].data).toEqual({
      mediaWriteState: VideoMediaWriteState.SUCCEEDED,
    });
    expect(calls[1][0].data).toEqual({
      mediaWriteState: VideoMediaWriteState.FAILED,
    });
    // No transaction, no advisory lock: nothing else writes this column,
    // so the resolution stays a single connection-cheap statement.
    expect(prisma.$transaction).not.toHaveBeenCalled();
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

describe('VideoAssetsRepository.listCropArtifactIds', () => {
  it('returns UNLINKED CROP artifact ids, WITHOUT a non-deleted-parent filter', async () => {
    // The delete flow's crash-window sweep: a crop→job creation that died
    // between the job commit and the link transaction leaves a job nothing
    // references, so the caller probes each unlinked crop under its
    // deterministic `video-crop:<artifactId>` idempotency key. Same
    // deleted-parent reasoning as listLinkedInferenceJobs — this runs after
    // the soft-delete committed. Linked crops are excluded: their jobs
    // already come back from listLinkedInferenceJobs.
    const { repository, prisma } = makeRepository(makeTx());
    prisma.videoArtifact.findMany.mockResolvedValue([
      { id: 'artifact-1' },
      { id: 'artifact-2' },
    ] as never);
    await expect(
      repository.listCropArtifactIds(TENANT, 'asset-1'),
    ).resolves.toEqual(['artifact-1', 'artifact-2']);
    const [{ where, select }] = prisma.videoArtifact.findMany.mock
      .calls[0] as unknown as [
      {
        where: {
          tenantId: string;
          videoAssetId: string;
          artifactType: VideoArtifactType;
          inferenceJobId: null;
          videoAsset?: unknown;
        };
        select: Record<string, boolean>;
      },
    ];
    expect(where.tenantId).toBe(TENANT);
    expect(where.videoAssetId).toBe('asset-1');
    expect(where.artifactType).toBe(VideoArtifactType.CROP);
    expect(where.inferenceJobId).toBeNull();
    expect(where.videoAsset).toBeUndefined();
    // Ids only — no artifact metadata is read for the sweep.
    expect(select).toEqual({ id: true });
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
      'op-hash-1',
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
      'op-hash-1',
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
      'op-hash-1',
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
    tx.videoArtifact.findMany = jest
      .fn()
      // 1st findMany: the committed-owner verdict over the staged keys.
      .mockResolvedValueOnce([{ storageKey: items[0].storageKey }])
      // 2nd findMany: the recorded batch's artifact rows.
      .mockResolvedValueOnce([
        { id: 'artifact-9', artifactType: VideoArtifactType.FRAME },
      ]);
    const { repository, auditLog } = makeRepository(tx);
    const result = await repository.createArtifactsBatch(
      TENANT,
      'asset-1',
      'op-hash-1',
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
    // The replay carries the committed-owner verdict too — it is the ONLY
    // outcome that authorizes the caller to delete staged files.
    expect(batch.committedStagedKeys).toEqual([items[0].storageKey]);
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
      'op-hash-1',
      [VideoAssetStatus.VALIDATED],
      'op-key-1',
      items,
      () => ({ tenantId: TENANT, actorEmail: 'x', action: 'CREATE' }) as never,
      () => ({ tenantId: TENANT, actorEmail: 'x', action: 'UPDATE' }) as never,
    );
    expect(result).toBe('key-conflict');
  });
});

describe('extraction operation advisory lock', () => {
  const items = [
    {
      artifactType: VideoArtifactType.FRAME,
      timestampMs: 0,
      width: 100,
      height: 100,
      mimeType: 'image/png',
      sizeBytes: 10,
      checksumSha256: 'abc',
      storageKey: 'tenant-1/u/artifacts/hash-1/0.png',
    },
  ];

  // Codex P1 (round 1): with DETERMINISTIC staging keys, a failing attempt's
  // cleanup could run its committed-owner lookup while the winning attempt's
  // artifact transaction was still uncommitted, see no owner, and delete the
  // SHARED key — leaving append-only artifact rows whose file is gone.
  // Codex P1 (round 2): the fix for that must NOT be an OUTER interactive
  // transaction wrapped around the whole stage → publish → cleanup section —
  // every DB call inside it then needed a SECOND pooled connection while the
  // first was pinned, so pool-sized concurrency could deadlock the pool. The
  // lock therefore lives INSIDE the publication transaction, which is the
  // only place it has to be for the committed-owner verdict to be
  // trustworthy.
  it('derives the operation lock key from tenant, asset, and the staging operation hash', () => {
    expect(videoExtractionOperationLockKey(TENANT, 'asset-1', 'abc123')).toBe(
      `video-extraction-op:${TENANT}:asset-1:abc123`,
    );
  });

  it('takes pg_advisory_xact_lock on the operation key as the publication transaction’s FIRST statement', async () => {
    const tx = makeTx();
    const { repository } = makeRepository(tx);
    await repository.createArtifactsBatch(
      TENANT,
      'asset-1',
      'hash-1',
      [VideoAssetStatus.VALIDATED],
      undefined,
      items,
      () => ({ tenantId: TENANT, actorEmail: 'x', action: 'CREATE' }) as never,
      () => ({ tenantId: TENANT, actorEmail: 'x', action: 'UPDATE' }) as never,
    );
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    // Tagged template: calls[0][1] is the interpolated lock key — the SAME
    // shape as before, so the granularity the staging keys rely on is
    // unchanged.
    expect(tx.$queryRaw.mock.calls[0][1]).toBe(
      `video-extraction-op:${TENANT}:asset-1:hash-1`,
    );
    // FIRST: before the ownership verdict, before the CAS read, before any
    // write. Every competing publication for this operation queues here.
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.videoArtifact.findMany.mock.invocationCallOrder[0],
    );
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.videoAsset.findFirst.mock.invocationCallOrder[0],
    );
  });

  it('decides the committed-owner verdict INSIDE that same locked transaction, before writing anything', async () => {
    // This is what closes the reported race: the verdict the caller's
    // staged-file cleanup acts on cannot observe a rival batch mid-commit
    // (MVCC-invisible but about to land), because no rival publication can
    // be open while this transaction holds the lock.
    const tx = makeTx();
    tx.videoArtifact.findMany = jest.fn(async () => [
      { storageKey: items[0].storageKey },
    ]);
    const { repository } = makeRepository(tx);
    const result = await repository.createArtifactsBatch(
      TENANT,
      'asset-1',
      'hash-1',
      [VideoAssetStatus.VALIDATED],
      undefined,
      items,
      () => ({ tenantId: TENANT, actorEmail: 'x', action: 'CREATE' }) as never,
      () => ({ tenantId: TENANT, actorEmail: 'x', action: 'UPDATE' }) as never,
    );
    const batch = result as Exclude<typeof result, 'key-conflict' | null>;
    expect(batch.committedStagedKeys).toEqual([items[0].storageKey]);
    const [{ where, select }] = tx.videoArtifact.findMany.mock
      .calls[0] as unknown as [
      { where: Record<string, unknown>; select: Record<string, unknown> },
    ];
    // Tenant-scoped, limited to the staged keys, reading NOTHING but the
    // key column, and NOT scoped to non-deleted parents (a soft-deleted
    // asset's rows still own their files until the prefix is removed).
    expect(where).toEqual({
      tenantId: TENANT,
      storageKey: { in: [items[0].storageKey] },
    });
    expect(select).toEqual({ storageKey: true });
    // Before this batch's own rows exist: the answer must be "keys an
    // EARLIER committed batch owns".
    expect(tx.videoArtifact.findMany.mock.invocationCallOrder[0]).toBeLessThan(
      tx.videoArtifact.create.mock.invocationCallOrder[0],
    );
  });

  it('runs the publication on ONE connection: no nested transaction, no root-client call inside the lock', async () => {
    // Codex P1: the outer lock transaction pinned a connection while the
    // callback's root-client publication and ownership queries each needed
    // ANOTHER one — at pool-sized concurrency every connection could be
    // held by a lock transaction while every callback waited for a second.
    const tx = makeTx();
    const { repository, prisma } = makeRepository(tx);
    await repository.createArtifactsBatch(
      TENANT,
      'asset-1',
      'hash-1',
      [VideoAssetStatus.VALIDATED],
      undefined,
      items,
      () => ({ tenantId: TENANT, actorEmail: 'x', action: 'CREATE' }) as never,
      () => ({ tenantId: TENANT, actorEmail: 'x', action: 'UPDATE' }) as never,
    );
    // Exactly ONE transaction for the whole locked publication...
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    // ...and the ROOT client is never touched while it is open: every read
    // and write went through the transaction client.
    expect(prisma.videoArtifact.findMany).not.toHaveBeenCalled();
    expect(prisma.videoArtifact.findFirst).not.toHaveBeenCalled();
    expect(prisma.videoAsset.findFirst).not.toHaveBeenCalled();
    expect(prisma.videoAsset.updateMany).not.toHaveBeenCalled();
    expect(prisma.videoExtractionRequest.findFirst).not.toHaveBeenCalled();
  });

  it('bounds how long the lock may be waited for and held', async () => {
    const tx = makeTx();
    const { repository, prisma } = makeRepository(tx);
    await repository.createArtifactsBatch(
      TENANT,
      'asset-1',
      'hash-1',
      [VideoAssetStatus.VALIDATED],
      undefined,
      items,
      () => ({ tenantId: TENANT, actorEmail: 'x', action: 'CREATE' }) as never,
      () => ({ tenantId: TENANT, actorEmail: 'x', action: 'UPDATE' }) as never,
    );
    expect(prisma.$transaction.mock.calls[0][1]).toEqual({
      maxWait: EXTRACTION_OPERATION_LOCK_MAX_WAIT_MS,
      timeout: EXTRACTION_OPERATION_LOCK_TIMEOUT_MS,
    });
  });

  it('propagates the publication’s error unchanged (the transaction rolls back, the lock is released with it)', async () => {
    const tx = makeTx();
    const boom = new Error('publish failed');
    tx.videoArtifact.create.mockRejectedValue(boom);
    const { repository } = makeRepository(tx);
    await expect(
      repository.createArtifactsBatch(
        TENANT,
        'asset-1',
        'hash-1',
        [VideoAssetStatus.VALIDATED],
        undefined,
        items,
        () => ({ tenantId: TENANT, actorEmail: 'x', action: 'CREATE' }) as never,
        () => ({ tenantId: TENANT, actorEmail: 'x', action: 'UPDATE' }) as never,
      ),
    ).rejects.toBe(boom);
  });
});
