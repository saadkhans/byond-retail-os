import { describe, expect, it } from 'vitest';
import {
  SOURCE_TYPE_LABEL,
  formatClipOffset,
  isPlaceholderType,
  liveSessionStatusTone,
  runStatusTone,
  sourceStatusTone,
  vlmCounterLabel,
} from './camera-utils';

describe('camera-utils', () => {
  it('labels every source type, marking placeholders "not enabled"', () => {
    expect(SOURCE_TYPE_LABEL.FILE_REPLAY).toBe('File replay');
    expect(SOURCE_TYPE_LABEL.RTSP_PLACEHOLDER).toContain('not enabled');
    expect(SOURCE_TYPE_LABEL.LOCAL_WEBCAM_PLACEHOLDER).toContain('not enabled');
    expect(SOURCE_TYPE_LABEL.RTSP_SHADOW).toBe('RTSP (shadow)');
    expect(SOURCE_TYPE_LABEL.RTSP_SHADOW).not.toContain('not enabled');
  });

  it('FILE_REPLAY and RTSP_SHADOW are functional; only *_PLACEHOLDER are placeholders', () => {
    expect(isPlaceholderType('FILE_REPLAY')).toBe(false);
    expect(isPlaceholderType('RTSP_SHADOW')).toBe(false);
    expect(isPlaceholderType('RTSP_PLACEHOLDER')).toBe(true);
    expect(isPlaceholderType('LOCAL_WEBCAM_PLACEHOLDER')).toBe(true);
  });

  it('maps live session status to badge tones (STOPPED stays neutral)', () => {
    expect(liveSessionStatusTone('RUNNING')).toBe('ok');
    expect(liveSessionStatusTone('STARTING')).toBe('warn');
    expect(liveSessionStatusTone('STOPPING')).toBe('warn');
    expect(liveSessionStatusTone('STOPPED')).toBe('');
    expect(liveSessionStatusTone('ERROR')).toBe('down');
  });

  it('maps source status to badge tones', () => {
    expect(sourceStatusTone('ACTIVE')).toBe('ok');
    expect(sourceStatusTone('DISABLED')).toBe('warn');
    expect(sourceStatusTone('ERROR')).toBe('down');
  });

  it('maps run status to badge tones', () => {
    expect(runStatusTone('SUCCEEDED')).toBe('ok');
    expect(runStatusTone('RUNNING')).toBe('warn');
    expect(runStatusTone('FAILED')).toBe('down');
  });

  it('formats VLM counters as invoked · skipped · failed', () => {
    expect(vlmCounterLabel({ vlmInvoked: 2, vlmSkipped: 1, vlmFailed: 0 })).toBe(
      '2 · 1 · 0',
    );
  });

  it('formats clip offsets in seconds', () => {
    expect(formatClipOffset(12400)).toBe('12.4s');
    expect(formatClipOffset(0)).toBe('0.0s');
  });
});
