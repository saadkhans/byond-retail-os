import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateInferenceJobDto } from './create-inference-job.dto';

/** Same blank-string guard as the complete DTO: Number('') is 0, and a
 * blank priority must be a controlled 400, not a silently valid zero. */
describe('CreateInferenceJobDto numeric coercion', () => {
  const validationErrors = (body: Record<string, unknown>) =>
    validateSync(plainToInstance(CreateInferenceJobDto, body));

  it('accepts a numeric and a numeric-string priority, and an absent one', () => {
    expect(
      validationErrors({ jobType: 'PRODUCT_RECOGNITION', priority: 250 }),
    ).toHaveLength(0);
    expect(
      validationErrors({ jobType: 'PRODUCT_RECOGNITION', priority: '250' }),
    ).toHaveLength(0);
    expect(validationErrors({ jobType: 'PRODUCT_RECOGNITION' })).toHaveLength(
      0,
    );
  });

  it('rejects a blank priority instead of coercing it to 0', () => {
    for (const blank of ['', '  ']) {
      expect(
        validationErrors({ jobType: 'PRODUCT_RECOGNITION', priority: blank })
          .length,
      ).toBeGreaterThan(0);
    }
  });
});
