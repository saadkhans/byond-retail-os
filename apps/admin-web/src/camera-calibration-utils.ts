import {
  CalibrationPolygonPoint,
  CalibrationReadinessLevel,
  CameraCalibrationProfileStatus,
  CameraCalibrationZoneType,
} from './api';

/** Phase 17 helpers — pure formatting/parsing, no data access. */

export const POLYGON_MIN_POINTS = 3;
export const POLYGON_MAX_POINTS = 20;

export function calibrationReadinessTone(
  readiness: CalibrationReadinessLevel | string,
): 'ok' | 'warn' | 'down' | '' {
  if (readiness === 'READY') {
    return 'ok';
  }
  if (readiness === 'WARNING') {
    return 'warn';
  }
  // Not-applicable (FILE_REPLAY) is neutral — it must not read as a failure.
  if (readiness === 'NOT_APPLICABLE') {
    return '';
  }
  return 'down';
}

export function formatReadiness(
  readiness: CalibrationReadinessLevel | string,
): string {
  if (readiness === 'NOT_APPLICABLE') {
    return 'NOT REQUIRED';
  }
  if (readiness === 'NOT_READY') {
    return 'NOT READY';
  }
  return readiness;
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

/** Zone form values as the page holds them (text inputs still raw). */
export interface ZoneFormValues {
  zoneType: CameraCalibrationZoneType;
  label: string;
  polygon: CalibrationPolygonPoint[];
  qualityScoreText: string;
  sortOrderText: string;
  isActive: boolean;
  expectedProductIdsText: string;
}

/** PATCH body for a zone edit. zoneType is deliberately absent: the API DTO
 *  does not whitelist it (forbidNonWhitelisted rejects it with 400), so the
 *  type is immutable after creation. */
export interface ZoneUpdateBody {
  label: string;
  polygon: CalibrationPolygonPoint[];
  qualityScore?: number;
  sortOrder: number;
  isActive: boolean;
  expectedProductIds?: string[];
}

export interface ZoneCreateBody extends ZoneUpdateBody {
  zoneType: CameraCalibrationZoneType;
}

export function parseExpectedProductIds(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((id) => id.trim())
    .filter(Boolean);
}

/** Build the PATCH body for a zone edit. Never includes zoneType. For shelf
 *  zones expectedProductIds is always sent (replace-all — an empty array
 *  clears the set); other zone types never send the field. */
export function buildZoneUpdateBody(form: ZoneFormValues): ZoneUpdateBody {
  return {
    label: form.label.trim(),
    polygon: form.polygon,
    ...(form.qualityScoreText.trim()
      ? { qualityScore: Number(form.qualityScoreText) }
      : {}),
    sortOrder: Number(form.sortOrderText) || 0,
    isActive: form.isActive,
    ...(form.zoneType === 'SHELF_ZONE'
      ? { expectedProductIds: parseExpectedProductIds(form.expectedProductIdsText) }
      : {}),
  };
}

/** Build the POST body for a new zone — the update body plus the immutable
 *  zoneType; an empty product list is omitted rather than sent. */
export function buildZoneCreateBody(form: ZoneFormValues): ZoneCreateBody {
  const body: ZoneCreateBody = {
    zoneType: form.zoneType,
    ...buildZoneUpdateBody(form),
  };
  if (body.expectedProductIds && body.expectedProductIds.length === 0) {
    delete body.expectedProductIds;
  }
  return body;
}

/** Status line for the pilot hardening report panel. An empty
 *  recommendation list must never read as "ready" on its own — only the
 *  readiness level decides the message. */
export function hardeningStatusMessage(
  readiness: CalibrationReadinessLevel | string,
  recommendedNextActionCount: number,
): string {
  if (readiness === 'READY') {
    return recommendedNextActionCount > 0
      ? 'Ready for testing — recommendations above are optional improvements.'
      : 'Ready for testing — no recommendations.';
  }
  if (readiness === 'NOT_APPLICABLE') {
    return 'Calibration is not required for this source type.';
  }
  if (readiness === 'WARNING') {
    return 'Not fully ready — review the calibration readiness warnings above.';
  }
  return 'NOT READY for live testing — resolve the calibration readiness warnings above.';
}

/** Compact calibration row for the Phase 16 preflight display. */
export function preflightCalibrationSummary(preflight: {
  calibrationReady?: boolean;
  calibration: {
    readiness: CalibrationReadinessLevel | string;
    warnings: string[];
  } | null;
}): { label: string; tone: 'ok' | 'warn' | 'down' | ''; warnings: string[] } {
  const calibration = preflight.calibration;
  if (!calibration) {
    return { label: 'unknown', tone: '', warnings: [] };
  }
  if (calibration.readiness === 'NOT_APPLICABLE') {
    return { label: 'not required', tone: '', warnings: [] };
  }
  if (preflight.calibrationReady === false || calibration.readiness === 'NOT_READY') {
    return { label: 'NOT READY', tone: 'down', warnings: calibration.warnings };
  }
  if (calibration.readiness === 'WARNING') {
    return { label: 'warnings', tone: 'warn', warnings: calibration.warnings };
  }
  return { label: 'ready', tone: 'ok', warnings: [] };
}

const NEXT_ACTION_LABELS: Record<string, string> = {
  CREATE_CALIBRATION_PROFILE: 'Create a calibration profile',
  ADD_SHELF_ZONE: 'Add a shelf zone',
  ADD_INTERACTION_ZONE: 'Add an interaction zone',
  ASSIGN_EXPECTED_PRODUCTS: 'Assign expected products to shelf zones',
  RUN_PHASE16_TEST_PROTOCOL: 'Run a Phase 16 test protocol',
  REVIEW_MISSED_EVENTS: 'Review missed events',
  EXPORT_REVIEWED_DATASET: 'Export the reviewed dataset',
  ENABLE_CAMERA_SOURCE: 'Enable the camera source',
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
