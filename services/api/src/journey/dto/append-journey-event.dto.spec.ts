import 'reflect-metadata';
import { CustomerJourneyEventType } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AppendJourneyEventDto } from './append-journey-event.dto';

/**
 * Mirrors the global ValidationPipe (whitelist + forbidNonWhitelisted +
 * transform) against the MANUAL append body. The load-bearing cases are
 * the forged provenance fields: sourceType / videoAssetId / fusionRunId /
 * matchScore are not declared on the DTO, so a manual request carrying
 * them must be a controlled 400 — never a persisted cross-tenant
 * fusion/video reference or a poisoned fusion-import idempotency key.
 */
describe('AppendJourneyEventDto', () => {
  async function errorsFor(body: Record<string, unknown>) {
    const dto = plainToInstance(AppendJourneyEventDto, body);
    return validate(dto, { whitelist: true, forbidNonWhitelisted: true });
  }

  it('accepts a plain manual observation', async () => {
    expect(
      await errorsFor({
        eventType: CustomerJourneyEventType.PRODUCT_PICKUP,
        occurredAt: '2026-08-11T09:00:00.000Z',
        productId: 'prod-a',
        quantity: 2,
        note: 'picked from the end cap',
      }),
    ).toHaveLength(0);
  });

  it.each(['sourceType', 'videoAssetId', 'fusionRunId', 'matchScore'])(
    'rejects the forged provenance field %s (fusion import is the only setter)',
    async (field) => {
      const errors = await errorsFor({
        eventType: CustomerJourneyEventType.PRODUCT_PICKUP,
        productId: 'prod-a',
        [field]: field === 'matchScore' ? 0.99 : 'forged-id',
      });
      expect(errors.map((error) => error.property)).toContain(field);
    },
  );

  it('rejects an unknown eventType', async () => {
    expect(await errorsFor({ eventType: 'CHECKOUT' })).not.toHaveLength(0);
  });

  it('rejects a non-ISO occurredAt', async () => {
    expect(
      await errorsFor({
        eventType: CustomerJourneyEventType.SHELF_INTERACTION,
        occurredAt: 'yesterday',
      }),
    ).not.toHaveLength(0);
  });

  it('rejects an out-of-range quantity', async () => {
    expect(
      await errorsFor({
        eventType: CustomerJourneyEventType.PRODUCT_PICKUP,
        productId: 'prod-a',
        quantity: 101,
      }),
    ).not.toHaveLength(0);
  });

  it('rejects a blank-string quantity instead of coercing it to 0', async () => {
    expect(
      await errorsFor({
        eventType: CustomerJourneyEventType.PRODUCT_PICKUP,
        productId: 'prod-a',
        quantity: '',
      }),
    ).not.toHaveLength(0);
  });
});
