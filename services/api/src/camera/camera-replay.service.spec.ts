import { ConflictException, NotFoundException } from '@nestjs/common';
import {
  CameraPilotRunStatus,
  CameraSourceStatus,
  CameraSourceType,
  Prisma,
} from '@prisma/client';
import { AnalysisFrame } from '../pickup-detection/analysis/pickup-analyzer';
import {
  CameraReplayService,
  REPLAY_HEARTBEAT_INTERVAL_MS,
  STALE_REPLAY_RUN_MS,
  replayGeometry,
} from './camera-replay.service';

const TENANT = 'tenant-1';

/** Two flat frames — no motion, zero candidate windows. */
function flatFrames(): AnalysisFrame[] {
  return [
    { index: 0, timestampMs: 0, rgb: Buffer.alloc(16 * 16 * 3, 40) },
    { index: 1, timestampMs: 500, rgb: Buffer.alloc(16 * 16 * 3, 40) },
  ];
}

/** Motion bursts at 500–1000ms and 2500–3000ms → exactly TWO windows with
 *  the default config (minScore 8, minDuration 400ms, cooldown 1000ms).
 *  The 16×16 asset keeps replayGeometry aligned with these buffers. */
function twoBurstFrames(): AnalysisFrame[] {
  const values = [40, 200, 40, 40, 40, 200, 40, 40];
  return values.map((value, index) => ({
    index,
    timestampMs: index * 500,
    rgb: Buffer.alloc(16 * 16 * 3, value),
  }));
}

