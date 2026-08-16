import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  CameraPilotRun,
  CameraPilotRunStatus,
  CameraSourceStatus,
  CameraSourceType,
  CustomerJourneyDecision,
  Prisma,
  VideoAssetStatus,
} from '@prisma/client';
import { JourneyService } from '../journey/journey.service';
import { AnalysisGeometry } from '../pickup-detection/analysis/pickup-analyzer';
import { PickupDetectionService } from '../pickup-detection/pickup-detection.service';
import { LocalStorageMediaDecoder } from '../pickup-fusion/adapters/storage-media-decoder';
import { PickupFusionService } from '../pickup-fusion/pickup-fusion.service';
import { PrismaService } from '../prisma/prisma.service';
import { VideoAssetsRepository } from '../video-ingest/video-assets.repository';
import { CameraSourcesService, SOURCE_TYPE_NOT_ENABLED } from './camera-sources.service';
import {
  DEFAULT_EVENT_WINDOW_CONFIG,
  EventWindow,
  extractEventWindows,
  motionSamples,
  parseShelfZone,
} from './event-windows';

/**
 * Phase 12 — FILE_REPLAY pilot runtime (SHADOW ONLY).
 *
 * Replays an already-screened, already-validated test video as if it were
 * a camera stream: sampled frames → heuristic event windows → PER-WINDOW
 * fusion runs → journey observations bound to each window's EXACT run id.
 * This service orchestrates and counts; it never talks to the VLM (only
 * fusion does, and fusion sends crops/frames/references — never raw
 * video), never writes vision events, and never touches checkout,
 * order, payment, or inventory tables.
 *
 * Failure hygiene: the run row records stage CODES only — provider text,
 * exception messages, and OCR content never enter it.
 */

export const DEFAULT_FRAME_INTERVAL_MS = 500;

/** A RUNNING run whose HEARTBEAT is older than this is presumed orphaned
 *  (process died mid replay): it is failed with STALE_REPLAY_RUN and its
 *  key is released so the footage can be retried under the same token. */
export const STALE_REPLAY_RUN_MS = 15 * 60_000;

/** Periodic lease heartbeat while a stage is IN PROGRESS (Codex P1): a
 *  single stage slower than the stale threshold must still prove the
 *  replay alive — beating only at stage boundaries would let a retry
 *  reclaim an active run mid-decode. Far below the stale threshold. */
export const REPLAY_HEARTBEAT_INTERVAL_MS = 60_000;

const ANALYSIS_TARGET_WIDTH = 192;

/** Fatal stages abort the pipeline; anything else — including a single
 *  window — degrades to an error code and the run continues. */
const FATAL_STAGES = new Set(['decode-frames', 'journey-open', 'journey-exit']);

export interface PilotRunView {
  runId: string;
  cameraSourceId: string;
  cameraSourceName: string | null;
  sourceType: CameraSourceType | null;
  videoAssetId: string;
  journeyId: string | null;
  status: CameraPilotRunStatus;
  frameIntervalMs: number;
  framesProcessed: number;
  /** Windows the heuristics DETECTED vs windows the pipeline PROCESSED —
   *  a failed window leaves the gap visible instead of hiding inside a
   *  single conflated number. */
  eventWindowsDetected: number;
  eventWindowsProcessed: number;
  /** Crop FRAMES are pre/peak/post evidence frames from fusion. Phase 12
   *  generates NO clip artifacts, so that counter is an honest zero —
   *  never the crop-frame count wearing a clip costume. */
  cropFramesGenerated: number;
  clipArtifactsGenerated: number;
  fusionRunsCompleted: number;
  vlmInvoked: number;
  vlmSkipped: number;
  vlmFailed: number;
  journeyEventsCreated: number;
  reviewNeeded: number;
  decision: CustomerJourneyDecision | null;
  errorCount: number;
  startedAt: Date;
  finishedAt: Date | null;
}

export interface PilotRunDetail extends PilotRunView {
  eventWindows: EventWindow[];
  stageTimings: { stage: string; ms: number }[];
  errors: { stage: string; code: string }[];
}

type RunWithSource = CameraPilotRun & {
  cameraSource: { name: string; sourceType: CameraSourceType } | null;
};

function classifyError(error: unknown): string {
  if (error instanceof ConflictException) {
    return 'STAGE_UNAVAILABLE';
  }
  if (error instanceof NotFoundException) {
    return 'STAGE_NOT_FOUND';
  }
  return 'STAGE_FAILED';
}

