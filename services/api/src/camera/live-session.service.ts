import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  CameraSourceStatus,
  CameraSourceType,
  CustomerJourneyDecision,
  CustomerJourneyEventType,
  LiveCameraSession,
  LiveCameraSessionStatus,
  Prisma,
} from '@prisma/client';
import { JourneyService } from '../journey/journey.service';
import {
  AnalysisFrame,
  AnalysisGeometry,
} from '../pickup-detection/analysis/pickup-analyzer';
import { PickupFusionService } from '../pickup-fusion/pickup-fusion.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  CameraSourcesService,
  RTSP_NEEDS_CREDENTIAL_SLOT,
} from './camera-sources.service';
import {
  DEFAULT_EVENT_WINDOW_CONFIG,
  EventWindow,
  extractEventWindows,
  motionSamples,
  parseShelfZone,
} from './event-windows';
import { RtspFrameSampler } from './rtsp/rtsp-frame-sampler';

/**
 * Phase 13 — live RTSP shadow sessions (SHADOW ONLY).
 *
 * One session = one start of a live camera: an in-process sampling loop
 * (MVP explicitly — no queues, no streaming infrastructure) pulls single
 * frames through the RTSP sampler, finds heuristic motion windows with
 * the SAME pure Phase 12 event-window code the replay runtime uses, and
 * drives each window through the EXISTING window-scoped fusion + journey
 * import path. The session owns ONE shadow journey (ENTRY at start, EXIT
 * at stop); observations land on the session's real timeline, so
 * ENTRY ≤ observations ≤ EXIT holds by construction.
 *
 * This service never talks to the VLM (only fusion does), never persists
 * raw exception text (controlled error CODES only), never returns URL or
 * credential material, and never touches checkout, order, payment, or
 * inventory tables.
 */

export const DEFAULT_LIVE_FRAME_INTERVAL_MS = 1000;
export const MIN_LIVE_FRAME_INTERVAL_MS = 500;

/** MVP safety bound: a live session auto-stops after this long — nothing
 *  in the shadow pilot may sample a stream indefinitely. */
export const MAX_LIVE_SESSION_MS = 15 * 60_000;

/** Rolling frame buffer bound — the loop's memory is fixed no matter how
 *  long the session runs. At the default 1s interval this is two minutes
 *  of context, far beyond any single shelf interaction. */
export const LIVE_FRAME_BUFFER_MAX = 120;

/** This many CONSECUTIVE sampler failures finalize the session as ERROR
 *  with the sampler's own controlled code. */
export const LIVE_MAX_CONSECUTIVE_SAMPLE_FAILURES = 5;

/** Periodic lease heartbeat, same discipline as the replay runtime. */
export const LIVE_HEARTBEAT_INTERVAL_MS = 60_000;

/** Quiet lead-in included before a window's frames when handing them to
 *  fusion — the detector needs baseline context (Phase 12 lesson). */
export const LIVE_WINDOW_LEAD_IN_MS = 1000;

/** Fixed analysis geometry the sampler is asked to deliver (even dims,
 *  matches the pickup pipeline's ~192px analysis width). */
export const LIVE_ANALYSIS_GEOMETRY: AnalysisGeometry = {
  width: 192,
  height: 108,
};

/** A persisted STARTING/RUNNING row with no in-memory loop and a
 *  heartbeat older than this is a CRASH LEFTOVER — reclaimable so the
 *  camera is not blocked forever (Codex P1). 5× the heartbeat interval:
 *  a healthy loop can never look stale. */
export const LIVE_SESSION_STALE_MS = 5 * 60_000;

/** Bound on how long stop() waits for the in-process loop to drain its
 *  in-flight window processing before failing closed (Codex P1). */
export const LIVE_STOP_DRAIN_TIMEOUT_MS = 30_000;

/**
 * Controlled error codes introduced by the Phase 13 safety hardening —
 * the ONLY strings that may land in LiveCameraSession.errorCode from
 * these paths (raw exception text never persists):
 *   LIVE_SESSION_STOPPED_DURING_START — a stop() raced startup; the
 *     freshly opened journey was aborted, never left OPEN and detached;
 *   LIVE_SESSION_STALE_RECLAIMED — a crash leftover (active row, no
 *     loop, expired heartbeat) was reclaimed and its journey closed;
 *   JOURNEY_FINALIZE_RETRY — the journey could not be closed when the
 *     session finalized; the row stays STOPPING and a later stop()
 *     retries the closure (never a terminal state over an OPEN journey);
 *   LIVE_WINDOW_DRAIN_TIMEOUT — in-flight window processing did not
 *     settle within the drain bound at stop; failed closed (abort);
 *   LIVE_WINDOW_PROCESS_FAILED — a DETECTED window's fusion/import
 *     failed; the journey is marked review-required at finalization so
 *     the session can never end READY_TO_SETTLE_SHADOW;
 *   PENDING_MOTION_AT_STOP — motion was still in progress when the
 *     session stopped; recorded as a review-required marker (journey
 *     event note), fail-closed instead of silently dropped;
 *   LIVE_SESSION_START_RECOVERY_FAILED — the startup race could neither
 *     ABORT nor LINK its freshly created journey (the same outage broke
 *     both mandatory writes); startup fails LOUDLY with a controlled
 *     error instead of reporting a terminal session over an open,
 *     unlinked journey.
 */
export const LIVE_SESSION_ERROR_CODES = [
  'LIVE_SESSION_STOPPED_DURING_START',
  'LIVE_SESSION_STALE_RECLAIMED',
  'JOURNEY_FINALIZE_RETRY',
  'LIVE_WINDOW_DRAIN_TIMEOUT',
  'LIVE_WINDOW_PROCESS_FAILED',
  'PENDING_MOTION_AT_STOP',
  'LIVE_SESSION_START_RECOVERY_FAILED',
] as const;

const STOPPED_DURING_START = 'LIVE_SESSION_STOPPED_DURING_START';
const START_RECOVERY_FAILED = 'LIVE_SESSION_START_RECOVERY_FAILED';
const STALE_RECLAIMED = 'LIVE_SESSION_STALE_RECLAIMED';
const JOURNEY_FINALIZE_RETRY = 'JOURNEY_FINALIZE_RETRY';
const WINDOW_DRAIN_TIMEOUT = 'LIVE_WINDOW_DRAIN_TIMEOUT';
const WINDOW_PROCESS_FAILED = 'LIVE_WINDOW_PROCESS_FAILED';
const PENDING_MOTION_AT_STOP = 'PENDING_MOTION_AT_STOP';

/** errorCodes whose retry path is a normal STOP finalization (exit +
 *  reconcile) rather than an abort — see stop()'s dead-loop routing. */
const STOP_INTENT_CODES: readonly string[] = [
  JOURNEY_FINALIZE_RETRY,
  WINDOW_PROCESS_FAILED,
  PENDING_MOTION_AT_STOP,
];

/** errorCodes that require a durable REVIEW_REQUIRED journey marker to
 *  exist BEFORE the journey may exit (Codex P1: a dropped or pending
 *  interaction must be visible to reconciliation; the exit may only run
 *  once the marker is in). finalizeStopped appends the marker
 *  idempotently on every retry until it lands. */