function buildService(overrides: {
  source?: Record<string, unknown> | null;
  asset?: Record<string, unknown> | null;
  existingRun?: Record<string, unknown> | null;
  frames?: AnalysisFrame[];
  /** Window indexes (1-based) whose fusion run should throw. */
  failWindows?: number[];
  exitEvents?: { sourceType: string }[];
} = {}) {
  const sourceRow = {
    id: 'cam-1',
    tenantId: TENANT,
    locationId: 'store-1',
    unitId: null,
    shelfZone: null,
    sourceType: CameraSourceType.FILE_REPLAY,
    status: CameraSourceStatus.ACTIVE,
    replayVideoAssetId: 'asset-1',
    ...(overrides.source ?? {}),
  };
  const assetRow =
    overrides.asset === null
      ? null
      : {
          id: 'asset-1',
          deletedAt: null,
          status: 'READY',
          durationMs: 5000,
          width: 16,
          height: 16,
          locationId: 'store-1',
          unitId: null,
          storageKey: 'store/key.mp4',
          ...(overrides.asset ?? {}),
        };
  const createdRuns: Record<string, unknown>[] = [];
  const runUpdates: Record<string, unknown>[] = [];
  let fusionCalls = 0;
  /* eslint-disable @typescript-eslint/no-explicit-any */
  // Row store shared by create/findFirst/updateMany — the stub HONORS the
  // conditional where clauses (status, leaseOwner, heartbeat expiry)
  // exactly like the database, so lease races are exercised for real.
  const allRows = (): Record<string, unknown>[] =>
    overrides.existingRun
      ? [overrides.existingRun as Record<string, unknown>, ...createdRuns]
      : createdRuns;
  const withInclude = (row: Record<string, unknown>) => ({
    ...row,
    cameraSource: { name: 'Fridge cam', sourceType: sourceRow.sourceType },
  });
  const prisma: any = {
    cameraPilotRun: {
      create: jest.fn(async (args: { data: Record<string, unknown> }) => {
        const row = {
          id: `run-${createdRuns.length + 1}`,
          status: CameraPilotRunStatus.RUNNING,
          startedAt: new Date('2026-08-16T12:00:00.000Z'),
          finishedAt: null,
          errors: [],
          ...args.data,
        };
        createdRuns.push(row);
        return row;
      }),
      findFirst: jest.fn(
        async (args: {
          where: { id?: string; idempotencyKey?: string };
        }) => {
          if (args.where.id !== undefined) {
            const row = allRows().find((r) => r.id === args.where.id);
            return row ? withInclude(row) : null;
          }
          return overrides.existingRun ?? null;
        },
      ),
      // No longer used by the service (all writes are conditional
      // updateMany) — kept so "never called" assertions stay meaningful.
      update: jest.fn(),
      updateMany: jest.fn(
        async (args: {
          where: {
            id: string;
            status?: string;
            leaseOwner?: string;
            OR?: [
              { heartbeatAt: { lt: Date } },
              { heartbeatAt: null; startedAt: { lt: Date } },
            ];
          };
          data: Record<string, unknown>;
        }) => {
          const row = allRows().find((r) => r.id === args.where.id) as
            | {
                status: string;
                leaseOwner?: string | null;
                heartbeatAt?: Date | null;
                startedAt: Date;
              }
            | undefined;
          if (!row) {
            return { count: 0 };
          }
          if (
            args.where.status !== undefined &&
            row.status !== args.where.status
          ) {
            return { count: 0 };
          }
          if (
            args.where.leaseOwner !== undefined &&
            row.leaseOwner !== args.where.leaseOwner
          ) {
            return { count: 0 };
          }
          if (args.where.OR) {
            const cutoff = args.where.OR[0].heartbeatAt.lt;
            const beat = row.heartbeatAt ?? row.startedAt;
            if (beat.getTime() >= cutoff.getTime()) {
              return { count: 0 };
            }
          }
          Object.assign(row, args.data);
          runUpdates.push({ id: args.where.id, ...args.data });
          return { count: 1 };
        },
      ),
      findMany: jest.fn(async () => []),
    },
    // READ-ONLY: the replay binds evidence to the EXACT fusion run id it
    // created — this stub returns evidence keyed by that id.
    pickupFusionRun: {
      findFirst: jest.fn(async (args: { where: { id: string } }) => ({
        id: args.where.id,
        evidence: {
          crops: [{}, {}, {}],
          vlm: { invoked: true, status: 'VERDICT' },
        },
      })),
    },
    cameraSource: {
      update: jest.fn(async () => sourceRow),
    },
  };
  const sources = {
    requireSource: jest.fn(async () => {
      if (overrides.source === null) {
        throw new NotFoundException('Camera source not found');
      }
      return sourceRow;
    }),
  };
  const assets = { findByIdInternal: jest.fn(async () => assetRow) };
  const media = {
    decodeAnalysisFrames: jest.fn(
      async () => overrides.frames ?? flatFrames(),
    ),
  };
  const detection = { detectForAsset: jest.fn(async () => ({})) };
  const fusion = {
    run: jest.fn(async () => {
      fusionCalls += 1;
      if (overrides.failWindows?.includes(fusionCalls)) {
        throw new ConflictException('Fusion needs a VALIDATED asset');
      }
      return { runId: `fusion-${fusionCalls}` };
    }),
  };
  const journeys = {
    create: jest.fn(async () => ({ id: 'j-1' })),
    appendFromFusionRun: jest.fn(async () => ({})),
    exit: jest.fn(async () => ({
      decision: 'READY_TO_SETTLE_SHADOW',
      events: overrides.exitEvents ?? [
        { sourceType: 'MANUAL' },
        { sourceType: 'FUSION_SHADOW' },
        { sourceType: 'MANUAL' },
      ],
      issues: [],
    })),
    abortShadowJourney: jest.fn(async () => ({ decision: 'FAILED' })),
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const service = new CameraReplayService(
    prisma as never,
    sources as never,
    assets as never,
    media as never,
    detection as never,
    fusion as never,
    journeys as never,
  );
  /** The final persist update (the one carrying `status`) — heartbeat
   *  bumps also land in runUpdates, so tests must not rely on order. */
  const finalRunUpdate = () =>
    runUpdates.find((update) => 'status' in update) as
      | Record<string, unknown>
      | undefined;
  return {
    service,
    prisma,
    sources,
    assets,
    media,
    detection,
    fusion,
    journeys,
    createdRuns,
    runUpdates,
    finalRunUpdate,
  };
}

/** A completed stored run matching the default request fingerprint. */
function storedRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-existing',
    cameraSourceId: 'cam-1',
    videoAssetId: 'asset-1',
    frameIntervalMs: 500,
    journeyId: 'j-1',
    status: CameraPilotRunStatus.SUCCEEDED,
    framesProcessed: 2,
    eventWindowsDetected: 0,
    eventWindowsProcessed: 0,
    cropFramesGenerated: 0,
    clipArtifactsGenerated: 0,
    fusionRunsCompleted: 0,
    vlmInvoked: 0,
    vlmSkipped: 0,
    vlmFailed: 0,
    journeyEventsCreated: 1,
    reviewNeeded: 0,
    decision: 'READY_TO_SETTLE_SHADOW',
    eventWindows: [],
    stageTimings: [],
    errors: [],
    startedAt: new Date(),
    heartbeatAt: null,
    finishedAt: new Date(),
    cameraSource: { name: 'Fridge cam', sourceType: 'FILE_REPLAY' },
    ...overrides,
  };
}

