import { BadRequestException } from '@nestjs/common';
import {
  EvidenceSourceType,
  InferenceJobType,
  VisionEventType,
} from '@prisma/client';
import { InferenceAdapterInput, InferenceJobContext } from './inference-adapter';
import { SimulatedInferenceAdapter } from './simulated.adapter';

describe('SimulatedInferenceAdapter', () => {
  const adapter = new SimulatedInferenceAdapter();

  const context: InferenceJobContext = {
    jobId: 'job-1',
    tenantId: 'tenant-a',
    jobType: InferenceJobType.PRODUCT_RECOGNITION,
    unitId: 'unit-a1',
    sourceType: EvidenceSourceType.VISION,
    inputDescriptor: { zoneId: 'zone-3', cropId: 'crop-42' },
  };

  const baseInput: InferenceAdapterInput = {
    eventType: VisionEventType.PRODUCT_PICKUP,
    quantityDelta: 1,
    occurredAt: '2026-07-26T10:00:30.000Z',
    detections: [{ sku: 'cola-330', confidence: 0.92 }],
  };

  it('supports every job type (it only echoes sample output)', () => {
    expect([...adapter.supportedJobTypes].sort()).toEqual(
      Object.values(InferenceJobType).sort(),
    );
  });

  describe('validateInput', () => {
    it('accepts a valid pickup', () => {
      expect(() => adapter.validateInput(context, baseInput)).not.toThrow();
    });

    it.each([0, 1.5, Number.NaN])(
      'rejects quantityDelta %p',
      (quantityDelta) => {
        expect(() =>
          adapter.validateInput(context, { ...baseInput, quantityDelta }),
        ).toThrow(BadRequestException);
      },
    );

    it('rejects a negative quantityDelta for a non-return event', () => {
      expect(() =>
        adapter.validateInput(context, { ...baseInput, quantityDelta: -1 }),
      ).toThrow(/PRODUCT_RETURN/);
    });

    it('rejects a positive quantityDelta for PRODUCT_RETURN', () => {
      expect(() =>
        adapter.validateInput(context, {
          ...baseInput,
          eventType: VisionEventType.PRODUCT_RETURN,
          quantityDelta: 1,
        }),
      ).toThrow(/negative/);
    });

    it('accepts a negative quantityDelta for PRODUCT_RETURN', () => {
      expect(() =>
        adapter.validateInput(context, {
          ...baseInput,
          eventType: VisionEventType.PRODUCT_RETURN,
          quantityDelta: -2,
        }),
      ).not.toThrow();
    });

    it('requires at least one detection for basket-affecting event types', () => {
      expect(() =>
        adapter.validateInput(context, { ...baseInput, detections: [] }),
      ).toThrow(/at least one detection/);
    });

    it('accepts zero detections for record-only event types', () => {
      expect(() =>
        adapter.validateInput(context, {
          ...baseInput,
          eventType: VisionEventType.EXIT_RECONCILIATION,
          detections: [],
        }),
      ).not.toThrow();
    });

    it.each([-0.1, 1.1, Number.NaN])(
      'rejects an out-of-range confidence %p',
      (confidence) => {
        expect(() =>
          adapter.validateInput(context, {
            ...baseInput,
            detections: [{ sku: 'A', confidence }],
          }),
        ).toThrow(BadRequestException);
      },
    );

    it('rejects a blank sku', () => {
      expect(() =>
        adapter.validateInput(context, {
          ...baseInput,
          detections: [{ sku: '   ', confidence: 0.5 }],
        }),
      ).toThrow(/sku/);
    });
  });

  describe('normalizeResult — Phase 8 mapper parity', () => {
    it('dedupes case-insensitive duplicate SKUs keeping the strongest, with contiguous ranks', () => {
      const result = adapter.normalizeResult({
        ...baseInput,
        detections: [
          { sku: 'cola-330', confidence: 0.4, label: 'weak' },
          { sku: 'COLA-330', confidence: 0.9, label: 'strong' },
          { sku: 'chips-50', confidence: 0.6 },
        ],
      });
      expect(result.candidates).toEqual([
        { sku: 'COLA-330', rank: 1, score: 0.9, label: 'strong' },
        { sku: 'CHIPS-50', rank: 2, score: 0.6 },
      ]);
      expect(result.evidenceScore).toBe(0.9);
    });

    it('keeps the FIRST-SEEN detection on an exact confidence tie', () => {
      const result = adapter.normalizeResult({
        ...baseInput,
        detections: [
          { sku: 'a-1', confidence: 0.5, label: 'first' },
          { sku: 'A-1', confidence: 0.5, label: 'second' },
        ],
      });
      expect(result.candidates).toEqual([
        { sku: 'A-1', rank: 1, score: 0.5, label: 'first' },
      ]);
    });

    it('sorts by confidence descending and rounds scores to 4 decimals', () => {
      const result = adapter.normalizeResult({
        ...baseInput,
        detections: [
          { sku: 'low', confidence: 0.123456 },
          { sku: 'high', confidence: 0.98765449 },
        ],
      });
      expect(result.candidates.map((c) => [c.sku, c.rank, c.score])).toEqual([
        ['HIGH', 1, 0.9877],
        ['LOW', 2, 0.1235],
      ]);
    });

    it('caps the ranking at 20 candidates', () => {
      const detections = Array.from({ length: 25 }, (_, index) => ({
        sku: `SKU-${index}`,
        confidence: 1 - index * 0.01,
      }));
      const result = adapter.normalizeResult({ ...baseInput, detections });
      expect(result.candidates).toHaveLength(20);
      expect(result.candidates[0]).toEqual({
        sku: 'SKU-0',
        rank: 1,
        score: 1,
      });
      expect(result.candidates[19].rank).toBe(20);
    });

    it('passes eventType, quantityDelta, and opaque model metadata through', () => {
      const result = adapter.normalizeResult({
        ...baseInput,
        eventType: VisionEventType.PRODUCT_RETURN,
        quantityDelta: -3,
        evidenceQuality: 'HIGH',
        modelKey: 'shelf-classifier',
        modelVersion: '2026.07',
      });
      expect(result.eventType).toBe(VisionEventType.PRODUCT_RETURN);
      expect(result.quantityDelta).toBe(-3);
      expect(result.evidenceQuality).toBe('HIGH');
      expect(result.modelKey).toBe('shelf-classifier');
      expect(result.modelVersion).toBe('2026.07');
    });

    it('yields no candidates and no evidenceScore for an empty detection list', () => {
      const result = adapter.normalizeResult({
        ...baseInput,
        eventType: VisionEventType.EXIT_RECONCILIATION,
        detections: [],
      });
      expect(result.candidates).toEqual([]);
      expect(result.evidenceScore).toBeUndefined();
    });
  });

  it('run() echoes the sample output (no real ML)', async () => {
    await expect(adapter.run(context, baseInput)).resolves.toBe(baseInput);
  });

  describe('job context', () => {
    it('rejects a job type outside supportedJobTypes via the context', () => {
      const restricted = new SimulatedInferenceAdapter();
      Object.defineProperty(restricted, 'supportedJobTypes', {
        value: [InferenceJobType.OCR_REVIEW],
      });
      expect(() =>
        restricted.validateInput(context, baseInput),
      ).toThrow(/does not support job type PRODUCT_RECOGNITION/);
    });

    it('rejects an unparseable occurredAt', () => {
      expect(() =>
        adapter.validateInput(context, {
          ...baseInput,
          occurredAt: 'not-a-timestamp',
        }),
      ).toThrow(/occurredAt/);
    });

    it('carries the source occurredAt onto the normalized result', () => {
      const result = adapter.normalizeResult(baseInput);
      expect(result.occurredAt).toEqual(
        new Date('2026-07-26T10:00:30.000Z'),
      );
    });
  });
});