const MARKER_CODES: readonly string[] = [
  WINDOW_PROCESS_FAILED,
  PENDING_MOTION_AT_STOP,
];

/**
 * WRITE CLASSIFICATION (Codex P1, round 3). Every DB write in this
 * service is one of:
 *   A. BEST-EFFORT — heartbeats and pure metric persists (framesSampled,
 *      lastFrameAt, rolling counters): a transient failure merely lets
 *      the lease age toward stale-reclaim, which is itself the safety
 *      net. These may catch-and-continue.
 *   B. MANDATORY SAFETY WRITES — the journey link after creation,
 *      abort/exit intent state, the failed-window marker/retry state,
 *      the pending-motion marker/retry state, stale-reclaim cleanup, the
 *      terminal status after journey closure, and ownership handoff. A
 *      failure here STOPS the flow: the session parks retryable when the
 *      park itself can land; otherwise the row is left OWNED and
 *      non-terminal so heartbeat staleness hands it to the reclaim path.
 *      Never a swallowed failure that lets finalization continue, and
 *      never a terminal state over an OPEN journey.
 */

const ACTIVE_SESSION_STATUSES: LiveCameraSessionStatus[] = [
  LiveCameraSessionStatus.STARTING,
  LiveCameraSessionStatus.RUNNING,
];

const NON_TERMINAL_SESSION_STATUSES: LiveCameraSessionStatus[] = [
  LiveCameraSessionStatus.STARTING,
  LiveCameraSessionStatus.RUNNING,
  LiveCameraSessionStatus.STOPPING,
];

export interface LiveSessionView {
  sessionId: string;
  cameraSourceId: string;
  cameraSourceName: string | null;
  sourceType: CameraSourceType | null;
  journeyId: string | null;
  status: LiveCameraSessionStatus;
  frameIntervalMs: number;
  startedAt: Date;
  stoppedAt: Date | null;
  heartbeatAt: Date | null;
  lastFrameAt: Date | null;
  framesSampled: number;
  eventWindowsDetected: number;
  eventWindowsProcessed: number;
  fusionRunsCompleted: number;
  journeyEventsCreated: number;
  vlmInvoked: number;
  vlmSkipped: number;
  vlmFailed: number;
  reviewNeeded: number;
  decision: CustomerJourneyDecision | null;
  /** Controlled code only — raw exception text is never persisted. */
  errorCode: string | null;
}

export interface LiveSessionDetail extends LiveSessionView {
  eventWindows: EventWindow[];
}

