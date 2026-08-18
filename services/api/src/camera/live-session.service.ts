import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  Injectable,
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
 * LIFECYCLE INVARIANTS (Codex P1, lifecycle simplification):
 *   A. A session becomes terminal (STOPPED/ERROR) only after its linked
 *      journey is verifiably closed — enforced by the ONE finalizer.
 *   B. Only the current lease owner mutates counters, appends evidence
 *      or journey events, or terminalizes the session.
 *   C. A process never finalizes a session owned by a FRESH remote
 *      owner: it may only request STOPPING and step aside.
 *   D. Detected-but-unprocessed windows, failed window processing,
 *      pending motion at stop, and failed marker appends can never end
 *      READY_TO_SETTLE_SHADOW — enforced by durable intents + the
 *      decision guard.
 *   E. Fail-closed intents are DURABLE and ADDITIVE rows
 *      (LiveCameraSessionFinalizationIntent), never a single
 *      overwritable errorCode. errorCode is advisory display only.
 *   F. No mandatory write is swallowed: a failure stops or parks the
 *      flow retryably; it never proceeds to a normal exit.
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
 * DURABLE FINALIZATION INTENT REASONS — the controlled vocabulary of
 * LiveCameraSessionFinalizationIntent.reason (mirrored by the DB CHECK).
 * Intents are ADDITIVE: several may coexist (a failed window AND pending
 * motion), none is ever overwritten or deleted, and the finalizer must
 * MATERIALIZE every unmaterialized one before the journey may exit. A
 * session with any intent can never conclude READY_TO_SETTLE_SHADOW.
 */
export const FINALIZATION_INTENT_REASONS = [
  'LIVE_WINDOW_PROCESS_FAILED',
  'PENDING_MOTION_AT_STOP',
  'WINDOW_DETECTED_NOT_PROCESSED',
  'LIVE_WINDOW_DRAIN_TIMEOUT',
  'STARTUP_FINALIZATION_REQUIRED',
  'STALE_SESSION_RECLAIMED',
  'LIVE_FRAME_SCREENING_UNAVAILABLE',
  'LIVE_FRAME_SENSITIVE_CONTENT',
  'JOURNEY_FINALIZATION_RETRY_REQUIRED',
  'LIVE_SESSION_DETECTED_WORK_REQUIRES_REVIEW',
] as const;

export type FinalizationIntentReason =
  (typeof FINALIZATION_INTENT_REASONS)[number];

/** Intent reasons that MATERIALIZE as REVIEW_REQUIRED journey events (a
 *  dropped/pending/unscreened interaction must be visible to the fold).
 *  Lifecycle reasons (stale reclaim, startup cleanup, drain timeout,
 *  finalization retry) fail closed through the ABORT path instead — a
 *  review marker would only add noise to a journey that ends FAILED. */
const REVIEW_MARKER_REASONS: ReadonlySet<string> = new Set([
  'LIVE_WINDOW_PROCESS_FAILED',
  'PENDING_MOTION_AT_STOP',
  'WINDOW_DETECTED_NOT_PROCESSED',
  'LIVE_FRAME_SCREENING_UNAVAILABLE',
  'LIVE_FRAME_SENSITIVE_CONTENT',
  'LIVE_SESSION_DETECTED_WORK_REQUIRES_REVIEW',
]);

/**
 * Controlled error codes — ADVISORY DISPLAY ONLY since the lifecycle
 * simplification (the durable safety state lives in the intent rows).
 * The ONLY strings that may land in LiveCameraSession.errorCode from
 * these paths; raw exception text never persists.
 */
export const LIVE_SESSION_ERROR_CODES = [
  'LIVE_SESSION_STOPPED_DURING_START',
  'LIVE_SESSION_STALE_RECLAIMED',
  'JOURNEY_FINALIZE_RETRY',
  'LIVE_WINDOW_DRAIN_TIMEOUT',
  'LIVE_WINDOW_PROCESS_FAILED',
  'PENDING_MOTION_AT_STOP',
  'PRE_LINK_STOP_RETRY_REQUIRED',
] as const;

/** Journey review marker for DETECTED live work (Phase 13 review-first,
 *  Codex P1): every live session that detected ANY motion window —
 *  including fully processed AUTO_PROPOSE windows — must carry this
 *  REVIEW_REQUIRED marker on its journey BEFORE the exit, so the
 *  JOURNEY's own fold (not just the session snapshot) lands in review. */
export const DETECTED_WORK_REVIEW_MARKER =
  'LIVE_SESSION_DETECTED_WORK_REQUIRES_REVIEW';
/** The SAME string as a durable additive intent, written at DETECTION
 *  TIME — before any fusion run or journey append — so review-first
 *  never depends on the best-effort counter persist (Codex P1). */
const DETECTED_WORK_INTENT: FinalizationIntentReason =
  'LIVE_SESSION_DETECTED_WORK_REQUIRES_REVIEW';

/** Advisory code stamped when the bare pre-link remnant's terminal write
 *  failed: the row parks unowned + mode STOP so the NEXT stop() claims
 *  and terminalizes it immediately (no five-minute stale wait). */
const PRE_LINK_STOP_RETRY = 'PRE_LINK_STOP_RETRY_REQUIRED';

const STOPPED_DURING_START = 'LIVE_SESSION_STOPPED_DURING_START';
const STALE_RECLAIMED = 'LIVE_SESSION_STALE_RECLAIMED';
/** The durable intent counterpart of the STALE_RECLAIMED errorCode. */
const STALE_RECLAIMED_INTENT: FinalizationIntentReason =
  'STALE_SESSION_RECLAIMED';
