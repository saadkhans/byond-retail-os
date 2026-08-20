import { describe, expect, it } from 'vitest';
import {
  ZoneFormValues,
  buildZoneCreateBody,
  buildZoneUpdateBody,
  calibrationReadinessTone,
  formatNextAction,
  formatReadiness,
  formatWarning,
  hardeningStatusMessage,
  parsePolygonInput,
  polygonToInput,
  preflightCalibrationSummary,
  profileStatusTone,
} from './camera-calibration-utils';

const zoneForm = (overrides: Partial<ZoneFormValues> = {}): ZoneFormValues => ({
  zoneType: 'SHELF_ZONE',
  label: ' Front shelf zone A ',
  polygon: [
    { x: 0.1, y: 0.2 },
    { x: 0.9, y: 0.2 },
    { x: 0.5, y: 0.8 },
  ],
  qualityScoreText: '0.9',
  sortOrderText: '3',
  isActive: true,
  expectedProductIdsText: 'prod-1, prod-2',
  ...overrides,
});

describe('camera-calibration-utils', () => {
  it('readiness tones: READY ok · WARNING warn · NOT_READY down · NOT_APPLICABLE neutral · unknown down', () => {
    expect(calibrationReadinessTone('READY')).toBe('ok');
    expect(calibrationReadinessTone('WARNING')).toBe('warn');
    expect(calibrationReadinessTone('NOT_READY')).toBe('down');
    expect(calibrationReadinessTone('NOT_APPLICABLE')).toBe('');
    expect(calibrationReadinessTone('SOMETHING_ELSE')).toBe('down');
  });

  it('formats readiness labels, mapping NOT_APPLICABLE to a not-required label', () => {
    expect(formatReadiness('READY')).toBe('READY');
    expect(formatReadiness('WARNING')).toBe('WARNING');
    expect(formatReadiness('NOT_READY')).toBe('NOT READY');
    expect(formatReadiness('NOT_APPLICABLE')).toBe('NOT REQUIRED');
  });

  it('zone create body includes zoneType and all editable fields', () => {
    const body = buildZoneCreateBody(zoneForm());
    expect(body.zoneType).toBe('SHELF_ZONE');
    expect(body.label).toBe('Front shelf zone A');
    expect(body.polygon).toHaveLength(3);
    expect(body.qualityScore).toBe(0.9);
    expect(body.sortOrder).toBe(3);
    expect(body.isActive).toBe(true);
    expect(body.expectedProductIds).toEqual(['prod-1', 'prod-2']);
  });

  it('zone create body omits an empty expected-product list', () => {
    const body = buildZoneCreateBody(zoneForm({ expectedProductIdsText: '' }));
    expect('expectedProductIds' in body).toBe(false);
  });

  it('zone update (PATCH) body never includes zoneType', () => {
    const body = buildZoneUpdateBody(zoneForm());
    expect('zoneType' in body).toBe(false);
    // Every editable field still travels.
    expect(body.label).toBe('Front shelf zone A');
    expect(body.polygon).toEqual(zoneForm().polygon);
    expect(body.qualityScore).toBe(0.9);
    expect(body.sortOrder).toBe(3);
    expect(body.isActive).toBe(true);
    expect(body.expectedProductIds).toEqual(['prod-1', 'prod-2']);
  });

  it('zone update sends an empty expectedProductIds array for shelf zones (replace-all clears)', () => {
    const body = buildZoneUpdateBody(zoneForm({ expectedProductIdsText: ' ' }));
    expect(body.expectedProductIds).toEqual([]);
  });

  it('non-shelf zones never send expectedProductIds', () => {
    const update = buildZoneUpdateBody(zoneForm({ zoneType: 'IGNORE_ZONE' }));
    expect('expectedProductIds' in update).toBe(false);
    const create = buildZoneCreateBody(zoneForm({ zoneType: 'IGNORE_ZONE' }));
    expect('expectedProductIds' in create).toBe(false);
  });

  it('zone bodies omit qualityScore when blank and default sortOrder to 0', () => {
    const body = buildZoneUpdateBody(
      zoneForm({ qualityScoreText: '', sortOrderText: '' }),
    );
    expect('qualityScore' in body).toBe(false);
    expect(body.sortOrder).toBe(0);
  });

  it('hardening status follows readiness, never the empty recommendation list', () => {
    expect(hardeningStatusMessage('NOT_READY', 0)).toContain('NOT READY');
    expect(hardeningStatusMessage('WARNING', 0)).toContain('Not fully ready');
    expect(hardeningStatusMessage('READY', 0)).toContain('Ready for testing');
    expect(hardeningStatusMessage('READY', 2)).toContain('Ready for testing');
    expect(hardeningStatusMessage('NOT_APPLICABLE', 0)).toContain(
      'not required',
    );
  });

  it('preflight calibration summary: failing gate → NOT READY with warnings passed through', () => {
    const summary = preflightCalibrationSummary({
      calibrationReady: false,
      calibration: {
        readiness: 'NOT_READY',
        warnings: ['NO_ACTIVE_CALIBRATION_PROFILE'],
      },
    });
    expect(summary.label).toBe('NOT READY');
    expect(summary.tone).toBe('down');
    expect(summary.warnings).toEqual(['NO_ACTIVE_CALIBRATION_PROFILE']);
  });

  it('preflight calibration summary: NOT_APPLICABLE → not required, no warnings', () => {
    const summary = preflightCalibrationSummary({
      calibration: { readiness: 'NOT_APPLICABLE', warnings: [] },
    });
    expect(summary.label).toBe('not required');
    expect(summary.tone).toBe('');
    expect(summary.warnings).toEqual([]);
  });

  it('preflight calibration summary: null block → unknown; READY → ready; WARNING → warnings', () => {
    expect(preflightCalibrationSummary({ calibration: null }).label).toBe(
      'unknown',
    );
    expect(
      preflightCalibrationSummary({
        calibrationReady: true,
        calibration: { readiness: 'READY', warnings: [] },
      }),
    ).toEqual({ label: 'ready', tone: 'ok', warnings: [] });
    const warning = preflightCalibrationSummary({
      calibrationReady: true,
      calibration: { readiness: 'WARNING', warnings: ['NO_EXPECTED_PRODUCTS'] },
    });
    expect(warning.label).toBe('warnings');
    expect(warning.tone).toBe('warn');
    expect(warning.warnings).toEqual(['NO_EXPECTED_PRODUCTS']);
  });

  it('profile status tones: ACTIVE ok · DRAFT warn · ARCHIVED down · unknown neutral', () => {
    expect(profileStatusTone('ACTIVE')).toBe('ok');
    expect(profileStatusTone('DRAFT')).toBe('warn');
    expect(profileStatusTone('ARCHIVED')).toBe('down');
    expect(profileStatusTone('WHATEVER')).toBe('');
  });

  it('parses a valid polygon (one x,y pair per line, blank lines ignored)', () => {
    const result = parsePolygonInput('0,0\n1,0\n\n  0.5 , 0.75 \n');
    expect(result.error).toBeUndefined();
    expect(result.points).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0.5, y: 0.75 },
    ]);
  });

  it('rejects fewer than 3 points', () => {
    expect(parsePolygonInput('').error).toBe('POLYGON_TOO_FEW_POINTS');
    expect(parsePolygonInput('0,0\n1,1').error).toBe('POLYGON_TOO_FEW_POINTS');
  });

  it('rejects more than 20 points', () => {
    const lines = Array.from({ length: 21 }, () => '0.5,0.5').join('\n');
    expect(parsePolygonInput(lines).error).toBe('POLYGON_TOO_MANY_POINTS');
  });

  it('rejects malformed pairs', () => {
    expect(parsePolygonInput('0,0\n1,1\n0.5').error).toBe(
      'POLYGON_POINT_MALFORMED',
    );
    expect(parsePolygonInput('0,0\n1,1\n0.5,').error).toBe(
      'POLYGON_POINT_MALFORMED',
    );
    expect(parsePolygonInput('0,0\n1,1\n0.1,0.2,0.3').error).toBe(
      'POLYGON_POINT_MALFORMED',
    );
  });

  it('rejects non-numeric coordinates', () => {
    expect(parsePolygonInput('0,0\n1,1\nabc,0.5').error).toBe(
      'POLYGON_POINT_NOT_NUMERIC',
    );
    expect(parsePolygonInput('0,0\n1,1\n0.5,NaN').error).toBe(
      'POLYGON_POINT_NOT_NUMERIC',
    );
  });

  it('rejects coordinates outside 0..1', () => {
    expect(parsePolygonInput('0,0\n1,1\n1.5,0.5').error).toBe(
      'POLYGON_POINT_OUT_OF_RANGE',
    );
    expect(parsePolygonInput('0,0\n1,1\n0.5,-0.1').error).toBe(
      'POLYGON_POINT_OUT_OF_RANGE',
    );
  });

  it('round-trips a polygon through polygonToInput', () => {
    const text = polygonToInput([
      { x: 0.1, y: 0.2 },
      { x: 0.9, y: 0.2 },
      { x: 0.5, y: 0.8 },
    ]);
    expect(parsePolygonInput(text).points).toEqual([
      { x: 0.1, y: 0.2 },
      { x: 0.9, y: 0.2 },
      { x: 0.5, y: 0.8 },
    ]);
  });

  it('formats known next actions and falls back to the raw value', () => {
    expect(formatNextAction('ADD_SHELF_ZONE')).toBe('Add a shelf zone');
    expect(formatNextAction('RUN_PHASE16_TEST_PROTOCOL')).toBe(
      'Run a Phase 16 test protocol',
    );
    expect(formatNextAction('ENABLE_CAMERA_SOURCE')).toBe(
      'Enable the camera source',
    );
    expect(formatNextAction('SOMETHING_NEW')).toBe('SOMETHING_NEW');
  });

  it('formats known warnings and falls back to the raw value', () => {
    expect(formatWarning('NO_SHELF_ZONE')).toBe('No shelf zone defined');
    expect(formatWarning('LIVE_SESSION_ALREADY_ACTIVE')).toBe(
      'A live session is already active',
    );
    expect(formatWarning('SOMETHING_NEW')).toBe('SOMETHING_NEW');
  });
});