function storedErrors(run: CameraPilotRun): { stage: string; code: string }[] {
  return Array.isArray(run.errors)
    ? (run.errors as unknown as { stage: string; code: string }[])
    : [];
}

/** Mirror of analysisGeometryFor's math (even dims, min 16) without the
 *  probe-type coupling. */
export function replayGeometry(source: {
  width: number;
  height: number;
}): AnalysisGeometry {
  const width = Math.max(16, Math.min(ANALYSIS_TARGET_WIDTH, source.width));
  const evenWidth = width - (width % 2);
  const scaledHeight = Math.round((source.height * evenWidth) / source.width);
  const evenHeight = Math.max(16, scaledHeight - (scaledHeight % 2));
  return { width: evenWidth, height: evenHeight };
}

function toView(run: RunWithSource): PilotRunView {
  return {
    runId: run.id,
    cameraSourceId: run.cameraSourceId,
    cameraSourceName: run.cameraSource?.name ?? null,
    sourceType: run.cameraSource?.sourceType ?? null,
    videoAssetId: run.videoAssetId,
    journeyId: run.journeyId,
    status: run.status,
    frameIntervalMs: run.frameIntervalMs,
    framesProcessed: run.framesProcessed,
    eventWindowsDetected: run.eventWindowsDetected,
    eventWindowsProcessed: run.eventWindowsProcessed,
    cropFramesGenerated: run.cropFramesGenerated,
    clipArtifactsGenerated: run.clipArtifactsGenerated,
    fusionRunsCompleted: run.fusionRunsCompleted,
    vlmInvoked: run.vlmInvoked,
    vlmSkipped: run.vlmSkipped,
    vlmFailed: run.vlmFailed,
    journeyEventsCreated: run.journeyEventsCreated,
    reviewNeeded: run.reviewNeeded,
    decision: run.decision,
    errorCount: storedErrors(run).length,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  };
}

function toDetail(run: RunWithSource): PilotRunDetail {
  return {
    ...toView(run),
    eventWindows: Array.isArray(run.eventWindows)
      ? (run.eventWindows as unknown as EventWindow[])
      : [],
    stageTimings: Array.isArray(run.stageTimings)
      ? (run.stageTimings as unknown as { stage: string; ms: number }[])
      : [],
    errors: storedErrors(run),
  };
}

@Injectable()
export class CameraReplayService {
  private readonly logger = new Logger(CameraReplayService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sources: CameraSourcesService,
    private readonly assets: VideoAssetsRepository,
    private readonly media: LocalStorageMediaDecoder,
    private readonly detection: PickupDetectionService,
    private readonly fusion: PickupFusionService,
    private readonly journeys: JourneyService,
  ) {}

  /**
   * Resolve a stored run found under the caller's idempotency key.
   * Returns the run to REPLAY, or null when a stale RUNNING row was just
   * failed-and-released and the caller should process fresh footage.
   *
   * The key is a replay token for ONE request shape: a reused key whose
   * stored (camera, video, frameInterval) fingerprint differs is a
   * different request and conflicts instead of silently returning
   * another replay's result.
   */
  private async resolveExistingRun(
    tenantId: string,
    existing: RunWithSource,
    fingerprint: {
      cameraSourceId: string;
      videoAssetId: string;
      frameIntervalMs: number;
    },
  ): Promise<RunWithSource | null> {
    if (
      existing.cameraSourceId !== fingerprint.cameraSourceId ||
      existing.videoAssetId !== fingerprint.videoAssetId ||
      existing.frameIntervalMs !== fingerprint.frameIntervalMs
    ) {
      throw new ConflictException(
        'idempotency key was already used for a different replay request',
      );
    }
    if (existing.status !== CameraPilotRunStatus.RUNNING) {
      return existing;
    }
    // LEASE semantics (Codex P1): staleness is judged by the HEARTBEAT the
    // replay bumps at every stage boundary, never by mere start age — a
    // legitimate replay slower than the threshold keeps its lease alive.
    const lastBeat = existing.heartbeatAt ?? existing.startedAt;
    const cutoff = new Date(Date.now() - STALE_REPLAY_RUN_MS);
    if (lastBeat.getTime() >= cutoff.getTime()) {
      // A live replay is still working the footage — no duplicate
      // processing, no premature takeover.
      throw new ConflictException('replay is still in progress');
    }
    // ATOMIC reclaim, conditioned on (still RUNNING + heartbeat still
    // expired): if the original replay completes — or merely beats —
    // between our read and this write, the claim LOSES (count 0) and the
    // row's CURRENT state is returned untouched. A SUCCEEDED run can
    // never be overwritten by a late stale-claim.
    const claimed = await this.prisma.cameraPilotRun.updateMany({
      where: {
        id: existing.id,
        tenantId,
        status: CameraPilotRunStatus.RUNNING,
        OR: [
          { heartbeatAt: { lt: cutoff } },
          { heartbeatAt: null, startedAt: { lt: cutoff } },
        ],
      },
      data: {
        status: CameraPilotRunStatus.FAILED,
        finishedAt: new Date(),
        idempotencyKey: null,
        leaseOwner: null,
        errors: [
          ...storedErrors(existing),
          { stage: 'replay', code: 'STALE_REPLAY_RUN' },
        ] as unknown as Prisma.InputJsonValue,
      },
    });
    if (claimed.count === 0) {
      const current = await this.prisma.cameraPilotRun.findFirst({
        where: { tenantId, id: existing.id },
        include: { cameraSource: { select: { name: true, sourceType: true } } },
      });
      if (current && current.status !== CameraPilotRunStatus.RUNNING) {
        return current as RunWithSource;
      }
      throw new ConflictException('replay is still in progress');
    }
    this.logger.warn(
      `pilot run ${existing.id} was stale RUNNING — failed with STALE_REPLAY_RUN, key released`,
    );
    return null;
  }