describe('CameraReplayService.replayRun — per-window pipeline', () => {
  it('TWO motion windows drive TWO fusion runs, each bound to its exact run id', async () => {
    const built = buildService({
      frames: twoBurstFrames(),
      exitEvents: [
        { sourceType: 'MANUAL' },
        { sourceType: 'FUSION_SHADOW' },
        { sourceType: 'FUSION_SHADOW' },
        { sourceType: 'MANUAL' },
      ],
    });
    const view = await built.service.replayRun(TENANT, 'cam-1', {}, 'user-1');
    expect(built.fusion.run).toHaveBeenCalledTimes(2);
    // Each fusion call is scoped to ITS extracted window.
    expect(built.fusion.run).toHaveBeenNthCalledWith(1, TENANT, 'asset-1', {
      window: { startMs: 500, endMs: 1000, peakMs: 500 },
    });
    expect(built.fusion.run).toHaveBeenNthCalledWith(2, TENANT, 'asset-1', {
      window: { startMs: 2500, endMs: 3000, peakMs: 2500 },
    });
    // Evidence reads and journey imports use the EXACT returned run ids —
    // never a latest-row lookup.
    expect(built.prisma.pickupFusionRun.findFirst).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: { tenantId: TENANT, id: 'fusion-1' },
        select: expect.anything(),
      }),
    );
    expect(built.journeys.appendFromFusionRun).toHaveBeenNthCalledWith(
      1,
      TENANT,
      'j-1',
      'asset-1',
      'user-1',
      expect.objectContaining({ fusionRunId: 'fusion-1' }),
    );
    expect(built.journeys.appendFromFusionRun).toHaveBeenNthCalledWith(
      2,
      TENANT,
      'j-1',
      'asset-1',
      'user-1',
      expect.objectContaining({ fusionRunId: 'fusion-2' }),
    );
    expect(view.eventWindowsDetected).toBe(2);
    expect(view.eventWindowsProcessed).toBe(2);
    expect(view.fusionRunsCompleted).toBe(2);
    expect(view.cropFramesGenerated).toBe(6);
    expect(view.clipArtifactsGenerated).toBe(0);
    expect(view.vlmInvoked).toBe(2);
    expect(view.journeyEventsCreated).toBe(2);
    expect(view.status).toBe(CameraPilotRunStatus.SUCCEEDED);
  });

  it('observations are stamped relative to the REPLAY RUN start, not the upload date', async () => {
    const built = buildService({ frames: twoBurstFrames() });
    await built.service.replayRun(TENANT, 'cam-1', {}, 'user-1');
    const options = (
      built.journeys.appendFromFusionRun.mock.calls[0] as unknown[]
    )[4] as { sourceTimeBase: Date };
    // The pilot run row's startedAt (stubbed 2026-08-16T12:00Z) is the
    // source-time base — an old uploaded asset replayed today must not
    // produce observations days before the journey's ENTRY.
    expect(options.sourceTimeBase.toISOString()).toBe(
      '2026-08-16T12:00:00.000Z',
    );
  });

  it('ONE coherent timeline: ENTRY at run start, EXIT past the footage extent', async () => {
    const built = buildService({ frames: twoBurstFrames() });
    await built.service.replayRun(TENANT, 'cam-1', {}, 'user-1');
    // ENTRY anchored to the run's start…
    expect(built.journeys.create).toHaveBeenCalledWith(
      TENANT,
      { locationId: 'store-1', unitId: null },
      'user-1',
      { entryAt: new Date('2026-08-16T12:00:00.000Z') },
    );
    // …and EXIT at run start + max(durationMs 5000, last window end 3000)
    // + 1s margin: even INSTANT processing of a peak near the clip's end
    // (peak ≤ duration < exit) cannot place an observation after EXIT.
    const exitOptions = (built.journeys.exit.mock.calls[0] as unknown[])[3] as {
      exitAt: Date;
    };
    expect(exitOptions.exitAt.toISOString()).toBe('2026-08-16T12:00:06.000Z');
    // Window order is preserved on the same base: peak1 (500ms) < peak2
    // (2500ms) < exit offset (6000ms).
    const firstImport = (
      built.journeys.appendFromFusionRun.mock.calls[0] as unknown[]
    )[4] as { sourceTimeBase: Date };
    const secondImport = (
      built.journeys.appendFromFusionRun.mock.calls[1] as unknown[]
    )[4] as { sourceTimeBase: Date };
    expect(firstImport.sourceTimeBase.getTime()).toBe(
      secondImport.sourceTimeBase.getTime(),
    );
  });

  it('ZERO windows → zero fusion runs, a clean empty journey, run SUCCEEDED', async () => {
    const built = buildService({
      frames: flatFrames(),
      exitEvents: [{ sourceType: 'MANUAL' }, { sourceType: 'MANUAL' }],
    });
    const view = await built.service.replayRun(TENANT, 'cam-1', {}, 'user-1');
    expect(built.fusion.run).not.toHaveBeenCalled();
    expect(built.journeys.create).toHaveBeenCalledTimes(1);
    expect(built.journeys.exit).toHaveBeenCalledTimes(1);
    expect(view.eventWindowsDetected).toBe(0);
    expect(view.fusionRunsCompleted).toBe(0);
    expect(view.journeyEventsCreated).toBe(0);
    expect(view.status).toBe(CameraPilotRunStatus.SUCCEEDED);
  });

  it('one failed window records a code and the OTHER window still processes with its own evidence', async () => {
    const built = buildService({
      frames: twoBurstFrames(),
      failWindows: [1],
    });
    const view = await built.service.replayRun(TENANT, 'cam-1', {}, 'user-1');
    expect(built.fusion.run).toHaveBeenCalledTimes(2);
    expect(view.eventWindowsDetected).toBe(2);
    expect(view.eventWindowsProcessed).toBe(1);
    expect(view.fusionRunsCompleted).toBe(1);
    // Only window 2's evidence counted — nothing misattributed from the
    // failed window.
    expect(view.cropFramesGenerated).toBe(3);
    expect(view.vlmInvoked).toBe(1);
    expect(built.journeys.appendFromFusionRun).toHaveBeenCalledTimes(1);
    expect(built.journeys.appendFromFusionRun).toHaveBeenCalledWith(
      TENANT,
      'j-1',
      'asset-1',
      'user-1',
      expect.objectContaining({ fusionRunId: 'fusion-2' }),
    );
    const persisted = built.finalRunUpdate() as {
      errors: { stage: string; code: string }[];
    };
    expect(persisted.errors).toEqual([
      { stage: 'window-1', code: 'STAGE_UNAVAILABLE' },
    ]);
    expect(JSON.stringify(persisted.errors)).not.toContain('VALIDATED');
    expect(view.status).toBe(CameraPilotRunStatus.SUCCEEDED);
  });

  it('ALL windows failing fails the run (NO_WINDOW_PROCESSED) — never a clean empty result', async () => {
    const built = buildService({
      frames: twoBurstFrames(),
      failWindows: [1, 2],
    });
    const view = await built.service.replayRun(TENANT, 'cam-1', {}, 'user-1');
    expect(view.status).toBe(CameraPilotRunStatus.FAILED);
    expect(view.eventWindowsProcessed).toBe(0);
    const persisted = built.finalRunUpdate() as {
      errors: { stage: string; code: string }[];
    };
    expect(persisted.errors).toContainEqual({
      stage: 'replay',
      code: 'NO_WINDOW_PROCESSED',
    });
  });

  it('a FAILED replay closes its opened journey — never an OPEN entry-only leftover', async () => {
    const built = buildService({
      frames: twoBurstFrames(),
      failWindows: [1, 2],
    });
    const view = await built.service.replayRun(TENANT, 'cam-1', {}, 'user-1');
    expect(view.status).toBe(CameraPilotRunStatus.FAILED);
    // The abort path ran with a CONTROLLED code and the source-time exit
    // stamp — the journey is settled as decision FAILED, not left OPEN.
    expect(built.journeys.abortShadowJourney).toHaveBeenCalledWith(
      TENANT,
      'j-1',
      'NO_WINDOW_PROCESSED',
      'user-1',
      expect.objectContaining({ exitAt: expect.any(Date) }),
    );
    expect(view.decision).toBe('FAILED');
    // The normal exit stage was suppressed by the failure guard — cleanup
    // is what closed the journey.
    expect(built.journeys.exit).not.toHaveBeenCalled();
  });

  it('a journey-exit failure still aborts the journey (no OPEN leftovers)', async () => {
    const built = buildService();
    built.journeys.exit.mockRejectedValueOnce(
      new ConflictException('Journey is no longer open'),
    );
    const view = await built.service.replayRun(TENANT, 'cam-1', {}, 'user-1');
    expect(view.status).toBe(CameraPilotRunStatus.FAILED);
    expect(built.journeys.abortShadowJourney).toHaveBeenCalled();
  });

  it('a pickup-detection failure is non-fatal (fusion is the authority)', async () => {
    const built = buildService();
    built.detection.detectForAsset.mockRejectedValueOnce(
      new ConflictException('Pickup detection is disabled on this deployment'),
    );
    const view = await built.service.replayRun(TENANT, 'cam-1', {}, 'user-1');
    expect(view.status).toBe(CameraPilotRunStatus.SUCCEEDED);
  });
});

