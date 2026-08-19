import { describe, expect, it } from 'vitest';
import {
  calibrationReadinessTone,
  formatNextAction,
  formatWarning,
  parsePolygonInput,
  polygonToInput,
  profileStatusTone,
} from './camera-calibration-utils';

describe('camera-calibration-utils', () => {
  it('readiness tones: READY ok · WARNING warn · NOT_READY down · unknown down', () => {
    expect(calibrationReadinessTone('READY')).toBe('ok');
    expect(calibrationReadinessTone('WARNING')).toBe('warn');
    expect(calibrationReadinessTone('NOT_READY')).toBe('down');
    expect(calibrationReadinessTone('SOMETHING_ELSE')).toBe('down');
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
