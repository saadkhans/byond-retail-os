import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { MAX_TIMESTAMP_MS } from '../../video-ingest/dto/create-video-crop.dto';
import { UpsertGroundTruthDto } from './upsert-ground-truth.dto';

/**
 * Wire-level bounds for actualTimestampMs. The @Max ceiling is the
 * load-bearing case: VideoGroundTruth.actualTimestampMs is a PG int4, and
 * the service's duration check only fires when the asset has been probed
 * (durationMs non-null) — so without the DTO cap, an oversized value on an
 * unprobed asset would sail through to Prisma and 500 on int overflow
 * instead of returning a controlled 400.
 */
describe('UpsertGroundTruthDto actualTimestampMs', () => {
  async function timestampErrors(actualTimestampMs: unknown): Promise<string[]> {
    const dto = plainToInstance(UpsertGroundTruthDto, {
      eventKind: 'PICKUP',
      productId: 'prod-1',
      actualTimestampMs,
    });
    const errors = await validate(dto);
    return errors
      .filter((error) => error.property === 'actualTimestampMs')
      .map((error) => Object.keys(error.constraints ?? {}))
      .flat();
  }

  it.each([[0], [1600], [MAX_TIMESTAMP_MS]])(
    'accepts the in-range value %d',
    async (value) => {
      expect(await timestampErrors(value)).toHaveLength(0);
    },
  );

  it('rejects a value just past the ~24h ceiling', async () => {
    expect(await timestampErrors(MAX_TIMESTAMP_MS + 1)).toContain('max');
  });

  it('rejects a value beyond PG int4 range (the 500-instead-of-400 repro)', async () => {
    expect(await timestampErrors(3_000_000_000)).toContain('max');
  });

  it('rejects a negative timestamp', async () => {
    expect(await timestampErrors(-1)).not.toHaveLength(0);
  });

  it('rejects a blank string instead of coercing it to 0', async () => {
    expect(await timestampErrors('')).not.toHaveLength(0);
  });

  it('still allows the field to be omitted entirely (NONE truth)', async () => {
    const dto = plainToInstance(UpsertGroundTruthDto, { eventKind: 'NONE' });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.actualTimestampMs).toBeUndefined();
  });
});