describe('CameraReplayService.replayRun — idempotency fingerprint + staleness', () => {
  it('an exact retry replays the stored run without reprocessing', async () => {
    const built = buildService({ existingRun: storedRun() });
    const view = await built.service.replayRun(
      TENANT,
      'cam-1',
      { idempotencyKey: 'replay-key-0001' },
      'user-1',
    );
    expect(view.runId).toBe('run-existing');
    expect(built.media.decodeAnalysisFrames).not.toHaveBeenCalled();
    expect(built.fusion.run).not.toHaveBeenCalled();
    expect(built.prisma.cameraPilotRun.create).not.toHaveBeenCalled();
  });

  it('the same key with a DIFFERENT camera conflicts', async () => {
    const built = buildService({
      existingRun: storedRun({ cameraSourceId: 'cam-OTHER' }),
    });
    await expect(
      built.service.replayRun(
        TENANT,
        'cam-1',
        { idempotencyKey: 'replay-key-0001' },
        'user-1',
      ),
    ).rejects.toThrow('different replay request');
  });

  it('the same key with a DIFFERENT video conflicts', async () => {
    const built = buildService({ existingRun: storedRun() });
    await expect(
      built.service.replayRun(
        TENANT,
        'cam-1',
        { idempotencyKey: 'replay-key-0001', videoAssetId: 'asset-OTHER' },
        'user-1',
      ),
    ).rejects.toThrow('different replay request');
  });

  it('the same key with a DIFFERENT frame interval conflicts', async () => {
    const built = buildService({ existingRun: storedRun() });
    await expect(
      built.service.replayRun(
        TENANT,
        'cam-1',
        { idempotencyKey: 'replay-key-0001', frameIntervalMs: 1000 },
        'user-1',
      ),
    ).rejects.toThrow('different replay request');
  });

  it('a FRESH RUNNING run under the key reports in-progress instead of duplicating work', async () => {
    const built = buildService({
      existingRun: storedRun({
        status: CameraPilotRunStatus.RUNNING,
        startedAt: new Date(Date.now() - 1000),
        finishedAt: null,
      }),
    });
    await expect(
      built.service.replayRun(
        TENANT,
        'cam-1',
        { idempotencyKey: 'replay-key-0001' },
        'user-1',
      ),
    ).rejects.toThrow('still in progress');
    expect(built.prisma.cameraPilotRun.create).not.toHaveBeenCalled();
  });

  it('an EXPIRED-heartbeat RUNNING run is atomically failed with STALE_REPLAY_RUN, its key released, and the retry processes', async () => {
    const built = buildService({
      existingRun: storedRun({
        status: CameraPilotRunStatus.RUNNING,
        startedAt: new Date(Date.now() - STALE_REPLAY_RUN_MS - 120_000),
        heartbeatAt: new Date(Date.now() - STALE_REPLAY_RUN_MS - 60_000),
        finishedAt: null,
      }),
    });
    const view = await built.service.replayRun(
      TENANT,
      'cam-1',
      { idempotencyKey: 'replay-key-0001' },
      'user-1',
    );
    // The orphaned row was claimed ATOMICALLY (conditional updateMany on
    // status + expired heartbeat), failed, and released…
    expect(built.prisma.cameraPilotRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'run-existing',
          tenantId: TENANT,
          status: CameraPilotRunStatus.RUNNING,
        }),
        data: expect.objectContaining({
          status: CameraPilotRunStatus.FAILED,
          idempotencyKey: null,
          errors: expect.arrayContaining([
            { stage: 'replay', code: 'STALE_REPLAY_RUN' },
          ]),
        }),
      }),
    );
    // …and a FRESH run processed the footage under the same key.
    expect(built.prisma.cameraPilotRun.create).toHaveBeenCalledTimes(1);
    expect(view.status).toBe(CameraPilotRunStatus.SUCCEEDED);
  });

  it('a LONG-running replay with a FRESH heartbeat is never reclaimed by start age', async () => {
    const built = buildService({
      existingRun: storedRun({
        status: CameraPilotRunStatus.RUNNING,
        // Started ages ago — but the lease heartbeat is alive.
        startedAt: new Date(Date.now() - 4 * STALE_REPLAY_RUN_MS),
        heartbeatAt: new Date(Date.now() - 5_000),
        finishedAt: null,
      }),
    });
    await expect(
      built.service.replayRun(
        TENANT,
        'cam-1',
        { idempotencyKey: 'replay-key-0001' },
        'user-1',
      ),
    ).rejects.toThrow('still in progress');
    expect(built.prisma.cameraPilotRun.updateMany).not.toHaveBeenCalled();
    expect(built.prisma.cameraPilotRun.create).not.toHaveBeenCalled();
  });

  it('a stale claim that LOSES the race returns the finished run untouched (SUCCEEDED never overwritten)', async () => {
    const staleThenDone = storedRun({
      status: CameraPilotRunStatus.RUNNING,
      startedAt: new Date(Date.now() - STALE_REPLAY_RUN_MS - 60_000),
      heartbeatAt: new Date(Date.now() - STALE_REPLAY_RUN_MS - 30_000),
      finishedAt: null,
    });
    const built = buildService({ existingRun: staleThenDone });
    // The original replay completes between our read and the claim: the
    // conditional updateMany matches nothing…
    built.prisma.cameraPilotRun.updateMany.mockResolvedValueOnce({
      count: 0,
    });
    // …and the re-read shows the CURRENT (finished) state.
    built.prisma.cameraPilotRun.findFirst
      .mockResolvedValueOnce(staleThenDone)
      .mockResolvedValueOnce(
        storedRun({ id: 'run-existing', status: CameraPilotRunStatus.SUCCEEDED }),
      );
    const view = await built.service.replayRun(
      TENANT,
      'cam-1',
      { idempotencyKey: 'replay-key-0001' },
      'user-1',
    );
    expect(view.runId).toBe('run-existing');
    expect(view.status).toBe(CameraPilotRunStatus.SUCCEEDED);
    // No fresh processing, no overwrite.
    expect(built.prisma.cameraPilotRun.create).not.toHaveBeenCalled();
    expect(built.prisma.cameraPilotRun.update).not.toHaveBeenCalled();
  });

  it('a P2002 race returns the concurrent winner (same fingerprint rules)', async () => {
    const built = buildService();
    built.prisma.cameraPilotRun.findFirst
      .mockResolvedValueOnce(null) // pre-check misses
      .mockResolvedValueOnce(storedRun({ id: 'run-winner' }));
    built.prisma.cameraPilotRun.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    const view = await built.service.replayRun(
      TENANT,
      'cam-1',
      { idempotencyKey: 'replay-key-0001' },
      'user-1',
    );
    expect(view.runId).toBe('run-winner');
    expect(built.fusion.run).not.toHaveBeenCalled();
  });
});

