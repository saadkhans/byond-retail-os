import { CameraSourceStatus, CameraSourceType, PilotRunStatus } from './api';

/**
 * Pure presentation logic for the Phase 12 camera registry, pilot-run
 * dashboard, and review queue — kept free of React so it is unit-testable
 * (vitest) without a DOM.
 */

export const SOURCE_TYPE_LABEL: Record<CameraSourceType, string> = {
  FILE_REPLAY: 'File replay',
  RTSP_PLACEHOLDER: 'RTSP (not enabled)',
  LOCAL_WEBCAM_PLACEHOLDER: 'Local webcam (not enabled)',
};

/** Only FILE_REPLAY is functional in the shadow pilot. */
export function isPlaceholderType(sourceType: CameraSourceType): boolean {
  return sourceType !== 'FILE_REPLAY';
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
