import { describe, expect, it } from 'vitest';
import {
  MANUAL_CROP_REASONS,
  REFERENCE_ANGLES,
  basketDeltaLabel,
  gateProgress,
  oneSkuReportPath,
  overlayRectStyle,
  validateManualCrop,
} from './one-sku-bootstrap-utils';

describe('oneSkuReportPath', () => {
  it('targets the read-only report endpoint, tenant-free (JWT carries it)', () => {
    expect(oneSkuReportPath('prod-1')).toBe('/one-sku-bootstrap/prod-1/report');
  });

  it('URL-encodes hostile product ids instead of splicing them raw', () => {
    expect(oneSkuReportPath('a/b?x=1')).toBe(
      '/one-sku-bootstrap/a%2Fb%3Fx%3D1/report',
    );
  });
});

describe('reference angle checklist', () => {
  it('covers the seven recommended capture angles', () => {
    expect(REFERENCE_ANGLES.map((angle) => angle.key)).toEqual([
      'front',
      'left',
      'right',
      'back',
      'top',
      'shelf',
      'hand',
    ]);
  });
});

describe('basketDeltaLabel', () => {
  it('formats pickup, return, and false-touch deltas', () => {
    expect(basketDeltaLabel(2)).toBe('+2');
    expect(basketDeltaLabel(-1)).toBe('−1');
    expect(basketDeltaLabel(0)).toBe('0');
  });
});

describe('validateManualCrop', () => {
  const good = {
    timestampMs: '1500',
    x: '30',
    y: '25',
    width: '50',
    height: '60',
    reason: 'PRODUCT_PICKUP',
  };

  it('accepts a valid draft and emits ONLY numeric fields plus the enum reason', () => {
    const result = validateManualCrop(good, 8000);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload).toEqual({
        timestampMs: 1500,
        x: 30,
        y: 25,
        width: 50,
        height: 60,
        reason: 'PRODUCT_PICKUP',
      });
      // The payload's closed key set is the unsafe-content guarantee:
      // there is no field a path, URL, or credential could travel in.
      expect(Object.keys(result.payload).sort()).toEqual([
        'height',
        'reason',
        'timestampMs',
        'width',
        'x',
        'y',
      ]);
    }
  });

  it('omits the reason key entirely when blank', () => {
    const result = validateManualCrop({ ...good, reason: '' }, 8000);
    expect(result.ok && 'reason' in result.payload).toBe(false);
  });

  it('rejects free-text reasons — paths and sources are unrepresentable', () => {
    for (const hostile of [
      'C:/videos/raw.mp4',
      '../../etc/passwd',
      'https://camera.local/stream',
      'ANY_FREE_TEXT',
    ]) {
      const result = validateManualCrop({ ...good, reason: hostile }, 8000);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.reason).toBeDefined();
      }
    }
  });

  it('rejects non-integer coordinates instead of coercing them', () => {
    for (const bad of ['', ' ', '-5', '1.5', '1e3', 'ten', '10px']) {
      const result = validateManualCrop({ ...good, x: bad }, 8000);
      expect(result.ok).toBe(false);
    }
  });

  it('rejects zero-sized boxes and out-of-range timestamps', () => {
    expect(validateManualCrop({ ...good, width: '0' }, 8000).ok).toBe(false);
    expect(validateManualCrop({ ...good, timestampMs: '8000' }, 8000).ok).toBe(
      false,
    );
    expect(validateManualCrop({ ...good, timestampMs: '7999' }, 8000).ok).toBe(
      true,
    );
  });

  it('keeps the reason list identical to the server enum', () => {
    expect([...MANUAL_CROP_REASONS]).toEqual([
      'PRODUCT_PICKUP',
      'PRODUCT_RETURN',
      'SHELF_AUDIT',
      'CART_INSERTION',
      'OCR_REVIEW',
      'VLM_REVIEW',
    ]);
  });
});

describe('overlayRectStyle', () => {
  it('scales a native-pixel box to percentages over the frame', () => {
    expect(
      overlayRectStyle(
        { x: 480, y: 270, width: 960, height: 540 },
        { width: 1920, height: 1080 },
      ),
    ).toEqual({ left: '25.00%', top: '25.00%', width: '50.00%', height: '50.00%' });
  });

  it('clamps instead of overflowing the preview', () => {
    const rect = overlayRectStyle(
      { x: 1800, y: 1000, width: 900, height: 500 },
      { width: 1920, height: 1080 },
    );
    expect(rect?.left).toBe('93.75%');
    expect(rect?.width).toBe('46.88%');
  });

  it('returns null for a degenerate frame', () => {
    expect(
      overlayRectStyle({ x: 0, y: 0, width: 1, height: 1 }, { width: 0, height: 0 }),
    ).toBeNull();
  });
});

describe('gateProgress', () => {
  it('counts required gates only', () => {
    expect(
      gateProgress([
        { satisfied: true, required: true },
        { satisfied: false, required: true },
        { satisfied: false, required: false },
      ]),
    ).toEqual({ satisfied: 1, total: 2 });
  });
});
