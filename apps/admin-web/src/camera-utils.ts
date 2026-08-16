import {
  CameraSourceStatus,
  CameraSourceType,
  LiveSessionStatus,
  PilotRunStatus,
} from './api';

/**
 * Pure presentation logic for the Phase 12/13 camera registry, pilot-run
 * dashboard, live sessions, and review queue — kept free of React so it
 * is unit-testable (vitest) without a DOM.
 */

export const SOURCE_TYPE_LABEL: Record<CameraSourceType, string> = {
  FILE_REPLAY: 'File replay',
  RTSP_PLACEHOLDER: 'RTSP (not enabled)',
  LOCAL_WEBCAM_PLACEHOLDER: 'Local webcam (not enabled)',
  RTSP_SHADOW: 'RTSP (shadow)',
};

/** FILE_REPLAY and RTSP_SHADOW are functional; the *_PLACEHOLDER types
 *  can never activate (Phase 12 rule, unchanged). */
export function isPlaceholderType(sourceType: CameraSourceType): boolean {
  return (
    sourceType === 'RTSP_PLACEHOLDER' ||
    sourceType === 'LOCAL_WEBCAM_PLACEHOLDER'
  );
}

/** RUNNING ok · STARTING/STOPPING warn · ERROR down · STOPPED neutral. */
export function liveSessionStatusTone(
  status: LiveSessionStatus | string,
): string {
  if (status === 'RUNNING') {
    return 'ok';
  }
  if (status === 'ERROR') {
    return 'down';
  }
  if (status === 'STOPPED') {
    return '';
  }
  return 'warn';
}

export function sourceStatusTone(status: CameraSourceStatus | string): string {
  return status === 'ACTIVE' ? 'ok' : status === 'ERROR' ? 'down' : 'warn';
}

export function runStatusTone(status: PilotRunStatus | string): string {
  return status === 'SUCCEEDED' ? 'ok' : status === 'FAILED' ? 'down' : 'warn';
}

/** "2 · 1 · 0" — invoked · skipped · failed. */
export function vlmCounterLabel(run: {
  vlmInvoked: number;
  vlmSkipped: number;
  vlmFailed: number;
}): string {
  return `${run.vlmInvoked} · ${run.vlmSkipped} · ${run.vlmFailed}`;
}

/** Millisecond offset inside a clip → "12.4s". */
export function formatClipOffset(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}