type SessionWithSource = LiveCameraSession & {
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

function toView(session: SessionWithSource): LiveSessionView {
  return {
    sessionId: session.id,
    cameraSourceId: session.cameraSourceId,
    cameraSourceName: session.cameraSource?.name ?? null,
    sourceType: session.cameraSource?.sourceType ?? null,
    journeyId: session.journeyId,
    status: session.status,
    frameIntervalMs: session.frameIntervalMs,
    startedAt: session.startedAt,
    stoppedAt: session.stoppedAt,
    heartbeatAt: session.heartbeatAt,
    lastFrameAt: session.lastFrameAt,
    framesSampled: session.framesSampled,
    eventWindowsDetected: session.eventWindowsDetected,
    eventWindowsProcessed: session.eventWindowsProcessed,
    fusionRunsCompleted: session.fusionRunsCompleted,
    journeyEventsCreated: session.journeyEventsCreated,
    vlmInvoked: session.vlmInvoked,
    vlmSkipped: session.vlmSkipped,
    vlmFailed: session.vlmFailed,
    reviewNeeded: session.reviewNeeded,
    decision: session.decision,
    errorCode: session.errorCode,
  };
}

function toDetail(session: SessionWithSource): LiveSessionDetail {
  return {
    ...toView(session),
    eventWindows: Array.isArray(session.eventWindows)
      ? (session.eventWindows as unknown as EventWindow[])
      : [],
  };
}

const SOURCE_INCLUDE = {
  cameraSource: { select: { name: true, sourceType: true } },
} as const;

@Injectable()
export class LiveSessionService {
  private readonly logger = new Logger(LiveSessionService.name);

  /** In-process loop controllers — stop() signals through here when the
   *  loop is alive in THIS process. */
  private readonly loops = new Map<string, { stopRequested: boolean }>();

  /** Loop completion promises — a TEST HOOK ONLY (awaitLoop), never part
   *  of the request path. */
  private readonly loopPromises = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly sources: CameraSourcesService,
    private readonly sampler: RtspFrameSampler,
    private readonly fusion: PickupFusionService,
    private readonly journeys: JourneyService,
  ) {}

  /** Overridable for deterministic specs. */
  protected now(): Date {
    return new Date();
  }

  /** Overridable for deterministic specs. */
  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }
    });
  }

  /** TEST HOOK: await a detached sampling loop's completion. */
  async awaitLoop(sessionId: string): Promise<void> {
    await this.loopPromises.get(sessionId);
  }

  async start(
    tenantId: string,
    cameraSourceId: string,
    input: { frameIntervalMs?: number | null },
    actorId?: string,
  ): Promise<LiveSessionDetail> {
    const source = await this.sources.requireSource(tenantId, cameraSourceId);
    if (source.sourceType !== CameraSourceType.RTSP_SHADOW) {
      throw new ConflictException(
        'live sessions need an RTSP_SHADOW camera source',
      );
    }
    if (source.status !== CameraSourceStatus.ACTIVE) {
      throw new ConflictException('camera source is not ACTIVE');
    }
    if (source.credentialRef === null) {
      throw new ConflictException(RTSP_NEEDS_CREDENTIAL_SLOT);
    }
    // IDEMPOTENT-SAFE start: an already-active session for this source IS
    // the answer — no second session, no second journey. But an active
    // ROW with no loop and an expired heartbeat is a crash leftover
    // (Codex P1): reclaim it atomically so the camera is not blocked
    // forever, close its journey, and only then start fresh.
    const active = await this.prisma.liveCameraSession.findFirst({
      where: {
        tenantId,
        cameraSourceId,
        status: { in: ACTIVE_SESSION_STATUSES },
      },
      include: SOURCE_INCLUDE,
    });
    if (active) {
      if (this.loops.has(active.id)) {
        return toDetail(active as SessionWithSource);
      }
      const heartbeatMs = (active.heartbeatAt ?? active.startedAt).getTime();
      if (this.now().getTime() - heartbeatMs < LIVE_SESSION_STALE_MS) {
        // Fresh heartbeat, no LOCAL loop — a loop may live in another
        // process. Conservative: never reclaim a possibly-live session.
        return toDetail(active as SessionWithSource);
      }
      const reclaimed = await this.reclaimStaleSession(
        tenantId,
        active as SessionWithSource,
        actorId,
      );
      if (!reclaimed) {
        // Lost the reclaim race (a real loop beat us, or another start
        // reclaimed first) — the row's CURRENT state is the answer.
        return this.byId(tenantId, active.id);
      }
      // Reclaim complete (terminal ERROR, journey closed): fall through
      // to a fresh start — the partial unique is free again.
    }
    // Runtime preconditions BEFORE any side effect. Controlled codes only.
    if (!this.sampler.resolveSource(tenantId, source.credentialRef).configured) {
      throw new ConflictException(
        'RTSP source is not configured in this environment ' +
          '(RTSP_SOURCE_NOT_CONFIGURED)',
      );
    }
    if (!(await this.sampler.checkFfmpeg())) {
      throw new ConflictException(
        'frame sampling is unavailable in this environment ' +
          '(RTSP_UNSUPPORTED_IN_ENV)',
      );
    }
    const frameIntervalMs =
      input.frameIntervalMs ?? DEFAULT_LIVE_FRAME_INTERVAL_MS;

    // LEASE OWNERSHIP: this attempt's token — every later write is
    // conditional on (non-terminal status AND this owner).
    const leaseOwner = randomUUID();
    let session: LiveCameraSession;
    try {
      session = await this.prisma.liveCameraSession.create({
        data: {
          tenantId,
          cameraSourceId,
          frameIntervalMs,
          leaseOwner,
          heartbeatAt: this.now(),
          createdById: actorId ?? null,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        // RACE BACKSTOP: the partial unique (one non-terminal session per
        // source) means a concurrent start won — its session is THE
        // session.
        const winner = await this.prisma.liveCameraSession.findFirst({
          where: {
            tenantId,
            cameraSourceId,
            status: { in: NON_TERMINAL_SESSION_STATUSES },
          },
          include: SOURCE_INCLUDE,
        });
        if (winner) {
          return toDetail(winner as SessionWithSource);
        }
      }
      throw error;
    }

    // Open the session's shadow journey. ENTRY is anchored to the session
    // start — the same base every live observation uses. A failure AFTER
    // the row exists finalizes ERROR and aborts the journey if it opened:
    // no orphan OPEN journey, no RUNNING ghost row.
    let journeyId: string | null = null;
    try {
      const journey = await this.journeys.create(
        tenantId,
        { locationId: source.locationId, unitId: source.unitId },
        actorId,
        { entryAt: session.startedAt },
      );
      journeyId = journey.id;
      // LINK FIRST, promote second (Codex P1): the journeyId lands with
      // an ownership-conditional write BEFORE anything else happens. If a
      // racing stop() finalized the STARTING row in the meantime, the
      // link write matches nothing — the fresh journey is then explicitly
      // ABORTED, never returned OPEN and detached from any session.
      const linked = await this.prisma.liveCameraSession.updateMany({
        where: {
          id: session.id,
          tenantId,
          status: LiveCameraSessionStatus.STARTING,
          leaseOwner,
        },
        data: { journeyId },
      });
      if (linked.count === 0) {
        try {
          await this.journeys.abortShadowJourney(
            tenantId,
            journeyId,
            STOPPED_DURING_START,
            actorId,
            { exitAt: this.now() },
          );
        } catch (abortError) {
          if (!(abortError instanceof ConflictException)) {
            // The abort itself failed (Codex P1): the fresh journey must
            // not float OPEN and detached. The LINK is now the MANDATORY
            // write (classification B) — a later stop() finds the journey
            // through it and re-runs the abort. The journeyId-null guard
            // means a racing finalizer that already linked/closed
            // something else is never overwritten. If the link cannot be
            // persisted either, startup FAILS LOUDLY — never a terminal
            // success over an open, unlinked journey.
            this.logger.warn(
              `live session ${session.id} could not abort its raced ` +
                `startup journey (${classifyError(abortError)}) — linking ` +
                `for retry`,
            );
            let recovered = false;
            try {
              const fallback = await this.prisma.liveCameraSession.updateMany(
                {
                  where: { id: session.id, tenantId, journeyId: null },
                  data: {
                    journeyId,
                    status: LiveCameraSessionStatus.STOPPING,
                    errorCode: STOPPED_DURING_START,
                    leaseOwner: null,
                  },
                },
              );
              if (fallback.count > 0) {
                recovered = true;
              } else {
                // Guard miss: the row already carries a journeyId. Only
                // this start ever writes this session's link, so a set
                // link IS this journey — durable, recovered.
                const current = await this.prisma.liveCameraSession.findFirst(
                  { where: { id: session.id, tenantId } },
                );
                recovered = current?.journeyId != null;
              }
            } catch {
              recovered = false;
            }
            if (!recovered) {
              // Best-effort code stamp; the THROW below is the actual
              // safety mechanism (controlled code, no raw detail, no
              // terminal-success return).
              await this.prisma.liveCameraSession
                .updateMany({
                  where: { id: session.id, tenantId },
                  data: { errorCode: START_RECOVERY_FAILED },
                })
                .catch(() => null);
              throw new InternalServerErrorException(
                'live session startup could not record its journey — ' +
                  `retry (${START_RECOVERY_FAILED})`,
              );
            }
          }
        }
        return this.byId(tenantId, session.id);
      }
      const promoted = await this.prisma.liveCameraSession.updateMany({
        where: {
          id: session.id,
          tenantId,
          status: LiveCameraSessionStatus.STARTING,
          leaseOwner,
        },
        data: { status: LiveCameraSessionStatus.RUNNING },
      });
      if (promoted.count === 0) {
        // A stop() raced between link and promote. The journey IS linked,
        // but the racing finalizer may have read the row BEFORE the link
        // landed (and closed nothing) — abort it ourselves; if the
        // finalizer did close it first, this conflicts harmlessly.
        try {
          await this.journeys.abortShadowJourney(
            tenantId,
            journeyId,
            STOPPED_DURING_START,
            actorId,
            { exitAt: this.now() },
          );
        } catch (abortError) {
          if (!(abortError instanceof ConflictException)) {
            // Journey linked but open and unabortable right now (Codex
            // P1): park RETRYABLE — never leave a terminal row over an
            // OPEN linked journey.
            this.logger.warn(
              `live session ${session.id} could not abort its raced ` +
                `startup journey (${classifyError(abortError)}) — parked ` +
                `for retry`,
            );
            try {
              await this.prisma.liveCameraSession.updateMany({
                where: { id: session.id, tenantId },
                data: {
                  status: LiveCameraSessionStatus.STOPPING,
                  errorCode: STOPPED_DURING_START,
                  leaseOwner: null,
                },
              });
            } catch (parkError) {
              // BEST-EFFORT here (see WRITE CLASSIFICATION): the journey
              // is already DURABLY LINKED, and every terminal write in
              // this service CASes on journeyId-as-read — a racing
              // finalizer that read the row before the link cannot
              // terminalize it. The row therefore stays non-terminal and
              // stop() finds the journey through the link; this park
              // merely routes the retry sooner.
              this.logger.warn(
                `live session ${session.id} could not park after the ` +
                  `promote race (${classifyError(parkError)}) — the ` +
                  `linked journey keeps the row retryable`,
              );
            }
          }
        }
        return this.byId(tenantId, session.id);
      }
    } catch (error) {
      if (error instanceof InternalServerErrorException) {
        // Startup recovery already exhausted its mandatory writes (link
        // AND abort both failed) — propagate LOUDLY; there is nothing
        // left to finalize safely.
        throw error;
      }
      await this.finalizeError(
        tenantId,
        session.id,
        classifyError(error),
        actorId,
        { leaseOwner, journeyId },
      );
      if (error instanceof ConflictException || error instanceof NotFoundException) {
        throw error;
      }
      this.logger.warn(
        `live session ${session.id} failed to start (${classifyError(error)})`,
      );
      throw new ConflictException('live session failed to start');
    }

    // Detached in-process loop — the MVP runtime.
    const loopPromise = this.runLoop(
      tenantId,
      session.id,
      leaseOwner,
      {
        cameraSourceId,
        credentialRef: source.credentialRef,
        locationId: source.locationId,
        unitId: source.unitId,
        shelfZone: source.shelfZone,
        journeyId,
        frameIntervalMs,
        startedAt: session.startedAt,
      },
      actorId,
    ).catch((error) => {
      this.logger.error(
        `live session ${session.id} loop crashed (${classifyError(error)})`,
      );
      return this.finalizeError(
        tenantId,
        session.id,
        'LIVE_LOOP_FAILED',
        actorId,
        { leaseOwner, journeyId },
      ).catch(() => undefined);
    });
    this.loopPromises.set(
      session.id,
      loopPromise.then(() => undefined),
    );

    return this.byId(tenantId, session.id);
  }

  /**
   * Reclaim a crash-leftover session (Codex P1): active row, no local
   * loop, heartbeat expired. The claim is an ATOMIC conditional write on
   * (active status AND expired heartbeat) — a still-live loop in another
   * process keeps beating and the claim matches nothing. The claim moves
   * the row to STOPPING (unique still held) so the journey is closed
   * BEFORE the terminal write frees the camera; a journey-closure failure
   * leaves the row STOPPING for stop()'s retry path instead of
   * terminalizing over an OPEN journey. Returns true when fully
   * reclaimed (caller may start fresh).
   */
  private async reclaimStaleSession(
    tenantId: string,
    session: SessionWithSource,
    actorId?: string,
  ): Promise<boolean> {
    const cutoff = new Date(this.now().getTime() - LIVE_SESSION_STALE_MS);
    const claimed = await this.prisma.liveCameraSession.updateMany({
      where: {
        id: session.id,
        tenantId,
        status: { in: ACTIVE_SESSION_STATUSES },
        OR: [
          { heartbeatAt: { lt: cutoff } },
          { heartbeatAt: null, startedAt: { lt: cutoff } },
        ],
      },
      data: {
        status: LiveCameraSessionStatus.STOPPING,
        errorCode: STALE_RECLAIMED,
        leaseOwner: null,
      },
    });
    if (claimed.count === 0) {
      return false;
    }
    // FRESH ROW, not the pre-claim snapshot (Codex P1): the original
    // starter may have LINKED its journey between our read and the claim
    // winning — deciding cleanup from the stale snapshot would skip the
    // closure and orphan that journey.
    const fresh = await this.prisma.liveCameraSession.findFirst({
      where: { id: session.id, tenantId },
      select: { journeyId: true },
    });
    const journeyId = fresh?.journeyId ?? null;
    let decision: CustomerJourneyDecision | null = null;
    if (journeyId) {
      try {
        const aborted = await this.journeys.abortShadowJourney(
          tenantId,
          journeyId,
          STALE_RECLAIMED,
          actorId,
          { exitAt: this.now() },
        );
        decision = aborted.decision;
      } catch (error) {
        if (error instanceof ConflictException) {
          // Already closed — read back whatever it settled on.
          const detail = await this.journeys
            .detail(tenantId, journeyId)
            .catch(() => null);
          decision = detail?.decision ?? null;
        } else {
          this.logger.warn(
            `stale live session ${session.id} journey abort failed ` +
              `(${classifyError(error)}) — left STOPPING for retry`,
          );
          return false;
        }
      }
    }
    await this.prisma.liveCameraSession.updateMany({
      where: {
        id: session.id,
        tenantId,
        status: LiveCameraSessionStatus.STOPPING,
        // CAS on the journey link: a link that lands after our re-read
        // voids this terminal write, leaving the row STOPPING for retry.
        journeyId,
      },
      data: {
        status: LiveCameraSessionStatus.ERROR,
        stoppedAt: this.now(),
        decision,
      },
    });
    return true;
  }

  private async runLoop(
    tenantId: string,
    sessionId: string,
    leaseOwner: string,
    context: {
      cameraSourceId: string;
      credentialRef: string;
      locationId: string;
      unitId: string | null;
      shelfZone: string | null;
      journeyId: string | null;
      frameIntervalMs: number;
      startedAt: Date;
    },
    actorId?: string,
  ): Promise<void> {
    const controller = { stopRequested: false };
    this.loops.set(sessionId, controller);
    const zone = parseShelfZone(context.shelfZone);
    const buffer: AnalysisFrame[] = [];
    const processedWindows: EventWindow[] = [];
    const counters = {
      framesSampled: 0,
      eventWindowsDetected: 0,
      eventWindowsProcessed: 0,
      fusionRunsCompleted: 0,
      journeyEventsCreated: 0,
      vlmInvoked: 0,
      vlmSkipped: 0,
      vlmFailed: 0,
      reviewNeeded: 0,
    };
    let frameIndex = 0;
    let consecutiveFailures = 0;
    /** Cooldown watermark: windows ending at/before this are done. */
    let processedUpToMs = 0;
    let leaseLost = false;
    let errorCode: string | null = null;
    const startedAtMs = context.startedAt.getTime();

    // RUNNING or STOPPING: a stop() moves the row to STOPPING while the
    // loop drains — counter persists from the draining loop must still
    // land (Codex P1: counters persist before STOPPED).
    const LOOP_WRITABLE_STATUSES = [
      LiveCameraSessionStatus.RUNNING,
      LiveCameraSessionStatus.STOPPING,
    ];
    // The beat is the ownership probe AND the CROSS-PROCESS STOP CHANNEL
    // (Codex P1 round 3): it renews the lease ONLY while the row is
    // RUNNING. A stop endpoint in ANY process marks the row STOPPING
    // while keeping this loop's leaseOwner — the next beat matches
    // nothing, re-reads, recognizes its OWN lease on a STOPPING row as a
    // stop REQUEST, and this loop drains + finalizes as the owner. Any
    // other mismatch (foreign owner, terminal, gone) is a LOST lease:
    // the loop halts with no finalization of its own. Transport failures
    // stay best-effort (classification A) — an unrenewed lease ages into
    // stale-reclaim, which is the safety net.
    const beat = async (): Promise<void> => {
      try {
        const alive = await this.prisma.liveCameraSession.updateMany({
          where: {
            id: sessionId,
            tenantId,
            status: LiveCameraSessionStatus.RUNNING,
            leaseOwner,
          },
          data: { heartbeatAt: this.now() },
        });
        if (alive.count > 0) {
          return;
        }
        const row = await this.prisma.liveCameraSession.findFirst({
          where: { id: sessionId, tenantId },
        });
        if (
          row &&
          row.status === LiveCameraSessionStatus.STOPPING &&
          row.leaseOwner === leaseOwner
        ) {
          // External stop request: drain and finalize as the owner,
          // keeping the lease fresh through the drain so a stale-claimer
          // cannot steal the row mid-finalization.
          controller.stopRequested = true;
          await this.prisma.liveCameraSession.updateMany({
            where: {
              id: sessionId,
              tenantId,
              status: LiveCameraSessionStatus.STOPPING,
              leaseOwner,
            },
            data: { heartbeatAt: this.now() },
          });
          return;
        }
        leaseLost = true;
      } catch {
        // Best-effort: retried on the next beat; staleness backstops.
      }
    };
    const heartbeatTimer = setInterval(() => {
      void beat();
    }, LIVE_HEARTBEAT_INTERVAL_MS);
    if (typeof heartbeatTimer.unref === 'function') {
      heartbeatTimer.unref();
    }

    /** Persist the loop's counters — conditional on ownership, absolute
     *  values (no read-modify-write races with ourselves). */
    const persist = async (
      extra: Record<string, unknown> = {},
    ): Promise<void> => {
      const written = await this.prisma.liveCameraSession
        .updateMany({
          where: {
            id: sessionId,
            tenantId,
            status: { in: LOOP_WRITABLE_STATUSES },
            leaseOwner,
          },
          data: {
            ...counters,
            eventWindows:
              processedWindows as unknown as Prisma.InputJsonValue,
            heartbeatAt: this.now(),
            ...extra,
          },
        })
        .catch(() => null);
      if (written !== null && written.count === 0) {
        leaseLost = true;
      }
    };

    /** Unpersisted MANDATORY failure code (classification B): while set,
     *  normal finalization is BLOCKED — the loop retries the durable
     *  write every iteration, and at exit it must park or leave the row
     *  owned for stale reclaim. Never silently discarded. */
    let unpersistedFailure: string | null = null;

    /** MANDATORY failed-window write: a DETECTED window whose processing
     *  failed must be durably visible (errorCode → review marker before
     *  exit). A write failure keeps the in-memory flag set; a lost lease
     *  clears our obligation (the new owner's reclaim aborts the journey
     *  — fail-closed by a different route). */
    const recordWindowFailure = async (): Promise<void> => {
      try {
        const written = await this.prisma.liveCameraSession.updateMany({
          where: {
            id: sessionId,
            tenantId,
            status: { in: LOOP_WRITABLE_STATUSES },
            leaseOwner,
          },
          data: { errorCode: WINDOW_PROCESS_FAILED },
        });
        if (written.count === 0) {
          leaseLost = true;
        }
        unpersistedFailure = null;
      } catch {
        unpersistedFailure = WINDOW_PROCESS_FAILED;
      }
    };

    /** Process one CLOSED window: watermark, counters, fusion + import;
     *  a failure fails CLOSED (durable code — finalization then marks the
     *  journey review-required, so a dropped interaction can never end
     *  READY_TO_SETTLE_SHADOW). Shared by the in-loop pass and the final
     *  sweep at stop. */
    const handleClosedWindow = async (window: EventWindow): Promise<void> => {
      processedUpToMs = window.endMs;
      counters.eventWindowsDetected += 1;
      processedWindows.push(window);
      await this.processWindow(
        tenantId,
        sessionId,
        context,
        buffer,
        window,
        counters,
        actorId,
      ).catch(async (error) => {
        this.logger.warn(
          `live session ${sessionId} window failed (${classifyError(error)})`,
        );
        await recordWindowFailure();
      });
      await persist();
    };

    /** Park the row in the RETRYABLE state (STOPPING + code) — stop() is
     *  the retry entry that resumes marker append + journey closure.
     *  MANDATORY when invoked (classification B): returns true ONLY when
     *  the retry state actually persisted; callers must stop the flow on
     *  false, never continue into a normal finalization. */
    const parkForRetry = async (code: string): Promise<boolean> => {
      try {
        const parked = await this.prisma.liveCameraSession.updateMany({
          where: {
            id: sessionId,
            tenantId,
            status: { in: NON_TERMINAL_SESSION_STATUSES },
            leaseOwner,
          },
          data: {
            status: LiveCameraSessionStatus.STOPPING,
            errorCode: code,
            leaseOwner: null,
          },
        });
        return parked.count > 0;
      } catch {
        return false;
      }
    };

    // The CONTROLLER stays registered until finalization completes or
    // parks retryable (Codex P1): a concurrent stop() during post-loop
    // persist / sweep / marker / finalize must AWAIT this loop's own
    // finalization, never take the dead-loop path and double-finalize.
    try {
      for (;;) {
        if (controller.stopRequested || leaseLost) {
          break;
        }
        if (this.now().getTime() - startedAtMs >= MAX_LIVE_SESSION_MS) {
          // MVP safety bound — normal stop path.
          break;
        }
        if (unpersistedFailure) {
          // MANDATORY write retry (Codex P1 round 3): the failed-window
          // state must land before this loop may ever finalize normally.
          await recordWindowFailure();
        }
        const sampled = await this.sampler.sampleFrame(
          tenantId,
          context.credentialRef,
          {
            width: LIVE_ANALYSIS_GEOMETRY.width,
            height: LIVE_ANALYSIS_GEOMETRY.height,
            timeoutMs: Math.min(context.frameIntervalMs * 2, 10_000),
          },
        );
        if (sampled.ok) {
          // The sampled frame ALWAYS lands, even when a stop arrived while
          // sampling (Codex P1): a quiet frame may be the one that CLOSES
          // a motion burst — dropping it would vanish the interaction.
          consecutiveFailures = 0;
          const timestampMs = this.now().getTime() - startedAtMs;
          buffer.push({
            index: frameIndex,
            timestampMs,
            rgb: sampled.image.rgb,
          });
          frameIndex += 1;
          if (buffer.length > LIVE_FRAME_BUFFER_MAX) {
            buffer.shift();
          }
          counters.framesSampled += 1;
          await persist({ lastFrameAt: this.now() });

          // Heuristic windows over the rolling buffer. Only CLOSED
          // windows (quiet again before the newest sample) are processed;
          // the watermark is the cooldown — a window overlapping an
          // already-processed range is the same physical interaction.
          // Closed windows are processed even under a stop request; only
          // a LOST LEASE halts mid-pass (someone else owns the row).
          const samples = motionSamples(buffer, LIVE_ANALYSIS_GEOMETRY, zone);
          const lastSampleMs = samples[samples.length - 1]?.timestampMs ?? 0;
          for (const window of extractEventWindows(
            samples,
            DEFAULT_EVENT_WINDOW_CONFIG,
          )) {
            if (leaseLost) {
              break;
            }
            if (window.startMs <= processedUpToMs) {
              continue;
            }
            if (window.endMs >= lastSampleMs) {
              continue; // still open — wait for the burst to end
            }
            await handleClosedWindow(window);
          }
        } else {
          consecutiveFailures += 1;
          if (consecutiveFailures >= LIVE_MAX_CONSECUTIVE_SAMPLE_FAILURES) {
            errorCode = sampled.code;
            break;
          }
        }
        if (controller.stopRequested || leaseLost) {
          break;
        }
        await this.sleep(context.frameIntervalMs);
        await beat();
      }

      if (leaseLost) {
        this.logger.warn(
          `live session ${sessionId} lost its lease — loop stopped without finalizing`,
        );
        return;
      }
      await persist();
      if (leaseLost) {
        this.logger.warn(
          `live session ${sessionId} lost its lease — loop stopped without finalizing`,
        );
        return;
      }
      if (errorCode) {
        try {
          await this.finalizeError(tenantId, sessionId, errorCode, actorId, {
            leaseOwner,
            journeyId: context.journeyId,
          });
        } catch (finalizeErr) {
          // Same rule as the stopped path: an escaping finalization write
          // failure leaves the row owned + non-terminal for stale reclaim.
          this.logger.error(
            `live session ${sessionId} error finalization write failed ` +
              `(${classifyError(finalizeErr)}) — left owned for stale ` +
              `reclaim`,
          );
        }
        return;
      }
      // FINAL SWEEP (Codex P1): a window the newest quiet frame CLOSED
      // just as the stop arrived must not be skipped — process every
      // remaining closed window before finalization.
      const exitSamples = motionSamples(buffer, LIVE_ANALYSIS_GEOMETRY, zone);
      const trailing = exitSamples[exitSamples.length - 1];
      const lastMs = trailing?.timestampMs ?? 0;
      for (const window of extractEventWindows(
        exitSamples,
        DEFAULT_EVENT_WINDOW_CONFIG,
      )) {
        if (leaseLost) {
          break;
        }
        if (window.startMs <= processedUpToMs) {
          continue;
        }
        if (window.endMs >= lastMs) {
          continue; // open at the newest sample — pending-motion below
        }
        await handleClosedWindow(window);
      }
      if (leaseLost) {
        return;
      }
      // PENDING MOTION AT STOP (Codex P1): an interaction still in
      // progress when the session ends (manual stop or auto-stop) has no
      // closed window yet — it must not vanish. Fail closed: a DURABLE
      // review-required marker lands on the journey BEFORE the exit, so
      // reconciliation can never see READY_TO_SETTLE_SHADOW over a
      // dropped burst. If the marker cannot be recorded, the session
      // parks RETRYABLE — it never proceeds to a normal exit.
      const openBurst =
        (trailing !== undefined &&
          trailing.motionScore >= DEFAULT_EVENT_WINDOW_CONFIG.minScore) ||
        extractEventWindows(exitSamples, DEFAULT_EVENT_WINDOW_CONFIG).some(
          (window) =>
            window.endMs > processedUpToMs && window.endMs >= lastMs,
        );
      if (openBurst && context.journeyId) {
        try {
          const appended = await this.ensureReviewMarker(
            tenantId,
            context.journeyId,
            PENDING_MOTION_AT_STOP,
            new Date(startedAtMs + lastMs),
            actorId,
          );
          if (appended) {
            counters.reviewNeeded += 1;
            await persist();
          }
        } catch (error) {
          if (error instanceof ConflictException) {
            // Journey already closed by a competing finalizer — the exit
            // below reads its decision back.
          } else {
            this.logger.warn(
              `live session ${sessionId} could not record pending motion ` +
                `(${classifyError(error)}) — parking for retry`,
            );
            const parked = await parkForRetry(PENDING_MOTION_AT_STOP);
            if (!parked) {
              // MANDATORY retry state could not persist either (Codex P1
              // round 3): leave the row OWNED and non-terminal — the
              // aging lease hands it to stale reclaim, which aborts the
              // journey (fail-closed). Never continue into a normal exit.
              this.logger.error(
                `live session ${sessionId} could not persist its ` +
                  `pending-motion retry state — left owned for stale ` +
                  `reclaim`,
              );
            }
            return;
          }
        }
      }
      if (unpersistedFailure) {
        // Last landing attempt for the failed-window state, then park —
        // a normal exit over an unrecorded dropped interaction is
        // forbidden (Codex P1 round 3).
        await recordWindowFailure();
      }
      if (unpersistedFailure) {
        const parked = await parkForRetry(unpersistedFailure);
        if (!parked) {
          this.logger.error(
            `live session ${sessionId} could not persist its ` +
              `failed-window state — left owned for stale reclaim`,
          );
        }
        return;
      }
      try {
        await this.finalizeStopped(tenantId, sessionId, actorId, {
          leaseOwner,
        });
      } catch (finalizeError) {
        // A finalization write itself failed (classification B): the
        // internal paths already park where they can — an ESCAPING throw
        // means even the park write failed. Leave the row owned and
        // non-terminal for stale reclaim; never report or continue as
        // finalized.
        this.logger.error(
          `live session ${sessionId} finalization write failed ` +
            `(${classifyError(finalizeError)}) — left owned for stale ` +
            `reclaim`,
        );
      }
    } finally {
      clearInterval(heartbeatTimer);
      this.loops.delete(sessionId);
    }
  }

  /**
   * Idempotently ensure a REVIEW_REQUIRED marker with the given code
   * exists on the journey (tenant-scoped read through the journey
   * service). Returns true when a NEW marker was appended. Throws when
   * the append fails — callers park the session for stop()'s retry.
   */
  private async ensureReviewMarker(
    tenantId: string,
    journeyId: string,
    code: string,
    occurredAt: Date,
    actorId?: string,
  ): Promise<boolean> {
    const detail = await this.journeys.detail(tenantId, journeyId);
    const exists = detail.events.some(
      (event) =>
        event.eventType === CustomerJourneyEventType.REVIEW_REQUIRED &&
        event.sourceType === 'LIVE_SHADOW' &&
        event.note === code,
    );
    if (exists) {
      return false;
    }
    await this.journeys.appendEvent(
      tenantId,
      journeyId,
      {
        eventType: CustomerJourneyEventType.REVIEW_REQUIRED,
        occurredAt: occurredAt.toISOString(),
        sourceType: 'LIVE_SHADOW',
        note: code,
      },
      actorId,
    );
    return true;
  }

  /** One closed window → window-scoped fusion → exact-run journey import.
   *  VLM counters follow the pilot-run rule: invoked with a VERDICT is a
   *  clean invocation; invoked with any error status counts invoked AND
   *  failed; not invoked is skipped. */
  private async processWindow(
    tenantId: string,
    sessionId: string,
    context: {
      locationId: string;
      unitId: string | null;
      journeyId: string | null;
      frameIntervalMs: number;
      startedAt: Date;
    },
    buffer: AnalysisFrame[],
    window: EventWindow,
    counters: {
      eventWindowsProcessed: number;
      fusionRunsCompleted: number;
      journeyEventsCreated: number;
      vlmInvoked: number;
      vlmSkipped: number;
      vlmFailed: number;
      reviewNeeded: number;
    },
    actorId?: string,
  ): Promise<void> {
    const frames = buffer
      .filter(
        (frame) =>
          frame.timestampMs >= window.startMs - LIVE_WINDOW_LEAD_IN_MS &&
          frame.timestampMs <= window.endMs + context.frameIntervalMs,
      )
      .map((frame) => ({
        timestampMs: frame.timestampMs,
        image: {
          width: LIVE_ANALYSIS_GEOMETRY.width,
          height: LIVE_ANALYSIS_GEOMETRY.height,
          rgb: frame.rgb,
        },
      }));
    const { runId } = await this.fusion.runLiveWindow(tenantId, {
      liveSessionId: sessionId,
      locationId: context.locationId,
      unitId: context.unitId,
      frames,
      window: {
        startMs: window.startMs,
        endMs: window.endMs,
        peakMs: window.peakMs,
      },
    });
    counters.fusionRunsCompleted += 1;
    const runRow = await this.prisma.pickupFusionRun.findFirst({
      where: { tenantId, id: runId },
      select: { evidence: true },
    });
    const vlm = (
      runRow?.evidence as
        | { vlm?: { invoked?: boolean; status?: string | null } }
        | undefined
    )?.vlm;
    if (vlm?.invoked === true) {
      counters.vlmInvoked += 1;
      if (vlm.status !== 'VERDICT') {
        counters.vlmFailed += 1;
      }
    } else {
      counters.vlmSkipped += 1;
    }
    if (context.journeyId) {
      const detail = await this.journeys.appendFromLiveFusionRun(
        tenantId,
        context.journeyId,
        runId,
        actorId,
        {
          sourceTimeBase: context.startedAt,
          fallbackPeakMs: window.peakMs,
        },
      );
      counters.journeyEventsCreated = detail.events.filter(
        (event) => event.sourceType === 'LIVE_SHADOW',
      ).length;
      counters.reviewNeeded = detail.issues.length;
    }
    counters.eventWindowsProcessed += 1;
  }

  /**
   * Normal finalization: exit + reconcile the journey, then a CONDITIONAL
   * status write. `force` (stop endpoint / process-restart path) takes
   * over regardless of the lease owner; the loop's own call stays
   * owner-conditional so a takeover always wins.
   */
  private async finalizeStopped(
    tenantId: string,
    sessionId: string,
    actorId?: string,
    options?: { leaseOwner?: string },
  ): Promise<void> {
    const session = await this.prisma.liveCameraSession.findFirst({
      where: { tenantId, id: sessionId },
    });
    if (
      !session ||
      session.status === LiveCameraSessionStatus.STOPPED ||
      session.status === LiveCameraSessionStatus.ERROR
    ) {
      return;
    }
    const stoppedAt = this.now();
    let decision: CustomerJourneyDecision | null = null;
    if (session.journeyId) {
      // FAIL CLOSED for detected-but-unprocessed windows and pending
      // motion (Codex P1): a MARKER code means an interaction was seen
      // and dropped — the review-required marker must be DURABLE on the
      // journey BEFORE the exit runs, so reconciliation can never land on
      // READY_TO_SETTLE_SHADOW. A failed append parks the session
      // RETRYABLE (the exit is NOT attempted); the next stop() retries
      // the marker first, then the closure. Idempotent across retries.
      if (session.errorCode && MARKER_CODES.includes(session.errorCode)) {
        try {
          await this.ensureReviewMarker(
            tenantId,
            session.journeyId,
            session.errorCode,
            stoppedAt,
            actorId,
          );
        } catch (error) {
          if (!(error instanceof ConflictException)) {
            this.logger.warn(
              `live session ${sessionId} could not record its review ` +
                `marker (${classifyError(error)}) — parked for retry`,
            );
            await this.prisma.liveCameraSession.updateMany({
              where: {
                id: sessionId,
                tenantId,
                status: { in: NON_TERMINAL_SESSION_STATUSES },
                ...(options?.leaseOwner
                  ? { leaseOwner: options.leaseOwner }
                  : {}),
              },
              data: {
                status: LiveCameraSessionStatus.STOPPING,
                errorCode: session.errorCode,
                leaseOwner: null,
              },
            });
            return;
          }
          // Conflict: the journey is already closed — the exit below
          // conflicts too and reads the settled decision back.
        }
      }
      try {
        const exited = await this.journeys.exit(
          tenantId,
          session.journeyId,
          actorId,
          { exitAt: stoppedAt },
        );
        decision = exited.decision;
      } catch (error) {
        if (error instanceof ConflictException) {
          // Already closed (a competing finalizer exited it) — read the
          // decision it settled on.
          const detail = await this.journeys
            .detail(tenantId, session.journeyId)
            .catch(() => null);
          decision = detail?.decision ?? null;
        } else {
          // RETRYABLE (Codex P1): never a terminal session status over an
          // OPEN journey — the row stays STOPPING with a controlled code
          // and a later stop() retries the closure.
          this.logger.warn(
            `live session ${sessionId} journey exit failed (${classifyError(error)})`,
          );
          await this.prisma.liveCameraSession.updateMany({
            where: {
              id: sessionId,
              tenantId,
              status: { in: NON_TERMINAL_SESSION_STATUSES },
              ...(options?.leaseOwner
                ? { leaseOwner: options.leaseOwner }
                : {}),
            },
            data: {
              status: LiveCameraSessionStatus.STOPPING,
              errorCode: JOURNEY_FINALIZE_RETRY,
              leaseOwner: null,
            },
          });
          return;
        }
      }
    }
    await this.prisma.liveCameraSession.updateMany({
      where: {
        id: sessionId,
        tenantId,
        status: { in: NON_TERMINAL_SESSION_STATUSES },
        // CAS on the journey link (Codex P1): if a startup race LINKS a
        // journey after this finalizer read the row, the terminal write
        // matches nothing and the row stays retryable — a terminal
        // session can never sit over an OPEN journey it did not close.
        journeyId: session.journeyId,
        ...(options?.leaseOwner ? { leaseOwner: options.leaseOwner } : {}),
      },
      data: {
        status: LiveCameraSessionStatus.STOPPED,
        stoppedAt,
        decision,
        leaseOwner: null,
      },
    });
  }

  /** Failure finalization: ERROR with a controlled code, journey aborted
   *  (decision FAILED) so no OPEN orphan survives the session. */
  private async finalizeError(
    tenantId: string,
    sessionId: string,
    errorCode: string,
    actorId?: string,
    options?: { leaseOwner?: string; journeyId?: string | null },
  ): Promise<void> {
    const stoppedAt = this.now();
    const session = await this.prisma.liveCameraSession.findFirst({
      where: { tenantId, id: sessionId },
    });
    if (
      !session ||
      session.status === LiveCameraSessionStatus.STOPPED ||
      session.status === LiveCameraSessionStatus.ERROR
    ) {
      return;
    }
    const journeyId = options?.journeyId ?? session.journeyId ?? null;
    let decision: CustomerJourneyDecision | null = null;
    if (journeyId) {
      try {
        const aborted = await this.journeys.abortShadowJourney(
          tenantId,
          journeyId,
          errorCode,
          actorId,
          { exitAt: stoppedAt },
        );
        decision = aborted.decision;
      } catch (error) {
        if (!(error instanceof ConflictException)) {
          // RETRYABLE (Codex P1): keep the ORIGINAL failure code (its
          // abort intent survives for the retry) but stay non-terminal —
          // a later stop() re-runs the abort and only then terminalizes.
          this.logger.warn(
            `live session ${sessionId} journey abort failed (${classifyError(error)})`,
          );
          await this.prisma.liveCameraSession.updateMany({
            where: {
              id: sessionId,
              tenantId,
              status: { in: NON_TERMINAL_SESSION_STATUSES },
              ...(options?.leaseOwner
                ? { leaseOwner: options.leaseOwner }
                : {}),
            },
            data: {
              status: LiveCameraSessionStatus.STOPPING,
              errorCode,
              leaseOwner: null,
            },
          });
          return;
        }
      }
    }
    await this.prisma.liveCameraSession.updateMany({
      where: {
        id: sessionId,
        tenantId,
        status: { in: NON_TERMINAL_SESSION_STATUSES },
        // CAS on the journey link — see finalizeStopped: a link that lands
        // after this read voids the terminal write; the row stays
        // retryable instead of terminalizing over an OPEN journey.
        journeyId: session.journeyId,
        ...(options?.leaseOwner ? { leaseOwner: options.leaseOwner } : {}),
      },
      data: {
        status: LiveCameraSessionStatus.ERROR,
        errorCode,
        stoppedAt,
        decision,
        leaseOwner: null,
      },
    });
  }

  /**
   * Stop — safe even when the loop is dead (process restarted): the
   * endpoint marks STOPPING, signals a live loop when one exists here,
   * and finalizes DIRECTLY with takeover semantics. Stopping a terminal
   * session is idempotent and returns its view unchanged.
   */
  /** Overridable for deterministic specs. */
  protected drainTimeoutMs(): number {
    return LIVE_STOP_DRAIN_TIMEOUT_MS;
  }

  /** true = the promise settled inside the bound; false = timed out. */
  private awaitWithTimeout(
    promise: Promise<unknown> | undefined,
    ms: number,
  ): Promise<boolean> {
    if (!promise) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }
      const settle = () => {
        clearTimeout(timer);
        resolve(true);
      };
      void promise.then(settle, settle);
    });
  }

  async stop(
    tenantId: string,
    sessionId: string,
    actorId?: string,
  ): Promise<LiveSessionDetail> {
    const session = await this.prisma.liveCameraSession.findFirst({
      where: { tenantId, id: sessionId },
      include: SOURCE_INCLUDE,
    });
    if (!session) {
      throw new NotFoundException('Live session not found');
    }
    if (
      session.status === LiveCameraSessionStatus.STOPPED ||
      session.status === LiveCameraSessionStatus.ERROR
    ) {
      return toDetail(session as SessionWithSource);
    }
    const controller = this.loops.get(sessionId);
    if (controller) {
      await this.prisma.liveCameraSession.updateMany({
        where: {
          id: sessionId,
          tenantId,
          status: { in: NON_TERMINAL_SESSION_STATUSES },
        },
        data: { status: LiveCameraSessionStatus.STOPPING },
      });
      // DRAIN BEFORE STOPPED (Codex P1): signal the loop and WAIT for it
      // to finish its in-flight window processing and its own
      // finalization (counters persisted, closed windows swept, pending
      // motion marked, journey closed) — bounded. The controller stays
      // registered through the loop's finalization, so a concurrent
      // stop() awaits the SAME finalization here instead of taking the
      // dead-loop path and double-finalizing. A drain timeout fails
      // closed: the journey is aborted, never reported
      // READY_TO_SETTLE_SHADOW over half-done work.
      controller.stopRequested = true;
      const drained = await this.awaitWithTimeout(
        this.loopPromises.get(sessionId),
        this.drainTimeoutMs(),
      );
      if (!drained) {
        await this.finalizeError(
          tenantId,
          sessionId,
          WINDOW_DRAIN_TIMEOUT,
          actorId,
        );
        return this.byId(tenantId, sessionId);
      }
      // The loop may have PARKED a retryable finalization (marker or
      // journey closure failed) — resume it now instead of handing the
      // caller a STOPPING row that needs another stop().
      const after = await this.prisma.liveCameraSession.findFirst({
        where: { tenantId, id: sessionId },
      });
      if (after && after.status === LiveCameraSessionStatus.STOPPING) {
        const parkedCode = after.errorCode;
        if (parkedCode && !STOP_INTENT_CODES.includes(parkedCode)) {
          await this.finalizeError(tenantId, sessionId, parkedCode, actorId);
        } else {
          await this.finalizeStopped(tenantId, sessionId, actorId);
        }
      }
      return this.byId(tenantId, sessionId);
    }
    // NO LOCAL LOOP (Codex P1 round 3): absence here does NOT mean the
    // session is dead — its loop may live in ANOTHER API process. Only
    // the persisted lease decides.
    const owner = session.leaseOwner ?? null;
    const heartbeatMs = (session.heartbeatAt ?? session.startedAt).getTime();
    const fresh = this.now().getTime() - heartbeatMs < LIVE_SESSION_STALE_MS;
    if (owner !== null && fresh) {
      // FRESH REMOTE OWNER: request the stop and step aside. The remote
      // loop's next heartbeat (RUNNING-conditional) starves, re-reads,
      // recognizes the stop request, drains its in-flight and closed
      // windows, and finalizes the journey ITSELF. Closing the journey
      // here would race evidence that loop can still write — a non-owner
      // never finalizes over a fresh foreign lease.
      await this.prisma.liveCameraSession.updateMany({
        where: {
          id: sessionId,
          tenantId,
          status: { in: ACTIVE_SESSION_STATUSES },
          leaseOwner: owner,
        },
        data: { status: LiveCameraSessionStatus.STOPPING },
      });
      return this.byId(tenantId, sessionId);
    }
    if (owner !== null) {
      // STALE remote owner: claim ATOMICALLY before touching anything —
      // a loop that revived keeps beating and voids this claim.
      const cutoff = new Date(this.now().getTime() - LIVE_SESSION_STALE_MS);
      const claimed = await this.prisma.liveCameraSession.updateMany({
        where: {
          id: sessionId,
          tenantId,
          status: { in: NON_TERMINAL_SESSION_STATUSES },
          leaseOwner: owner,
          OR: [
            { heartbeatAt: { lt: cutoff } },
            { heartbeatAt: null, startedAt: { lt: cutoff } },
          ],
        },
        data: { status: LiveCameraSessionStatus.STOPPING, leaseOwner: null },
      });
      if (claimed.count === 0) {
        // The owner revived (or another claimer won) — downgrade to a
        // stop REQUEST and let the current owner drain.
        await this.prisma.liveCameraSession.updateMany({
          where: {
            id: sessionId,
            tenantId,
            status: { in: ACTIVE_SESSION_STATUSES },
          },
          data: { status: LiveCameraSessionStatus.STOPPING },
        });
        return this.byId(tenantId, sessionId);
      }
    }
    // Parked (lease released) or freshly claimed: resume finalization by
    // the stored code — abort-intent codes re-run the abort; stop-intent
    // codes (finalize-retry, failed window, pending motion) re-run the
    // normal exit path, which appends the missing review-required marker
    // FIRST, then exits. Re-read for the freshest code.
    const current = await this.prisma.liveCameraSession.findFirst({
      where: { tenantId, id: sessionId },
    });
    const code = current?.errorCode ?? null;
    if (code && !STOP_INTENT_CODES.includes(code)) {
      await this.finalizeError(tenantId, sessionId, code, actorId);
    } else {
      await this.finalizeStopped(tenantId, sessionId, actorId);
    }
    return this.byId(tenantId, sessionId);
  }

  async list(tenantId: string): Promise<LiveSessionView[]> {
    const sessions = await this.prisma.liveCameraSession.findMany({
      where: { tenantId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 100,
      include: SOURCE_INCLUDE,
    });
    return sessions.map((session) => toView(session as SessionWithSource));
  }

  async byId(tenantId: string, sessionId: string): Promise<LiveSessionDetail> {
    const session = await this.prisma.liveCameraSession.findFirst({
      where: { tenantId, id: sessionId },
      include: SOURCE_INCLUDE,
    });
    if (!session) {
      throw new NotFoundException('Live session not found');
    }
    return toDetail(session as SessionWithSource);
  }
}