describe('CameraReplayService.replayRun — store context up front', () => {
  it('an asset with NO store context is rejected before ANY side effect', async () => {
    const built = buildService({ asset: { locationId: null } });
    await expect(
      built.service.replayRun(TENANT, 'cam-1', {}, 'user-1'),
    ).rejects.toThrow('no store context');
    expect(built.prisma.cameraPilotRun.create).not.toHaveBeenCalled();
    expect(built.journeys.create).not.toHaveBeenCalled();
    expect(built.media.decodeAnalysisFrames).not.toHaveBeenCalled();
  });

  it("an asset from ANOTHER store is rejected before any side effect", async () => {
    const built = buildService({ asset: { locationId: 'store-OTHER' } });
    await expect(
      built.service.replayRun(TENANT, 'cam-1', {}, 'user-1'),
    ).rejects.toThrow("does not match this camera's store");
    expect(built.prisma.cameraPilotRun.create).not.toHaveBeenCalled();
    expect(built.journeys.create).not.toHaveBeenCalled();
  });

  it('a matching store proceeds', async () => {
    const built = buildService();
    const view = await built.service.replayRun(TENANT, 'cam-1', {}, 'user-1');
    expect(view.status).toBe(CameraPilotRunStatus.SUCCEEDED);
  });

  it('a placeholder source type cannot run (409, controlled message)', async () => {
    const built = buildService({
      source: { sourceType: CameraSourceType.RTSP_PLACEHOLDER },
    });
    await expect(
      built.service.replayRun(TENANT, 'cam-1', {}, 'user-1'),
    ).rejects.toThrow('source type not enabled in shadow pilot');
  });

  it('a non-ACTIVE source cannot run', async () => {
    const built = buildService({
      source: { status: CameraSourceStatus.DISABLED },
    });
    await expect(
      built.service.replayRun(TENANT, 'cam-1', {}, 'user-1'),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('replayGeometry', () => {
  it('downscales to even dimensions at the analysis width', () => {
    expect(replayGeometry({ width: 640, height: 360 })).toEqual({
      width: 192,
      height: 108,
    });
  });

  it('never upscales a small source', () => {
    const geometry = replayGeometry({ width: 100, height: 50 });
    expect(geometry.width).toBeLessThanOrEqual(100);
    expect(geometry.width % 2).toBe(0);
  });
});

describe('CameraReplayService — lease ownership (Codex P1 round 3)', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('an attempt whose lease was taken cannot finalize — the row is not overwritten', async () => {
    const built = buildService({});
    // Simulate a reclaim mid-replay: by the time the journey exits, the
    // row belongs to someone else (foreign lease owner token).
    built.journeys.exit.mockImplementation(async () => {
      (built.createdRuns[0] as { leaseOwner: string }).leaseOwner =
        'foreign-owner-token';
      return {
        decision: 'READY_TO_SETTLE_SHADOW',
        events: [{ sourceType: 'MANUAL' }],
        issues: [],
      };
    });
    const view = await built.service.replayRun(TENANT, 'cam-1', {}, 'user-1');
    // The conditional finalization LOST: no status write landed, the
    // source row was not touched, and the caller sees the row's current
    // (still RUNNING, foreign-owned) state instead of a fabricated result.
    expect(built.finalRunUpdate()).toBeUndefined();
    expect(built.prisma.cameraSource.update).not.toHaveBeenCalled();
    expect(view.status).toBe(CameraPilotRunStatus.RUNNING);
  });

  it('a lost heartbeat stops the pipeline early — later stages never run', async () => {
    const built = buildService({});
    // The stage-boundary beat after decode discovers the lease is gone.
    built.media.decodeAnalysisFrames.mockImplementation(async () => {
      (built.createdRuns[0] as { leaseOwner: string }).leaseOwner =
        'foreign-owner-token';
      return flatFrames();
    });
    const view = await built.service.replayRun(TENANT, 'cam-1', {}, 'user-1');
    // The beat after decode-frames reports count 0 → every later stage is
    // suppressed: no pickup-detection, no journey, no finalization.
    expect(built.detection.detectForAsset).not.toHaveBeenCalled();
    expect(built.journeys.create).not.toHaveBeenCalled();
    expect(built.finalRunUpdate()).toBeUndefined();
    expect(view.status).toBe(CameraPilotRunStatus.RUNNING);
  });

  it('the heartbeat beats PERIODICALLY inside a slow stage, not only at boundaries', async () => {
    jest.useFakeTimers();
    const built = buildService({});
    let releaseDecode: (frames: AnalysisFrame[]) => void = () => undefined;
    built.media.decodeAnalysisFrames.mockImplementation(
      () =>
        new Promise<AnalysisFrame[]>((resolve) => {
          releaseDecode = resolve;
        }),
    );
    const pending = built.service.replayRun(TENANT, 'cam-1', {}, 'user-1');
    // Let the run row be created, then advance time INSIDE the still-
    // pending decode stage: the interval must beat while no stage
    // boundary has been reached yet.
    await jest.advanceTimersByTimeAsync(REPLAY_HEARTBEAT_INTERVAL_MS + 1);
    const beatsDuringDecode = built.runUpdates.filter(
      (update) => 'heartbeatAt' in update && !('status' in update),
    );
    expect(beatsDuringDecode.length).toBeGreaterThanOrEqual(1);
    // The rest of the pipeline is pure microtasks — no further timers
    // needed; the service clears its own interval before finalizing.
    releaseDecode(flatFrames());
    const view = await pending;
    expect(view.status).toBe(CameraPilotRunStatus.SUCCEEDED);
  });
});

describe('CameraReplayService — no-detection observations stay on the replay timeline (Codex P1 round 3)', () => {
  it('every window import carries a deterministic clamped fallbackPeakMs, ascending across windows', async () => {
    const built = buildService({
      frames: twoBurstFrames(),
      exitEvents: [
        { sourceType: 'MANUAL' },
        { sourceType: 'FUSION_SHADOW' },
        { sourceType: 'FUSION_SHADOW' },
        { sourceType: 'MANUAL' },
      ],
    });
    await built.service.replayRun(TENANT, 'cam-1', {}, 'user-1');
    const options = (
      built.journeys.appendFromFusionRun.mock.calls as unknown as unknown[][]
    ).map((call) => call[4] as { fallbackPeakMs: number; sourceTimeBase: Date });
    expect(options).toHaveLength(2);
    // Window peaks (500, 2500) clamped to the 5000ms clip — deterministic
    // source-time offsets, never wall clock, preserving relative order.
    expect(options[0].fallbackPeakMs).toBe(500);
    expect(options[1].fallbackPeakMs).toBe(2500);
    expect(options[0].fallbackPeakMs).toBeLessThan(options[1].fallbackPeakMs);
    // And both stay inside the EXIT stamp (start + max(duration, lastEnd) + 1s).
    for (const option of options) {
      expect(option.fallbackPeakMs).toBeLessThanOrEqual(5000 + 1000);
    }
  });
});
