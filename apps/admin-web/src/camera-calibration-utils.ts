import {
  CalibrationPolygonPoint,
  CalibrationReadinessLevel,
  CameraCalibrationProfileStatus,
} from './api';

/** Phase 17 helpers — pure formatting/parsing, no data access. */

export const POLYGON_MIN_POINTS = 3;
export const POLYGON_MAX_POINTS = 20;

export function calibrationReadinessTone(
  readiness: CalibrationReadinessLevel | string,
): 'ok' | 'warn' | 'down' {
  if (readiness === 'READY') {
    return 'ok';
  }
  if (readiness === 'WARNING') {
    return 'warn';
  }
  return 'down';
}

export function profileStatusTone(
  status: CameraCalibrationProfileStatus | string,
): string {
  if (status === 'ACTIVE') {
    return 'ok';
  }
  if (status === 'DRAFT') {
    return 'warn';
  }
  if (status === 'ARCHIVED') {
    return 'down';
  }
  return '';
}

/** Parse a normalized polygon from a textarea: one `x,y` pair per line,
 *  every coordinate in 0..1. Returns a controlled error string only —
 *  never echoes the raw input back. */
export function parsePolygonInput(text: string): {
  points?: CalibrationPolygonPoint[];
  error?: string;
} {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length < POLYGON_MIN_POINTS) {
    return { error: 'POLYGON_TOO_FEW_POINTS' };
  }
  if (lines.length > POLYGON_MAX_POINTS) {
    return { error: 'POLYGON_TOO_MANY_POINTS' };
  }
  const points: CalibrationPolygonPoint[] = [];
  for (const line of lines) {
    const parts = line.split(',').map((part) => part.trim());
    if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
      return { error: 'POLYGON_POINT_MALFORMED' };
    }
    const x = Number(parts[0]);
    const y = Number(parts[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return { error: 'POLYGON_POINT_NOT_NUMERIC' };
    }
    if (x < 0 || x > 1 || y < 0 || y > 1) {
      return { error: 'POLYGON_POINT_OUT_OF_RANGE' };
    }
    points.push({ x, y });
  }
  return { points };
}

/** Render a polygon back into the textarea format parsePolygonInput reads. */
export function polygonToInput(points: CalibrationPolygonPoint[]): string {
  return points.map((point) => `${point.x},${point.y}`).join('\n');
}

const NEXT_ACTION_LABELS: Record<string, string> = {
  CREATE_CALIBRATION_PROFILE: 'Create a calibration profile',
  ADD_SHELF_ZONE: 'Add a shelf zone',
  ADD_INTERACTION_ZONE: 'Add an interaction zone',
  ASSIGN_EXPECTED_PRODUCTS: 'Assign expected products to shelf zones',
  RUN_PHASE16_TEST_PROTOCOL: 'Run a Phase 16 test protocol',
  REVIEW_MISSED_EVENTS: 'Review missed events',
  EXPORT_REVIEWED_DATASET: 'Export the reviewed dataset',
  IMPROVE_CAMERA_ANGLE: 'Improve the camera angle',
  CHECK_LIGHTING: 'Check lighting',
  REDUCE_OCCLUSION: 'Reduce shelf occlusion',
};

export function formatNextAction(action: string): string {
  return NEXT_ACTION_LABELS[action] ?? action;
}

const WARNING_LABELS: Record<string, string> = {
  NO_ACTIVE_CALIBRATION_PROFILE: 'No active calibration profile',
  NO_SHELF_ZONE: 'No shelf zone defined',
  NO_INTERACTION_ZONE: 'No interaction zone defined',
  NO_EXPECTED_PRODUCTS: 'No expected products assigned',
  FRAME_DIMENSIONS_UNKNOWN: 'Frame dimensions unknown',
  ORIENTATION_UNKNOWN: 'Orientation unknown',
  CAMERA_MOUNT_UNKNOWN: 'Camera mount unknown',
  SOURCE_NOT_ACTIVE: 'Camera source is not active',
  LIVE_SESSION_ALREADY_ACTIVE: 'A live session is already active',
};

export function formatWarning(warning: string): string {
  return WARNING_LABELS[warning] ?? warning;
}
