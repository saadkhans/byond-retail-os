import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ReindexReferenceIndexDto } from './reindex-reference-index.dto';

/**
 * Mirrors the global ValidationPipe (whitelist + forbidNonWhitelisted +
 * transform) against the reindex body. The load-bearing cases are the
 * pre-DTO failure modes: this endpoint's `rebuild: true` branch gates a
 * destructive deleteMany over the tenant's reference-embedding index, and
 * the inline body type let non-boolean `rebuild` values and arbitrary
 * extra keys through unvalidated. Those must be controlled 400s.
 */
describe('ReindexReferenceIndexDto', () => {
  async function errorsFor(body: Record<string, unknown>) {
    const dto = plainToInstance(ReindexReferenceIndexDto, body);
    return validate(dto, { whitelist: true, forbidNonWhitelisted: true });
  }

  it('accepts an empty body (rebuild is optional)', async () => {
    expect(await errorsFor({})).toHaveLength(0);
  });

  it('accepts rebuild: true', async () => {
    expect(await errorsFor({ rebuild: true })).toHaveLength(0);
  });

  it('accepts rebuild: false', async () => {
    expect(await errorsFor({ rebuild: false })).toHaveLength(0);
  });

  it('rejects a string "true" (rebuild must be a real boolean)', async () => {
    const errors = await errorsFor({ rebuild: 'true' });
    expect(errors.map((error) => error.property)).toContain('rebuild');
  });

  it('rejects a null rebuild (optional means absent, not null)', async () => {
    const errors = await errorsFor({ rebuild: null });
    expect(errors.map((error) => error.property)).toContain('rebuild');
  });

  it('rejects an object injected as rebuild', async () => {
    const errors = await errorsFor({ rebuild: { not: false } });
    expect(errors.map((error) => error.property)).toContain('rebuild');
  });

  it('rejects unknown extra keys under forbidNonWhitelisted', async () => {
    const errors = await errorsFor({ rebuild: true, tenantId: 'forged' });
    expect(errors.map((error) => error.property)).toContain('tenantId');
  });
});