  async replayRun(
    tenantId: string,
    cameraSourceId: string,
    input: {
      videoAssetId?: string | null;
      frameIntervalMs?: number | null;
      idempotencyKey?: string | null;
    },
    actorId?: string,
  ): Promise<PilotRunDetail> {
    const source = await this.sources.requireSource(tenantId, cameraSourceId);
    if (source.sourceType !== CameraSourceType.FILE_REPLAY) {
      throw new ConflictException(SOURCE_TYPE_NOT_ENABLED);
    }
    if (source.status !== CameraSourceStatus.ACTIVE) {
      throw new ConflictException('camera source is not ACTIVE');
    }
    const videoAssetId = input.videoAssetId ?? source.replayVideoAssetId;
    if (!videoAssetId) {
      throw new ConflictException(
        'no video asset: pass videoAssetId or configure the source replay asset',
      );
    }
    const frameIntervalMs = input.frameIntervalMs ?? DEFAULT_FRAME_INTERVAL_MS;
    const fingerprint = { cameraSourceId, videoAssetId, frameIntervalMs };
    const idempotencyKey = input.idempotencyKey?.trim() || null;
    if (idempotencyKey) {
      const existing = await this.prisma.cameraPilotRun.findFirst({
        where: { tenantId, idempotencyKey },
        include: { cameraSource: { select: { name: true, sourceType: true } } },
      });
      if (existing) {
        const replay = await this.resolveExistingRun(
          tenantId,
          existing as RunWithSource,
          fingerprint,
        );
        if (replay) {
          return toDetail(replay);
        }
        // Stale row failed-and-released: fall through and process fresh.
      }
    }

    // STORE CONTEXT UP FRONT (Codex P1): everything about the asset is
    // validated BEFORE any side effect — no run row, no journey, no
    // decode, no VLM work can happen for an asset that could never be
    // imported. An asset without a store context (locationId null) is
    // rejected outright: the journey import would refuse it later, after
    // a journey had already been opened.
    const internal = await this.assets.findByIdInternal(tenantId, videoAssetId);
    if (!internal || internal.deletedAt !== null) {
      throw new NotFoundException('Video asset not found in this tenant');
    }
    if (
      internal.status !== VideoAssetStatus.VALIDATED &&
      internal.status !== VideoAssetStatus.READY
    ) {
      throw new ConflictException('Replay needs a VALIDATED asset');
    }
    if (
      internal.durationMs === null ||
      internal.width === null ||
      internal.height === null
    ) {
      throw new ConflictException('Asset metadata is incomplete');
    }
    if (internal.locationId === null) {
      throw new ConflictException(
        "the video has no store context — record it against this camera's store before replaying",
      );
    }
    if (internal.locationId !== source.locationId) {
      throw new ConflictException(
        "the video's store context does not match this camera's store",
      );
    }
    if (source.unitId && internal.unitId && internal.unitId !== source.unitId) {
      throw new ConflictException(
        "the video's unit does not match this camera's unit",
      );
    }

    // LEASE OWNERSHIP (Codex P1): this attempt's token. Every heartbeat
    // and finalization write is conditional on (status RUNNING AND this
    // owner) — an attempt that lost its lease to stale reclaim can never
    // overwrite the row's later state.
    const leaseOwner = randomUUID();
    let run: CameraPilotRun;
    try {
      run = await this.prisma.cameraPilotRun.create({
        data: {
          tenantId,
          cameraSourceId,
          videoAssetId,
          frameIntervalMs,
          idempotencyKey,
          leaseOwner,
          heartbeatAt: new Date(),
          createdById: actorId ?? null,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002' &&
        idempotencyKey
      ) {
        // RACE BACKSTOP on (tenantId, idempotencyKey): the concurrent
        // winner's run is THE run — same fingerprint/staleness rules as
        // the pre-check (a fresh winner replays or reports in-progress).
        const winner = await this.prisma.cameraPilotRun.findFirst({
          where: { tenantId, idempotencyKey },
          include: {
            cameraSource: { select: { name: true, sourceType: true } },
          },
        });
        if (winner) {
          const replay = await this.resolveExistingRun(
            tenantId,
            winner as RunWithSource,
            fingerprint,
          );
          if (replay) {
            return toDetail(replay);
          }
        }
      }
      throw error;
    }

    const stageTimings: { stage: string; ms: number }[] = [];
    const errors: { stage: string; code: string }[] = [];
    const counters = {
      framesProcessed: 0,
      eventWindowsDetected: 0,
      eventWindowsProcessed: 0,
      cropFramesGenerated: 0,
      clipArtifactsGenerated: 0,
      fusionRunsCompleted: 0,
      vlmInvoked: 0,
      vlmSkipped: 0,
      vlmFailed: 0,
      journeyEventsCreated: 0,
      reviewNeeded: 0,
    };
    let windows: EventWindow[] = [];
    let journeyId: string | null = null;
    let decision: CustomerJourneyDecision | null = null;
    let failed = false;
    let leaseLost = false;

    // CONDITIONAL heartbeat (Codex P1): the beat itself is the ownership
    // probe — it updates only a row that is still RUNNING under THIS
    // attempt's token. Zero rows means the lease was reclaimed (or the
    // row finalized elsewhere): the attempt stops early and never
    // finalizes. Best-effort on transport errors — a DB hiccup must not
    // fail the pipeline (staleness handles a truly dead attempt).
    const beat = async (): Promise<void> => {
      const alive = await this.prisma.cameraPilotRun
        .updateMany({
          where: {
            id: run.id,
            tenantId,
            status: CameraPilotRunStatus.RUNNING,
            leaseOwner,
          },
          data: { heartbeatAt: new Date() },
        })
        .catch(() => null);
      if (alive !== null && alive.count === 0) {
        leaseLost = true;
      }
    };

    const stage = async <T>(
      name: string,
      work: () => Promise<T>,
    ): Promise<T | null> => {
      if (failed || leaseLost) {
        return null;
      }
      const startedAt = Date.now();
      try {
        return await work();
      } catch (error) {
        errors.push({ stage: name, code: classifyError(error) });
        if (FATAL_STAGES.has(name)) {
          failed = true;
        }
        // Log the class only — never provider/exception text into the row.
        this.logger.warn(
          `pilot run ${run.id} stage ${name} failed (${classifyError(error)})`,
        );
        return null;
      } finally {
        stageTimings.push({ stage: name, ms: Date.now() - startedAt });
        await beat();
      }
    };

    // PERIODIC lease heartbeat while a stage is in progress — a single
    // slow decode or fusion call must keep the lease alive, not just the
    // boundaries between stages. Cleared in the finally below; unref'd so
    // it can never hold the process open.
    const heartbeatTimer = setInterval(() => {
      void beat();
    }, REPLAY_HEARTBEAT_INTERVAL_MS);
    if (typeof heartbeatTimer.unref === 'function') {
      heartbeatTimer.unref();
    }

    // Narrowed once for the closures below.
    const durationMs = internal.durationMs;
    const geometry = replayGeometry({
      width: internal.width,
      height: internal.height,
    });

    // 1. Replay decode: step through the clip at the configured interval,
    //    exactly as a camera adapter would deliver frames.
    const frames = await stage('decode-frames', () =>
      this.media.decodeAnalysisFrames(
        internal.storageKey,
        1000 / frameIntervalMs,
        geometry,
        durationMs,
      ),
    );
    if (frames) {
      counters.framesProcessed = frames.length;
      // 2. Heuristic event windows inside the source's shelf zone.
      const samples = motionSamples(
        frames,
        geometry,
        parseShelfZone(source.shelfZone),
      );
      windows = extractEventWindows(samples, DEFAULT_EVENT_WINDOW_CONFIG);
      counters.eventWindowsDetected = windows.length;
    }

    // 3. Existing pickup-classical-v1 baseline (non-fatal — fusion does
    //    not depend on it).
    await stage('pickup-detection', () =>
      this.detection.detectForAsset(tenantId, videoAssetId, { force: false }),
    );

    // 4. Shadow journey opens FIRST so each window's observation can land
    //    as it is produced. No billing anywhere. ONE COHERENT SOURCE-TIME
    //    TIMELINE (Codex P1): ENTRY is anchored to the pilot run's start —
    //    the same base every observation uses — so ENTRY ≤ observations
    //    regardless of when preprocessing finished.
    await stage('journey-open', async () => {
      const created = await this.journeys.create(
        tenantId,
        { locationId: source.locationId, unitId: source.unitId },
        actorId,
        { entryAt: run.startedAt },
      );
      journeyId = created.id;
    });

    // 5. PER-WINDOW fusion + import (Codex P1): every extracted window is
    //    processed — never just the first. Each window gets its own
    //    fusion run; evidence, VLM counters, and the journey observation
    //    are bound to that EXACT run id (a concurrent replay's newer row
    //    can never be misattributed). One window's failure records a code
    //    and the NEXT window still runs. Observations are stamped
    //    relative to the PILOT RUN's start (replayStart + windowPeak) —
    //    an old upload replayed today must not predate the journey ENTRY.
    if (journeyId !== null) {
      for (const [index, window] of windows.entries()) {
        await stage(`window-${index + 1}`, async () => {
          const { runId } = await this.fusion.run(tenantId, videoAssetId, {
            window: {
              startMs: window.startMs,
              endMs: window.endMs,
              peakMs: window.peakMs,
            },
          });
          counters.fusionRunsCompleted += 1;
          const fusionRow = await this.prisma.pickupFusionRun.findFirst({
            where: { tenantId, id: runId },
            select: { id: true, evidence: true },
          });
          const evidence = fusionRow?.evidence as
            | {
                crops?: unknown[];
                vlm?: { invoked?: boolean; status?: string | null };
              }
            | undefined;
          counters.cropFramesGenerated += Array.isArray(evidence?.crops)
            ? evidence.crops.length
            : 0;
          const vlm = evidence?.vlm;
          if (vlm?.invoked === true) {
            counters.vlmInvoked += 1;
            if (vlm.status !== 'VERDICT') {
              counters.vlmFailed += 1;
            }
          } else {
            counters.vlmSkipped += 1;
          }
          // NO-DETECTION timestamps (Codex P1): if this window's fusion
          // run carries no detector peak, the observation must STILL land
          // on the replay timeline — the window's own peak (else midpoint,
          // else start), clamped to the clip — never the wall clock, which
          // can drift past the source-time EXIT when processing outruns
          // the footage.
          const fallbackPeakMs = Math.max(
            0,
            Math.min(
              Number.isFinite(window.peakMs)
                ? window.peakMs
                : Math.round((window.startMs + window.endMs) / 2),
              durationMs,
            ),
          );
          await this.journeys.appendFromFusionRun(
            tenantId,
            journeyId!,
            videoAssetId,
            actorId,
            {
              fusionRunId: runId,
              sourceTimeBase: run.startedAt,
              fallbackPeakMs,
            },
          );
          counters.eventWindowsProcessed += 1;
        });
      }
      // Windows were detected but NONE could be processed: the replay
      // accomplished nothing — fail the run instead of reporting a clean
      // empty journey.
      if (windows.length > 0 && counters.eventWindowsProcessed === 0) {
        errors.push({ stage: 'replay', code: 'NO_WINDOW_PROCESSED' });
        failed = true;
      }
    }

    // EXIT stamp on the SAME source-time base as ENTRY and observations:
    // run start + the footage's own extent (whichever is later — clip
    // duration or the last processed window) + a deterministic 1s margin.
    // Processing FASTER than the footage timeline can therefore never
    // place an observation after EXIT, and multiple windows keep their
    // relative order inside [ENTRY, EXIT].
    const lastWindowEndMs = windows.reduce(
      (max, window) => Math.max(max, window.endMs),
      0,
    );
    const exitAt = new Date(
      run.startedAt.getTime() + Math.max(durationMs, lastWindowEndMs) + 1000,
    );

    // 6. Reconcile: exit folds the basket and settles the final SHADOW
    //    decision. Zero windows is a legitimate quiet replay — the
    //    journey closes empty and clean.
    await stage('journey-exit', async () => {
      const exited = await this.journeys.exit(tenantId, journeyId!, actorId, {
        exitAt,
      });
      decision = exited.decision;
      counters.journeyEventsCreated = exited.events.filter(
        (event) => event.sourceType === 'FUSION_SHADOW',
      ).length;
      counters.reviewNeeded = exited.issues.length;
    });

    // FAILURE CLEANUP (Codex P1): a failed replay must not strand its
    // journey OPEN with only an ENTRY event. This runs OUTSIDE the
    // stage() guard on purpose — the guard suppresses all work once
    // `failed` is set, and this cleanup exists precisely for that case
    // (all windows failed, or journey-exit itself failed). The abort
    // settles the journey as decision FAILED with a controlled code.
    // Skipped when the LEASE was lost: an attempt that no longer owns
    // its run mutates nothing further (Codex P1).
    if (failed && !leaseLost && journeyId !== null) {
      try {
        const aborted = await this.journeys.abortShadowJourney(
          tenantId,
          journeyId,
          errors[errors.length - 1]?.code ?? 'REPLAY_FAILED',
          actorId,
          { exitAt },
        );
        decision = aborted.decision;
      } catch (error) {
        if (error instanceof ConflictException) {
          // Journey already closed (exit ran before the failure) — fine.
        } else {
          errors.push({ stage: 'journey-abort', code: classifyError(error) });
        }
      }
    }

    clearInterval(heartbeatTimer);

    // LEASE-SAFE finalization (Codex P1): the final write is conditional
    // on (still RUNNING + still THIS owner). Losing the condition means a
    // stale reclaim (or another finalizer) took the row while we worked —
    // the loser overwrites NOTHING and reports the row's current state.
    const readCurrent = async (): Promise<RunWithSource> => {
      const current = await this.prisma.cameraPilotRun.findFirst({
        where: { tenantId, id: run.id },
        include: { cameraSource: { select: { name: true, sourceType: true } } },
      });
      if (!current) {
        throw new NotFoundException('Pilot run not found');
      }
      return current as RunWithSource;
    };
    if (leaseLost) {
      this.logger.warn(
        `pilot run ${run.id} lost its lease mid-replay — result discarded, returning current row state`,
      );
      return toDetail(await readCurrent());
    }

    const status = failed
      ? CameraPilotRunStatus.FAILED
      : CameraPilotRunStatus.SUCCEEDED;
    const finalized = await this.prisma.cameraPilotRun.updateMany({
      where: {
        id: run.id,
        tenantId,
        status: CameraPilotRunStatus.RUNNING,
        leaseOwner,
      },
      data: {
        status,
        journeyId,
        decision,
        ...counters,
        eventWindows: windows as unknown as Prisma.InputJsonValue,
        stageTimings: stageTimings as unknown as Prisma.InputJsonValue,
        errors: errors as unknown as Prisma.InputJsonValue,
        finishedAt: new Date(),
        leaseOwner: null,
      },
    });
    if (finalized.count === 0) {
      this.logger.warn(
        `pilot run ${run.id} finalization lost the lease race — not overwriting`,
      );
      return toDetail(await readCurrent());
    }
    // Operator signal on the source row: last replay outcome, code only —
    // written only by the attempt that actually finalized the run.
    await this.prisma.cameraSource.update({
      where: { id_tenantId: { id: cameraSourceId, tenantId } },
      data: {
        lastError: failed ? (errors[errors.length - 1]?.code ?? null) : null,
      },
    });
    return toDetail(await readCurrent());
  }

  async list(tenantId: string): Promise<PilotRunView[]> {
    const runs = await this.prisma.cameraPilotRun.findMany({
      where: { tenantId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 100,
      include: { cameraSource: { select: { name: true, sourceType: true } } },
    });
    return runs.map((row) => toView(row as RunWithSource));
  }

  async byId(tenantId: string, id: string): Promise<PilotRunDetail> {
    const run = await this.prisma.cameraPilotRun.findFirst({
      where: { tenantId, id },
      include: { cameraSource: { select: { name: true, sourceType: true } } },
    });
    if (!run) {
      throw new NotFoundException('Pilot run not found');
    }
    return toDetail(run as RunWithSource);
  }
}