const JOURNEY_FINALIZE_RETRY = 'JOURNEY_FINALIZE_RETRY';
const WINDOW_DRAIN_TIMEOUT = 'LIVE_WINDOW_DRAIN_TIMEOUT';
const WINDOW_PROCESS_FAILED = 'LIVE_WINDOW_PROCESS_FAILED';
const PENDING_MOTION_AT_STOP = 'PENDING_MOTION_AT_STOP';
const WINDOW_NOT_PROCESSED = 'WINDOW_DETECTED_NOT_PROCESSED';
const STARTUP_FINALIZATION = 'STARTUP_FINALIZATION_REQUIRED';
const FINALIZATION_RETRY = 'JOURNEY_FINALIZATION_RETRY_REQUIRED';

/** Advisory errorCodes whose retry path is a normal STOP finalization
 *  (exit + reconcile) rather than an abort. */
const STOP_INTENT_CODES: readonly string[] = [
  JOURNEY_FINALIZE_RETRY,
  WINDOW_PROCESS_FAILED,
  PENDING_MOTION_AT_STOP,
];

/** Thrown INSIDE the atomic create+link transaction when the session was
 *  concurrently finalized — rolls the journey creation back so nothing
 *  ever exists unlinked. Internal control flow, never surfaces. */
class StartupRaceRollback extends Error {
  constructor() {
    super('startup race — journey creation rolled back');
  }
}

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
   *  loop is alive in THIS process. The controller stays registered
   *  until the loop's FINALIZATION completes or parks (Invariant A/C):
   *  a concurrent stop must await it, never double-finalize. It carries
   *  the loop's lease token so stop() can acquire the drain lease and
   *  the timeout path can REVOKE it — both atomically, owner-predicated. */
  private readonly loops = new Map<
    string,
    { stopRequested: boolean; leaseOwner: string }
  >();

  /** Loop completion promises — awaited by stop()'s drain and by the
   *  awaitLoop test hook. */
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

  // ------------------------------------------------------------------
  // Durable additive finalization intents (Invariant E)
  // ------------------------------------------------------------------

  /**
   * MANDATORY durable intent write (classification B). Idempotent: the
   * (liveSessionId, reason) unique makes a repeat add a no-op success.
   * ANY other failure THROWS — callers must stop or park, never proceed
   * into a normal finalization over a lost intent (Invariant F).
   */
  private async addIntent(
    tenantId: string,
    sessionId: string,
    reason: FinalizationIntentReason,
    /** Optional transaction client — the takeover/claim paths write the
     *  intent ATOMICALLY with the lease revocation + mode/code stamp
     *  (Codex P1: no partial revocation may commit). */
    db: Pick<
      Prisma.TransactionClient,
      'liveCameraSessionFinalizationIntent'
    > = this.prisma,
  ): Promise<void> {
    try {
      await db.liveCameraSessionFinalizationIntent.create({
        data: { tenantId, liveSessionId: sessionId, reason },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return; // already recorded — additive and idempotent
      }
      throw error;
    }
  }

  // ------------------------------------------------------------------
  // THE finalizer (Invariants A–D). The ONLY code that exits or aborts
  // the session's journey, writes STOPPED/ERROR/stoppedAt/decision, or
  // releases the lease.
  // ------------------------------------------------------------------

  /**
   * Finalize a live session SAFELY, or park it retryably, or refuse.
   *
   * Ownership rules:
   *  - `ownerToken` set → the row must still carry that lease (the
   *    caller is the loop / the starter); otherwise the lease was lost
   *    and NOTHING is touched.
   *  - `ownerToken` null → the row must be UNOWNED (parked or claimed);
   *    a fresh foreign lease is only ever sent a STOPPING request. A
   *    stuck local loop is handled by REVOKING its lease atomically
   *    FIRST (stop()'s drain-timeout path) — there is no ownership
   *    bypass, so every terminal/park write carries a lease predicate.
   *
   * Sequence: re-read → ownership → counter-gap intent → materialize
   * every unmaterialized intent as a REVIEW_REQUIRED journey marker →
   * close the journey (exit for mode 'stop', abort otherwise) → decision
   * guard → terminal CAS. Every mandatory failure parks the row in
   * STOPPING with a JOURNEY_FINALIZATION_RETRY_REQUIRED intent (or, if
   * even that cannot persist, THROWS leaving the row owned and
   * non-terminal for stale reclaim).
   */
  private async finalizeLiveSessionSafely(
    tenantId: string,
    sessionId: string,
    options: {
      ownerToken: string | null;
      mode: 'stop' | 'error';
      code?: string | null;
      actorId?: string;
    },
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
    // Ownership (Invariants B/C).
    const rowOwner = session.leaseOwner ?? null;
    if (options.ownerToken !== null) {
      if (rowOwner !== options.ownerToken) {
        this.logger.warn(
          `live session ${sessionId} lease lost — finalization refused`,
        );
        return;
      }
    } else if (rowOwner !== null) {
      const heartbeatMs = (session.heartbeatAt ?? session.startedAt).getTime();
      if (this.now().getTime() - heartbeatMs < LIVE_SESSION_STALE_MS) {
        // FRESH remote owner: request the stop, never finalize here.
        await this.prisma.liveCameraSession
          .updateMany({
            where: {
              id: sessionId,
              tenantId,
              status: { in: ACTIVE_SESSION_STATUSES },
              leaseOwner: rowOwner,
            },
            data: { status: LiveCameraSessionStatus.STOPPING },
          })
          .catch(() => null);
        return;
      }
      // Stale but unclaimed — the caller must claim atomically first.
      return;
    }
    const stoppedAt = this.now();
    const ownershipWhere =
      options.ownerToken !== null
        ? { leaseOwner: options.ownerToken }
        : { leaseOwner: null };

    /** Park retryably: STOPPING + advisory code + DURABLE finalization
     *  MODE + FINALIZATION_RETRY intent. The mode column (never the
     *  advisory code, never an intent reason) is what the retry uses to
     *  re-enter with the SAME closure semantics — a marker-append
     *  failure during an ERROR finalization must not resume as a clean
     *  STOP (Codex P1). A park that cannot persist its intent THROWS —
     *  the row stays owned and non-terminal for stale reclaim. */
    const park = async (advisoryCode: string): Promise<void> => {
      await this.addIntent(tenantId, sessionId, FINALIZATION_RETRY);
      await this.prisma.liveCameraSession.updateMany({
        where: {
          id: sessionId,
          tenantId,
          status: { in: NON_TERMINAL_SESSION_STATUSES },
          ...ownershipWhere,
        },
        data: {
          status: LiveCameraSessionStatus.STOPPING,
          errorCode: advisoryCode,
          finalizationMode: options.mode === 'stop' ? 'STOP' : 'ERROR',
          leaseOwner: null,
        },
      });
    };

    // Counter-gap intent (Invariant D): a detected window that never
    // processed must be durably visible even when no path recorded it.
    const counterGap =
      session.eventWindowsDetected > session.eventWindowsProcessed;
    if (counterGap) {
      await this.addIntent(tenantId, sessionId, WINDOW_NOT_PROCESSED);
    }
    // REVIEW-FIRST (Phase 13 correction): ANY detected live motion means
    // the session's outcome is a review outcome — a live RTSP session may
    // conclude READY_TO_SETTLE_SHADOW only when it detected NOTHING and
    // carries no intent. Processed-and-clean is still review-first for
    // this phase.
    let suppressReady = counterGap || session.eventWindowsDetected > 0;
    const intents =
      await this.prisma.liveCameraSessionFinalizationIntent.findMany({
        where: { tenantId, liveSessionId: sessionId },
      });
    // ANY recorded intent forbids READY (Invariant D): an intent exists
    // only because something abnormal happened (dropped window, pending
    // motion, stale reclaim, failed mandatory write, …) — a session that
    // needed one never concludes clean, missing errorCode or not.
    if (intents.length > 0) {
      suppressReady = true;
    }

    // DETECTED-WORK MARKER (Phase 13 review-first, Codex P1): a live
    // session that detected ANY window — including ones that processed
    // cleanly to AUTO_PROPOSE — persists a review-required marker on the
    // JOURNEY itself before the exit, so the journey's OWN fold decides
    // review, not just the session's copied snapshot. A failed append
    // parks the finalization retryably (mandatory write, never
    // swallowed); an already-closed journey falls to the decision guard.
    if (session.journeyId && session.eventWindowsDetected > 0) {
      try {
        await this.ensureReviewMarker(
          tenantId,
          session.journeyId,
          DETECTED_WORK_REVIEW_MARKER,
          stoppedAt,
          options.actorId,
        );
      } catch (error) {
        if (!(error instanceof ConflictException)) {
          this.logger.warn(
            `live session ${sessionId} could not persist its detected-` +
              `work review marker (${classifyError(error)}) — parked`,
          );
          await park(
            options.mode === 'stop'
              ? JOURNEY_FINALIZE_RETRY
              : (options.code ?? JOURNEY_FINALIZE_RETRY),
          );
          return;
        }
        suppressReady = true;
      }
    }

    // MATERIALIZE every unmaterialized marker-class intent BEFORE the
    // exit — the fold must see the dropped/pending interaction.
    // Lifecycle-class intents (retry bookkeeping, reclaim, drain) carry
    // no marker; their fail-closed effect is the abort path itself.
    if (session.journeyId) {
      for (const intent of intents.filter((row) => !row.materializedAt)) {
        if (REVIEW_MARKER_REASONS.has(intent.reason)) {
          try {
            await this.ensureReviewMarker(
              tenantId,
              session.journeyId,
              intent.reason,
              stoppedAt,
              options.actorId,
            );
          } catch (error) {
            if (!(error instanceof ConflictException)) {
              this.logger.warn(
                `live session ${sessionId} could not materialize ` +
                  `${intent.reason} (${classifyError(error)}) — parked`,
              );
              // Advisory code: keep the ORIGINAL error reason on error
              // finalizations — the marker's reason lives durably in its
              // intent row and must not mask what failed (Codex P1).
              await park(
                options.mode === 'stop'
                  ? intent.reason
                  : (options.code ?? intent.reason),
              );
              return;
            }
            // Journey already closed — the marker can never land in the
            // fold, so the DECISION GUARD below must forbid READY.
            suppressReady = true;
          }
        }
        await this.prisma.liveCameraSessionFinalizationIntent
          .updateMany({
            where: { id: intent.id, tenantId },
            data: { materializedAt: stoppedAt },
          })
          .catch(() => null); // re-materializing later is harmless (idempotent markers)
      }
    }

    // Close the journey (Invariant A). Exit for a clean stop; abort for
    // error/reclaim/drain-timeout paths.
    let decision: CustomerJourneyDecision | null = null;
    if (session.journeyId) {
      try {
        if (options.mode === 'stop') {
          const exited = await this.journeys.exit(
            tenantId,
            session.journeyId,
            options.actorId,
            // The finalizer is the ONE caller allowed to close a
            // live-owned journey — generic exits are rejected while the
            // session is non-terminal (Codex P1).
            { exitAt: stoppedAt, viaLiveSessionFinalizer: true },
          );
          decision = exited.decision;
        } else {
          const aborted = await this.journeys.abortShadowJourney(
            tenantId,
            session.journeyId,
            options.code ?? 'LIVE_SESSION_ERROR',
            options.actorId,
            { exitAt: stoppedAt },
          );
          decision = aborted.decision;
        }
      } catch (error) {
        if (error instanceof ConflictException) {
          const detail = await this.journeys
            .detail(tenantId, session.journeyId)
            .catch(() => null);
          decision = detail?.decision ?? null;
        } else {
          this.logger.warn(
            `live session ${sessionId} journey closure failed ` +
              `(${classifyError(error)}) — parked`,
          );
          await park(
            options.mode === 'stop'
              ? JOURNEY_FINALIZE_RETRY
              : (options.code ?? JOURNEY_FINALIZE_RETRY),
          );
          return;
        }
      }
    }

    // DECISION GUARD (Invariant D, defense in depth): a counter gap or a
    // marker-class intent that could not land in the fold forbids
    // READY_TO_SETTLE_SHADOW on the session snapshot no matter what the
    // journey settled on. Materialized markers already steer the fold to
    // review; lifecycle intents fail closed through the abort path.
    if (
      decision === CustomerJourneyDecision.READY_TO_SETTLE_SHADOW &&
      suppressReady
    ) {
      this.logger.warn(
        `live session ${sessionId} decision guard: READY suppressed`,
      );
      decision = CustomerJourneyDecision.NEEDS_EVENT_REVIEW;
    }

    // Terminal CAS (Invariant A): conditional on the journey link as
    // read and on ownership — a link or owner that changed since voids
    // the write and the row stays retryable.
    await this.prisma.liveCameraSession.updateMany({
      where: {
        id: sessionId,
        tenantId,
        status: { in: NON_TERMINAL_SESSION_STATUSES },
        journeyId: session.journeyId,
        ...ownershipWhere,
      },
      data: {
        status:
          options.mode === 'stop'
            ? LiveCameraSessionStatus.STOPPED
            : LiveCameraSessionStatus.ERROR,
        ...(options.code !== undefined ? { errorCode: options.code } : {}),
        stoppedAt,
        decision,
        finalizationMode: null,
        leaseOwner: null,
      },
    });
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
        active.id,
        actorId,
      );
      if (!reclaimed) {
        // Lost the reclaim race (a real loop beat us, or another start
        // reclaimed first) or the cleanup parked retryably — the row's
        // CURRENT state is the answer.
        return this.byId(tenantId, active.id);
      }
      // Reclaim complete (terminal, journey closed): fall through to a
      // fresh start — the partial unique is free again.
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

    // ATOMIC journey create + session link (Codex P1, lifecycle
    // simplification): ONE transaction re-checks that this attempt still
    // owns a STARTING row, opens the journey (validations + journey +
    // ENTRY on the SAME tx), and links it — so a journey either exists
    // LINKED or does not exist at all. A racing stop() that finalized
    // the row makes the guard or the link miss and the whole creation
    // ROLLS BACK: nothing to abort, nothing to orphan, no best-effort
    // recovery lattice.
    let journeyId: string | null = null;
    try {
      const outcome = await this.prisma.$transaction(async (tx) => {
        const current = await tx.liveCameraSession.findFirst({
          where: { id: session.id, tenantId },
          select: { status: true, leaseOwner: true },
        });
        if (
          !current ||
          current.status !== LiveCameraSessionStatus.STARTING ||
          current.leaseOwner !== leaseOwner
        ) {
          return { raced: true as const };
        }
        const opened = await this.journeys.openJourneyInTransaction(
          tx,
          tenantId,
          { locationId: source.locationId, unitId: source.unitId },
          actorId,
          { entryAt: session.startedAt },
        );
        const linked = await tx.liveCameraSession.updateMany({
          where: {
            id: session.id,
            tenantId,
            status: LiveCameraSessionStatus.STARTING,
            leaseOwner,
          },
          data: { journeyId: opened.journeyId },
        });
        if (linked.count === 0) {
          // The row changed between the guard read and the link write —
          // roll the journey creation back with it.
          throw new StartupRaceRollback();
        }
        return { raced: false as const, journeyId: opened.journeyId };
      });
      if (outcome.raced) {
        // A stop landed BEFORE the journey existed (Codex P1): finalize
        // the bare row NOW — releasing the lease and the one-active-per-
        // source slot immediately — instead of abandoning a STOPPING row
        // to the five-minute stale reclaim. No journey was created, so
        // this is a stopped-before-start with zero events.
        await this.finalizeStartupRemnant(tenantId, session.id, leaseOwner, actorId);
        return this.byId(tenantId, session.id);
      }
      journeyId = outcome.journeyId;
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
        // A stop() raced between the atomic link and the promote. The
        // journey exists and IS linked — the ordinary finalizer closes
        // it. The intent is MANDATORY (throws on failure, leaving the
        // row owned + linked for stale reclaim / stop() retry).
        await this.addIntent(tenantId, session.id, STARTUP_FINALIZATION);
        await this.finalizeLiveSessionSafely(tenantId, session.id, {
          ownerToken: leaseOwner,
          mode: 'error',
          code: STOPPED_DURING_START,
          actorId,
        });
        return this.byId(tenantId, session.id);
      }
    } catch (error) {
      if (error instanceof StartupRaceRollback) {
        // Rolled back inside the transaction: no journey exists. Same
        // immediate bare-row finalization as the guard race above.
        await this.finalizeStartupRemnant(tenantId, session.id, leaseOwner, actorId);
        return this.byId(tenantId, session.id);
      }
      // The transaction failed (journey creation rolled back with it) or
      // a post-tx mandatory write failed. With no journey there is
      // nothing to close; finalize the bare row as ERROR. With a linked
      // journey (post-tx failures) the finalizer closes or parks.
      await this.finalizeLiveSessionSafely(tenantId, session.id, {
        ownerToken: leaseOwner,
        mode: 'error',
        code: classifyError(error),
        actorId,
      }).catch((finalizeError) => {
        this.logger.error(
          `live session ${session.id} startup finalization failed ` +
            `(${classifyError(finalizeError)}) — left owned for stale ` +
            `reclaim`,
        );
      });
      if (
        error instanceof ConflictException ||
        error instanceof NotFoundException
      ) {
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
      return this.finalizeLiveSessionSafely(tenantId, session.id, {
        ownerToken: leaseOwner,
        mode: 'error',
        code: 'LIVE_LOOP_FAILED',
        actorId,
      }).catch(() => undefined);
    });
    this.loopPromises.set(
      session.id,
      loopPromise.then(() => undefined),
    );

    return this.byId(tenantId, session.id);
  }

  /**
   * Finalize a startup remnant: a session row whose start lost a race
   * BEFORE any journey existed (stop landed pre-link, or the atomic
   * create+link rolled back). Runs through the strict finalizer with the
   * startup lease — if the lease is no longer ours (a claimant or the
   * racing stop's own finalization won) the finalizer refuses and the
   * row is left to its current owner. mode 'stop': this is a requested
   * stop with ZERO events, not a runtime error.
   */
  private async finalizeStartupRemnant(
    tenantId: string,
    sessionId: string,
    leaseOwner: string,
    actorId?: string,
  ): Promise<void> {
    try {
      await this.finalizeLiveSessionSafely(tenantId, sessionId, {
        ownerToken: leaseOwner,
        mode: 'stop',
        code: STOPPED_DURING_START,
        actorId,
      });
    } catch (error) {
      // MANDATORY-failure fallback (Codex P1): never leave a FRESH owned
      // STOPPING row with no local loop — a later stop() would read it as
      // a fresh remote owner and wait out the five-minute stale cutoff.
      // Park the bare row UNOWNED with mode STOP + a retry code so the
      // very next stop() claims and terminalizes it immediately.
      this.logger.error(
        `live session ${sessionId} startup-remnant finalization failed ` +
          `(${classifyError(error)}) — parking for immediate retry`,
      );
      try {
        await this.prisma.liveCameraSession.updateMany({
          where: {
            id: sessionId,
            tenantId,
            status: { in: NON_TERMINAL_SESSION_STATUSES },
            leaseOwner,
          },
          data: {
            status: LiveCameraSessionStatus.STOPPING,
            leaseOwner: null,
            finalizationMode: 'STOP',
            errorCode: PRE_LINK_STOP_RETRY,
          },
        });
      } catch (parkError) {
        // BOTH mandatory writes failed (Codex P1): NEVER report success
        // over a stuck remnant. The remnant stays retryable CROSS-
        // PROCESS through stop()'s bare-remnant fast path (journeyId
        // null + zero frames is atomically claimable by ANY process, no
        // stale cutoff, no process-local state) — so this request only
        // needs to fail visibly with a controlled error.
        this.logger.error(
          `live session ${sessionId} pre-link retry park failed ` +
            `(${classifyError(parkError)}) — failing the request; the ` +
            `bare remnant is claimable by any process's stop()`,
        );
        throw new ConflictException(
          'live session stop is pending finalization retry ' +
            '(PRE_LINK_STOP_RETRY_REQUIRED)',
        );
      }
    }
  }

  /**
   * Reclaim a crash-leftover session (Codex P1): active row, no local
   * loop, heartbeat expired. The claim is an ATOMIC conditional write on
   * (active status AND expired heartbeat) — a still-live loop in another
   * process keeps beating and the claim matches nothing. After the claim
   * the durable STALE intent is recorded and the finalizer closes the
   * journey using its OWN fresh re-read of the row (a journey the
   * original starter linked between snapshot and claim is therefore
   * still closed). Returns true when the row reached a terminal state
   * (caller may start fresh).
   */
  private async reclaimStaleSession(
    tenantId: string,
    sessionId: string,
    actorId?: string,
  ): Promise<boolean> {
    // ONE transaction: claim + finalizationMode=ERROR + code + durable
    // intent (Codex P1) — the stamp is the journey-level fence, and a
    // failed intent write rolls the whole claim back (nothing partial).
    const cutoff = new Date(this.now().getTime() - LIVE_SESSION_STALE_MS);
    let claimed = false;
    try {
      claimed = await this.prisma.$transaction(async (tx) => {
        const res = await tx.liveCameraSession.updateMany({
          where: {
            id: sessionId,
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
            finalizationMode: 'ERROR',
            leaseOwner: null,
          },
        });
        if (res.count === 0) {
          return false;
        }
        await this.addIntent(tenantId, sessionId, STALE_RECLAIMED_INTENT, tx);
        return true;
      });
    } catch (error) {
      this.logger.warn(
        `stale live session ${sessionId} claim failed ` +
          `(${classifyError(error)}) — nothing claimed, retry later`,
      );
      return false;
    }
    if (!claimed) {
      return false;
    }
    try {
      await this.finalizeLiveSessionSafely(tenantId, sessionId, {
        ownerToken: null,
        mode: 'error',
        code: STALE_RECLAIMED,
        actorId,
      });
    } catch (error) {
      this.logger.warn(
        `stale live session ${sessionId} cleanup failed ` +
          `(${classifyError(error)}) — left STOPPING for retry`,
      );
      return false;
    }
    const after = await this.prisma.liveCameraSession.findFirst({
      where: { id: sessionId, tenantId },
      select: { status: true },
    });
    return (
      after?.status === LiveCameraSessionStatus.ERROR ||
      after?.status === LiveCameraSessionStatus.STOPPED
    );
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
    const controller = { stopRequested: false, leaseOwner };
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
     *  values (no read-modify-write races with ourselves). BEST-EFFORT
     *  (classification A): the durable safety state lives in intents. */
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

    /** Unpersisted MANDATORY intent (classification B): while set,
     *  normal finalization is BLOCKED — the loop retries the durable
     *  write every iteration, and at exit it must leave the row owned
     *  for stale reclaim. Never silently discarded. */
    let unpersistedIntent: FinalizationIntentReason | null = null;

    /** MANDATORY failed-window intent: a DETECTED window whose
     *  processing failed must be durably visible (intent → review marker
     *  before exit). The advisory errorCode is best-effort display. */
    const recordWindowFailure = async (): Promise<void> => {
      try {
        await this.addIntent(tenantId, sessionId, WINDOW_PROCESS_FAILED);
        unpersistedIntent = null;
        await this.prisma.liveCameraSession
          .updateMany({
            where: {
              id: sessionId,
              tenantId,
              status: { in: LOOP_WRITABLE_STATUSES },
              leaseOwner,
            },
            data: { errorCode: WINDOW_PROCESS_FAILED },
          })
          .catch(() => null);
      } catch {
        unpersistedIntent = WINDOW_PROCESS_FAILED;
      }
    };

    /** Retry whatever mandatory intent is still unpersisted — the loop
     *  may never finalize normally while one is pending (Invariant F). */
    const retryUnpersistedIntent = async (): Promise<void> => {
      if (unpersistedIntent === WINDOW_PROCESS_FAILED) {
        await recordWindowFailure();
        return;
      }
      if (unpersistedIntent) {
        const pending = unpersistedIntent;
        try {
          await this.addIntent(tenantId, sessionId, pending);
          if (unpersistedIntent === pending) {
            unpersistedIntent = null;
          }
        } catch {
          // still pending — retried next iteration / blocks finalization
        }
      }
    };

    /** Process one CLOSED window: watermark, counters, fusion + import;
     *  a failure fails CLOSED (durable intent — finalization then marks
     *  the journey review-required, so a dropped interaction can never
     *  end READY_TO_SETTLE_SHADOW). Shared by the in-loop pass and the
     *  final sweep at stop. */
    const handleClosedWindow = async (window: EventWindow): Promise<void> => {
      // MANDATORY DETECTION-TIME FENCE (Codex P1): the durable detected-
      // work intent lands BEFORE any fusion run or journey append —
      // review-first must never depend on the best-effort counter
      // persist. If the intent cannot land, the window is NOT processed
      // and NOT watermarked (the same closed window retries on the next
      // pass), and normal finalization stays blocked (Invariant F).
      try {
        await this.addIntent(tenantId, sessionId, DETECTED_WORK_INTENT);
        if (unpersistedIntent === DETECTED_WORK_INTENT) {
          // A prior skip's pending fence just landed with this attempt.
          unpersistedIntent = null;
        }
      } catch {
        unpersistedIntent = DETECTED_WORK_INTENT;
        return;
      }
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
        if (unpersistedIntent) {
          // MANDATORY write retry (Invariant F): the pending intent must
          // land before this loop may ever finalize normally.
          await retryUnpersistedIntent();
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
      // ATOMIC DRAIN-LEASE VERIFICATION (Codex P1): everything below —
      // counter persist, final sweep, pending-motion intent, journey
      // finalization — mutates state this loop may touch ONLY while it
      // still holds the lease. A refresh that matches nothing OR throws
      // both mean ownership cannot be proven: treat as LOST, drain
      // nothing, mutate nothing (staleness backstops the row).
      try {
        const held = await this.prisma.liveCameraSession.updateMany({
          where: {
            id: sessionId,
            tenantId,
            leaseOwner,
            status: { in: LOOP_WRITABLE_STATUSES },
            stoppedAt: null,
          },
          data: { heartbeatAt: this.now() },
        });
        if (held.count === 0) {
          leaseLost = true;
        }
      } catch {
        leaseLost = true;
      }
      if (leaseLost) {
        this.logger.warn(
          `live session ${sessionId} lost its drain lease — loop stopped without finalizing`,
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
          await this.finalizeLiveSessionSafely(tenantId, sessionId, {
            ownerToken: leaseOwner,
            mode: 'error',
            code: errorCode,
            actorId,
          });
        } catch (finalizeErr) {
          // An escaping finalization write failure (even the park could
          // not persist) leaves the row owned + non-terminal for stale
          // reclaim (Invariant F).
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
      /** A closed FINAL-SWEEP window skipped because the detection-time
       *  fence could not land (Codex P1): the window must not vanish —
       *  once the fence recovers below, it is durably represented by a
       *  WINDOW_DETECTED_NOT_PROCESSED intent before finalization may
       *  continue. */
      let sweepWindowSkipped = false;
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
        if (unpersistedIntent === DETECTED_WORK_INTENT) {
          sweepWindowSkipped = true;
        }
      }
      if (leaseLost) {
        return;
      }
      // PENDING MOTION AT STOP (Codex P1): an interaction still in
      // progress when the session ends (manual stop or auto-stop) has no
      // closed window yet — it must not vanish. The DURABLE intent lands
      // FIRST (Invariant E); the finalizer materializes it as a
      // review-required journey marker before the exit. If the intent
      // cannot persist, the loop leaves the row OWNED and non-terminal —
      // stale reclaim aborts the journey (fail-closed by another route).
      const openBurst =
        (trailing !== undefined &&
          trailing.motionScore >= DEFAULT_EVENT_WINDOW_CONFIG.minScore) ||
        extractEventWindows(exitSamples, DEFAULT_EVENT_WINDOW_CONFIG).some(
          (window) =>
            window.endMs > processedUpToMs && window.endMs >= lastMs,
        );
      if (openBurst && context.journeyId) {
        try {
          await this.addIntent(tenantId, sessionId, PENDING_MOTION_AT_STOP);
        } catch {
          this.logger.error(
            `live session ${sessionId} could not persist its ` +
              `pending-motion intent — left owned for stale reclaim`,
          );
          return;
        }
        counters.reviewNeeded += 1;
        await persist({ errorCode: PENDING_MOTION_AT_STOP });
      }
      if (unpersistedIntent) {
        // Last landing attempt for the pending mandatory intent — a
        // normal exit over an unrecorded interaction is forbidden
        // (Invariant F).
        await retryUnpersistedIntent();
      }
      if (unpersistedIntent) {
        this.logger.error(
          `live session ${sessionId} could not persist its mandatory ` +
            `${unpersistedIntent} intent — left owned for stale reclaim`,
        );
        return;
      }
      if (sweepWindowSkipped) {
        // The detection fence RECOVERED but a closed final-sweep window
        // was never processed (no fusion run, no journey append). The
        // generic detected-work marker alone must not stand in for it —
        // the SPECIFIC unprocessed-window intent lands durably before
        // finalization may continue; if it cannot, the row stays owned
        // and non-terminal for stale reclaim (Invariant F).
        try {
          await this.addIntent(tenantId, sessionId, WINDOW_NOT_PROCESSED);
        } catch {
          this.logger.error(
            `live session ${sessionId} could not persist its ` +
              `unprocessed-window intent — left owned for stale reclaim`,
          );
          return;
        }
      }
      try {
        await this.finalizeLiveSessionSafely(tenantId, sessionId, {
          ownerToken: leaseOwner,
          mode: 'stop',
          actorId,
        });
      } catch (finalizeError) {
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
   * service). Throws when the append fails — the finalizer parks the
   * session for stop()'s retry.
   */
  private async ensureReviewMarker(
    tenantId: string,
    journeyId: string,
    code: string,
    occurredAt: Date,
    actorId?: string,
  ): Promise<void> {
    const detail = await this.journeys.detail(tenantId, journeyId);
    const exists = detail.events.some(
      (event) =>
        event.eventType === CustomerJourneyEventType.REVIEW_REQUIRED &&
        event.sourceType === 'LIVE_SHADOW' &&
        event.note === code,
    );
    if (exists) {
      return;
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

  /**
   * Stop — safe whether the loop is local, remote, dead, or parked. All
   * finalization flows through finalizeLiveSessionSafely; this method
   * only routes: local drain, remote request, stale claim, or retry
   * resume. Stopping a terminal session is idempotent.
   */
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
    // PRE-LINK BARE REMNANT — CROSS-PROCESS (Codex P1): a STARTING/
    // STOPPING row with NO journey and NO sampled frames is a startup
    // remnant. There is no sampler loop, no evidence, and no journey to
    // protect, so ANY process may terminalize it IMMEDIATELY — treating
    // its fresh lease as a remote owner would block the camera for the
    // stale cutoff for nothing. Safe against an in-flight start: the
    // atomic create+link transaction and the promote both CAS on
    // (STARTING + owner), so this claim makes them miss and the startup
    // rolls back journey-less. The claim itself CASes on the row as
    // read; a miss means the row changed (linked, promoted, claimed) —
    // return its current state, never finalize from the stale view.
    if (
      session.journeyId === null &&
      session.framesSampled === 0 &&
      (session.status === LiveCameraSessionStatus.STARTING ||
        session.status === LiveCameraSessionStatus.STOPPING)
    ) {
      try {
        // A count of 0 means the row changed under us (linked, promoted,
        // or claimed elsewhere) — the reload below returns its current
        // state either way; the claim is all-or-nothing.
        await this.prisma.liveCameraSession.updateMany({
          where: {
            id: sessionId,
            tenantId,
            status: {
              in: [
                LiveCameraSessionStatus.STARTING,
                LiveCameraSessionStatus.STOPPING,
              ],
            },
            journeyId: null,
            framesSampled: 0,
            leaseOwner: session.leaseOwner,
            stoppedAt: null,
          },
          data: {
            status: LiveCameraSessionStatus.STOPPED,
            stoppedAt: this.now(),
            leaseOwner: null,
            finalizationMode: null,
            errorCode: session.errorCode ?? STOPPED_DURING_START,
          },
        });
      } catch (error) {
        // MANDATORY terminal write failed — never report success over a
        // stuck remnant; the caller (any process) retries this same path.
        this.logger.error(
          `live session ${sessionId} bare-remnant finalization failed ` +
            `(${classifyError(error)}) — failing the request for retry`,
        );
        throw new ConflictException(
          'live session stop is pending finalization retry ' +
            '(PRE_LINK_STOP_RETRY_REQUIRED)',
        );
      }
      return this.byId(tenantId, sessionId);
    }
    const controller = this.loops.get(sessionId);
    if (controller) {
      // ATOMIC DRAIN-LEASE ACQUISITION (Codex P1): the local loop may
      // drain and finalize ONLY while its lease still stands. The
      // predicate carries the owner token; a miss or a transport failure
      // means the lease is gone (stale claim, park, terminal) — halt the
      // zombie loop but drain nothing, mutate nothing, finalize nothing
      // from the old owner.
      const acquired = await this.prisma.liveCameraSession
        .updateMany({
          where: {
            id: sessionId,
            tenantId,
            status: { in: NON_TERMINAL_SESSION_STATUSES },
            leaseOwner: controller.leaseOwner,
            stoppedAt: null,
          },
          data: {
            status: LiveCameraSessionStatus.STOPPING,
            heartbeatAt: this.now(),
          },
        })
        .catch(() => null);
      if (!acquired || acquired.count === 0) {
        controller.stopRequested = true;
        return this.byId(tenantId, sessionId);
      }
      // DRAIN BEFORE STOPPED (Codex P1): signal the loop and WAIT for it
      // to finish its in-flight window processing and its own
      // finalization (counters persisted, closed windows swept, pending
      // motion recorded, journey closed) — bounded. The controller stays
      // registered through the loop's finalization, so a concurrent
      // stop() awaits the SAME finalization here instead of taking the
      // dead-loop path and double-finalizing. A drain timeout fails
      // closed: durable intent + abort, never READY over half-done work.
      controller.stopRequested = true;
      const drained = await this.awaitWithTimeout(
        this.loopPromises.get(sessionId),
        this.drainTimeoutMs(),
      );
      if (!drained) {
        // ATOMIC LEASE REVOCATION + FENCE (Codex P1): the stuck loop's
        // finalizer may be blocked INSIDE journeys.exit — starting a
        // second finalizer while its lease stands would let whichever
        // completes last win. ONE transaction revokes the lease
        // (owner-predicated CAS) AND stamps finalizationMode=ERROR +
        // the timeout errorCode AND the durable DRAIN_TIMEOUT intent —
        // the stamp is the journey-level fence: the journey's reconcile
        // reads it before committing READY, so the blocked original
        // exit can no longer settle the journey clean. All-or-nothing:
        // a failed intent write rolls the revocation back and the
        // previous owner keeps its lease (retry later); an unowned
        // STOPPING row without mode/code can never exist. Only after
        // the fence commits does the fail-closed finalizer run, as the
        // now-unowned row.
        let revoked = false;
        try {
          revoked = await this.prisma.$transaction(async (tx) => {
            const res = await tx.liveCameraSession.updateMany({
              where: {
                id: sessionId,
                tenantId,
                status: { in: NON_TERMINAL_SESSION_STATUSES },
                leaseOwner: controller.leaseOwner,
                stoppedAt: null,
              },
              data: {
                status: LiveCameraSessionStatus.STOPPING,
                leaseOwner: null,
                finalizationMode: 'ERROR',
                errorCode: WINDOW_DRAIN_TIMEOUT,
              },
            });
            if (res.count === 0) {
              return false;
            }
            await this.addIntent(tenantId, sessionId, WINDOW_DRAIN_TIMEOUT, tx);
            return true;
          });
        } catch (error) {
          this.logger.error(
            `live session ${sessionId} drain-timeout revocation failed ` +
              `(${classifyError(error)}) — owner lease left intact for retry`,
          );
          return this.byId(tenantId, sessionId);
        }
        if (!revoked) {
          // The loop already finalized/parked or a claimant won — never
          // finalize from this stale view.
          return this.byId(tenantId, sessionId);
        }
        try {
          await this.finalizeLiveSessionSafely(tenantId, sessionId, {
            ownerToken: null,
            mode: 'error',
            code: WINDOW_DRAIN_TIMEOUT,
            actorId,
          });
        } catch (error) {
          this.logger.error(
            `live session ${sessionId} drain-timeout finalization failed ` +
              `(${classifyError(error)}) — row left ERROR-moded for retry`,
          );
        }
        return this.byId(tenantId, sessionId);
      }
      // The loop may have PARKED a retryable finalization — resume it now
      // instead of handing the caller a STOPPING row needing another
      // stop().
      const after = await this.prisma.liveCameraSession.findFirst({
        where: { tenantId, id: sessionId },
      });
      if (after && after.status === LiveCameraSessionStatus.STOPPING) {
        await this.resumeFinalization(tenantId, sessionId, after, actorId);
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
      // never finalizes over a fresh foreign lease (Invariant C).
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
      // STALE remote owner: claim ATOMICALLY — a loop that revived keeps
      // beating and voids this claim. ONE transaction claims the lease
      // AND stamps finalizationMode=ERROR + the STALE_RECLAIMED code AND
      // the durable intent (Codex P1): a reclaimed session with null
      // mode/code could otherwise resume under normal stop semantics and
      // let its abandoned journey reconcile clean. The stamp doubles as
      // the journey-level fence (reconcile reads it before READY).
      // All-or-nothing: a failed intent write rolls the claim back.
      const cutoff = new Date(this.now().getTime() - LIVE_SESSION_STALE_MS);
      let claimed = false;
      try {
        claimed = await this.prisma.$transaction(async (tx) => {
          const res = await tx.liveCameraSession.updateMany({
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
            data: {
              status: LiveCameraSessionStatus.STOPPING,
              leaseOwner: null,
              finalizationMode: 'ERROR',
              errorCode: STALE_RECLAIMED,
            },
          });
          if (res.count === 0) {
            return false;
          }
          await this.addIntent(tenantId, sessionId, STALE_RECLAIMED_INTENT, tx);
          return true;
        });
      } catch (error) {
        this.logger.warn(
          `live session ${sessionId} stale claim failed ` +
            `(${classifyError(error)}) — nothing claimed, retry later`,
        );
        return this.byId(tenantId, sessionId);
      }
      if (!claimed) {
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
    // the stored code — the finalizer re-reads the row itself, so a
    // journey linked after any earlier snapshot is still closed.
    const current = await this.prisma.liveCameraSession.findFirst({
      where: { tenantId, id: sessionId },
    });
    if (current && current.status !== LiveCameraSessionStatus.STOPPED) {
      await this.resumeFinalization(tenantId, sessionId, current, actorId);
    }
    return this.byId(tenantId, sessionId);
  }

  /** Retry entry: route a parked/claimed row into the finalizer. The
   *  DURABLE finalizationMode column decides exit-vs-abort whenever a
   *  park recorded it — the advisory errorCode is only the legacy
   *  fallback for rows parked without a mode (e.g. stale claims), never
   *  an override (Codex P1: a marker reason must not convert an ERROR
   *  finalization into a clean STOP). */
  private async resumeFinalization(
    tenantId: string,
    sessionId: string,
    row: { errorCode: string | null; finalizationMode?: string | null },
    actorId?: string,
  ): Promise<void> {
    const code = row.errorCode;
    const mode: 'stop' | 'error' =
      row.finalizationMode === 'ERROR'
        ? 'error'
        : row.finalizationMode === 'STOP'
          ? 'stop'
          : code && !STOP_INTENT_CODES.includes(code)
            ? 'error'
            : 'stop';
    try {
      if (mode === 'error') {
        await this.finalizeLiveSessionSafely(tenantId, sessionId, {
          ownerToken: null,
          mode: 'error',
          code,
          actorId,
        });
      } else {
        await this.finalizeLiveSessionSafely(tenantId, sessionId, {
          ownerToken: null,
          mode: 'stop',
          actorId,
        });
      }
    } catch (error) {
      this.logger.error(
        `live session ${sessionId} finalization retry failed ` +
          `(${classifyError(error)}) — row left non-terminal`,
      );
    }
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
