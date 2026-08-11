import { describe, expect, it } from 'vitest';
import { PickupDetectionState } from './api';
import {
  canReview,
  confidencePercent,
  detectionHeadline,
  formatMs,
  jobInFlight,
  jobStatusLabel,
  markerPercent,
  validateGroundTruth,
} from './pickup-detection-utils';

function stateWith(
  detection: Partial<NonNullable<PickupDetectionState['detection']>> | null,
): PickupDetectionState {
  return {
    enabled: true,
    job: null,
    detection:
      detection === null
        ? null
        : ({
            version: 1,
            kind: 'PRODUCT_PICKUP_DETECTION',
            result: 'PRODUCT_MATCHED',
            confidence: 0.8,
            eventStartMs: 1000,
            eventPeakMs: 2000,
            eventEndMs: 3000,
            boundingBox: { x: 0, y: 0, width: 10, height: 10 },
            sourceFrameArtifactId: null,
            cropArtifactId: null,
            productId: 'p1',
            sku: 'SKU-1',
            analysisFps: 5,
            modelKey: 'classical-hsv-histogram+ncc',
            modelVersion: '1.0.0',
            visionEventId: 'e1',
            visionEventStatus: 'PENDING_REVIEW',
            productName: 'Cola Can',
            candidates: [],
            review: null,
            ...detection,
          } as NonNullable<PickupDetectionState['detection']>),
  };
}

describe('confidencePercent', () => {
  it('rounds to whole percent and clamps', () => {
    expect(confidencePercent(0.6234)).toBe('62%');
    expect(confidencePercent(1.4)).toBe('100%');
    expect(confidencePercent(-0.1)).toBe('0%');
  });
});

describe('markerPercent', () => {
  it('positions the marker proportionally and clamps to the bar', () => {
    expect(markerPercent(3000, 12_000)).toBe(25);
    expect(markerPercent(15_000, 12_000)).toBe(100);
    expect(markerPercent(500, null)).toBe(0);
    expect(markerPercent(500, 0)).toBe(0);
  });
});

describe('formatMs', () => {
  it('renders seconds with one decimal', () => {
    expect(formatMs(2500)).toBe('2.5 s');
    expect(formatMs(0)).toBe('0.0 s');
  });
});

describe('job status mapping', () => {
  it('maps SUCCEEDED to the UI vocabulary COMPLETED', () => {
    expect(jobStatusLabel('SUCCEEDED')).toBe('COMPLETED');
    expect(jobStatusLabel('QUEUED')).toBe('QUEUED');
    expect(jobStatusLabel('RUNNING')).toBe('RUNNING');
    expect(jobStatusLabel('FAILED')).toBe('FAILED');
  });

  it('polls only while queued or running', () => {
    expect(jobInFlight('QUEUED')).toBe(true);
    expect(jobInFlight('RUNNING')).toBe(true);
    expect(jobInFlight('SUCCEEDED')).toBe(false);
    expect(jobInFlight('FAILED')).toBe(false);
    expect(jobInFlight(undefined)).toBe(false);
  });
});

describe('detectionHeadline', () => {
  it('names the matched product and SKU', () => {
    expect(detectionHeadline(stateWith({}))).toBe(
      'Pickup detected — Cola Can (SKU-1)',
    );
  });

  it('never claims a product for UNKNOWN_PRODUCT', () => {
    const headline = detectionHeadline(
      stateWith({
        result: 'UNKNOWN_PRODUCT',
        productId: null,
        sku: null,
        productName: null,
      }),
    );
    expect(headline).toContain('not recognized');
    expect(headline).not.toContain('SKU-1');
  });

  it('is null with no detection', () => {
    expect(detectionHeadline(stateWith(null))).toBeNull();
  });
});

describe('validateGroundTruth', () => {
  const base = {
    eventKind: 'PICKUP' as const,
    productId: 'prod-cuid-1',
    timestampMs: '1600',
    quantity: '1',
    durationMs: 5987,
  };

  it('accepts a complete pickup and emits NUMBERS + the canonical productId', () => {
    const result = validateGroundTruth(base);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload).toEqual({
        eventKind: 'PICKUP',
        productId: 'prod-cuid-1',
        actualTimestampMs: 1600,
        quantity: 1,
      });
      expect(typeof result.payload.actualTimestampMs).toBe('number');
    }
  });

  it('rejects a missing product with a field-level message', () => {
    const result = validateGroundTruth({ ...base, productId: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.productId).toBeTruthy();
  });

  it('rejects empty, NaN, negative, and beyond-duration timestamps', () => {
    for (const timestampMs of ['', 'abc', '-5', '2.5', '9000']) {
      const result = validateGroundTruth({ ...base, timestampMs });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.timestampMs).toBeTruthy();
    }
  });

  it('rejects a zero/negative/blank quantity', () => {
    for (const quantity of ['0', '-1', '', '1.5']) {
      const result = validateGroundTruth({ ...base, quantity });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.quantity).toBeTruthy();
    }
  });

  it('NONE needs no product/timestamp and sends only the kind', () => {
    const result = validateGroundTruth({
      eventKind: 'NONE',
      productId: '',
      timestampMs: '',
      quantity: '1',
      durationMs: 5987,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload).toEqual({ eventKind: 'NONE' });
  });
});

describe('canReview', () => {
  it('allows review only while the event is pending', () => {
    expect(canReview(stateWith({}))).toBe(true);
    expect(
      canReview(stateWith({ visionEventStatus: 'APPROVED' })),
    ).toBe(false);
    expect(canReview(stateWith(null))).toBe(false);
  });
});
