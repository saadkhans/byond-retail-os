import { Trigger, TriggerKind } from '../trigger/trigger.types';
import { InferenceJobRequest } from './inference-client.port';
import { findForbiddenMediaPath } from './media-policy';

/**
 * Turns a trigger into an inference-job request.
 *
 * Two rules govern everything here.
 *
 * FIRST, the descriptor carries NUMBERS AND OPAQUE IDS ONLY. Frame
 * indices, a zone code, motion ratios, a frame count, timestamps. No
 * crop, no frame, no path, no camera address. The heavy tier fetches its
 * own high-resolution pixels through the API's own media path; the
 * pipeline's job is to say WHEN and WHERE to look, and "where" is a zone
 * code the operator configured, not a location on a disk.
 *
 * SECOND, it FAILS CLOSED. The built descriptor is screened before it is
 * handed back, and a screening hit returns a rejection rather than a
 * sanitised request. Sanitising would hide the bug; dropping the trigger
 * and counting it surfaces it.
 */

/** Maps a trigger to the API's job type vocabulary. */
const JOB_TYPE_BY_TRIGGER: Record<TriggerKind, string> = {
  // A hand in a shelf zone is the moment product recognition exists for.
  HAND_IN_ZONE: 'PRODUCT_RECOGNITION',
  // A change with no localised zone is a shelf-level question.
  SHELF_CHANGE: 'SHELF_AUDIT',
  // Exit is the reconciliation moment, not a recognition one.
  CUSTOMER_EXIT: 'EXIT_RECONCILIATION',
};

export interface JobRequestContext {
  locationId?: string;
  unitId?: string;
  deviceId?: string;
  /** Opaque run identifier, so every job from one tracking run correlates.
   *  Generated at startup; never derived from a camera address. */
  runId: string;
  /** Which tracker produced the observations, for downstream provenance. */
  trackerKind: string;
  /** Whether the frames behind these numbers were real camera bytes. */
  readsRealBytes: boolean;
}

export type BuildResult =
  | { ok: true; request: InferenceJobRequest }
  | { ok: false; reason: 'MEDIA_POLICY'; path: string };

/**
 * Idempotency key. At-least-once delivery is the norm — a retry after a
 * timeout cannot know whether the first attempt landed — so the key must
 * be a pure function of the moment, not of the attempt. Run id, kind,
 * zone and the frame range identify a moment exactly and repeat across
 * retries.
 */
export function idempotencyKeyFor(
  runId: string,
  trigger: Trigger,
): string {
  const zone = trigger.zoneCode ?? 'scene';
  return `${runId}.${trigger.kind}.${zone}.${trigger.startFrameIndex}-${trigger.endFrameIndex}`;
}

export function buildJobRequest(
  trigger: Trigger,
  context: JobRequestContext,
): BuildResult {
  const inputDescriptor: Record<string, unknown> = {
    trigger: {
      kind: trigger.kind,
      // Present only when the moment was localised. An absent zone is
      // meaningful — it says the change was not attributable to one cell.
      ...(trigger.zoneCode === undefined ? {} : { zoneCode: trigger.zoneCode }),
      startedAt: trigger.startedAt.toISOString(),
      endedAt: trigger.endedAt.toISOString(),
      startFrameIndex: trigger.startFrameIndex,
      endFrameIndex: trigger.endFrameIndex,
    },
    evidence: {
      peakMotionRatio: round(trigger.evidence.peakMotionRatio),
      peakZoneCoverage: round(trigger.evidence.peakZoneCoverage),
      peakPresenceConfidence: round(trigger.evidence.peakPresenceConfidence),
      frameCount: trigger.evidence.frameCount,
    },
    provenance: {
      runId: context.runId,
      tracker: context.trackerKind,
      // The API and its operators must be able to tell a rehearsal from a
      // camera. This is the same distinction the video extractor draws.
      observedRealBytes: context.readsRealBytes,
      tier: 'TRACKING_TRIGGER',
    },
  };

  const offendingPath = findForbiddenMediaPath(inputDescriptor);
  if (offendingPath !== null) {
    return { ok: false, reason: 'MEDIA_POLICY', path: offendingPath };
  }

  return {
    ok: true,
    request: {
      jobType: JOB_TYPE_BY_TRIGGER[trigger.kind],
      ...(context.locationId === undefined
        ? {}
        : { locationId: context.locationId }),
      ...(context.unitId === undefined ? {} : { unitId: context.unitId }),
      ...(context.deviceId === undefined ? {} : { deviceId: context.deviceId }),
      priority: priorityFor(trigger.kind),
      sourceType: 'VISION',
      sourceId: idempotencyKeyFor(context.runId, trigger),
      inputDescriptor,
      idempotencyKey: idempotencyKeyFor(context.runId, trigger),
    },
  };
}

/**
 * A customer walking out is the only moment with a deadline attached, so
 * it outranks a hand in a zone, which in turn outranks a shelf audit
 * nobody is waiting on. A switch rather than a lookup table because it is
 * exhaustive over the union: adding a trigger kind fails the build here.
 */
function priorityFor(kind: TriggerKind): number {
  switch (kind) {
    case 'CUSTOMER_EXIT':
      return 300;
    case 'HAND_IN_ZONE':
      return 200;
    case 'SHELF_CHANGE':
      return 100;
  }
}

/** Three decimals is well past the precision a coarse grid can justify,
 *  and it keeps the descriptor small and stable across runs. */
function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
