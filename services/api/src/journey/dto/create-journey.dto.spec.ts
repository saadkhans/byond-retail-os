import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateJourneyDto } from './create-journey.dto';

/**
 * Mirrors the global ValidationPipe (whitelist + forbidNonWhitelisted +
 * transform) against the journey-open body. The load-bearing cases are
 * the pre-DTO failure modes: an empty body reaching the service with
 * `locationId === undefined` (Prisma dropped the predicate and the
 * existence check passed against an arbitrary tenant location), and a
 * Prisma StringFilter operator object injected as locationId. Both must
 * be controlled 400s, never a where-clause reaching Prisma.
 */
describe('CreateJourneyDto', () => {
  async function errorsFor(body: Record<string, unknown>) {
    const dto = plainToInstance(CreateJourneyDto, body);
    return validate(dto, { whitelist: true, forbidNonWhitelisted: true });
  }

  it('accepts a locationId alone', async () => {
    expect(await errorsFor({ locationId: 'loc-a' })).toHaveLength(0);
  });

  it('accepts a locationId with a unitId', async () => {
    expect(
      await errorsFor({ locationId: 'loc-a', unitId: 'unit-a' }),
    ).toHaveLength(0);
  });

  it('rejects an empty body (locationId must never reach Prisma undefined)', async () => {
    const errors = await errorsFor({});
    expect(errors.map((error) => error.property)).toContain('locationId');
  });

  it('rejects a Prisma operator object injected as locationId', async () => {
    const errors = await errorsFor({ locationId: { not: '' } });
    expect(errors.map((error) => error.property)).toContain('locationId');
  });

  it('rejects a blank locationId', async () => {
    expect(await errorsFor({ locationId: '' })).not.toHaveLength(0);
  });

  it('rejects a null unitId (optional means absent, not null)', async () => {
    expect(
      await errorsFor({ locationId: 'loc-a', unitId: null }),
    ).not.toHaveLength(0);
  });

  it('rejects unknown extra keys under forbidNonWhitelisted', async () => {
    const errors = await errorsFor({
      locationId: 'loc-a',
      tenantId: 'forged-tenant',
    });
    expect(errors.map((error) => error.property)).toContain('tenantId');
  });
});
