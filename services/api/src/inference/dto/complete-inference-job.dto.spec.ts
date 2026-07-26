import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CompleteInferenceJobDto } from './complete-inference-job.dto';

/**
 * The global ValidationPipe runs class-transformer BEFORE class-validator,
 * and a bare @Type(() => Number) coerces with Number() — where Number('')
 * is 0. These tests pin the blank-string guard: a blank numeric field must
 * be a controlled 400, never a silently VALID zero (a fabricated
 * zero-confidence candidate, a zero quantity). Mirrors the pipe:
 * plainToInstance then validateSync.
 */
describe('CompleteInferenceJobDto numeric coercion', () => {
  const validBody = {
    eventType: 'PRODUCT_PICKUP',
    quantityDelta: 2,
    occurredAt: '2026-07-26T10:00:30.000Z',
    detections: [{ sku: 'cola-330', confidence: 0.92 }],
  };

  const validationErrors = (body: Record<string, unknown>) =>
    validateSync(plainToInstance(CompleteInferenceJobDto, body));

  it('accepts a valid body (numbers and numeric strings)', () => {
    expect(validationErrors(validBody)).toHaveLength(0);
    expect(
      validationErrors({
        ...validBody,
        quantityDelta: '2',
        detections: [{ sku: 'cola-330', confidence: '0.92' }],
      }),
    ).toHaveLength(0);
  });

  it('rejects a blank confidence instead of coercing it to 0', () => {
    for (const blank of ['', '  ']) {
      const errors = validationErrors({
        ...validBody,
        detections: [{ sku: 'cola-330', confidence: blank }],
      });
      expect(errors.length).toBeGreaterThan(0);
    }
  });

  it('rejects a blank quantityDelta instead of coercing it to 0', () => {
    for (const blank of ['', ' ']) {
      const errors = validationErrors({ ...validBody, quantityDelta: blank });
      expect(errors.length).toBeGreaterThan(0);
    }
  });

  it('requires a timezone offset on occurredAt', () => {
    // An offset-less ISO stamp reaches `new Date()` as SERVER-LOCAL time,
    // silently shifting the source-reported event time on non-UTC
    // deployments — mandatory 'Z' or +-HH:MM, like the Phase 8 mapper.
    expect(
      validationErrors({ ...validBody, occurredAt: '2026-07-26T10:00:30' })
        .length,
    ).toBeGreaterThan(0);
    expect(
      validationErrors({
        ...validBody,
        occurredAt: '2026-07-26T10:00:30.000Z',
      }),
    ).toHaveLength(0);
    expect(
      validationErrors({
        ...validBody,
        occurredAt: '2026-07-26T15:00:30+05:00',
      }),
    ).toHaveLength(0);
  });
});
