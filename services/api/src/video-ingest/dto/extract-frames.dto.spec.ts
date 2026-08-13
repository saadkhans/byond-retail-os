import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ExtractFramesDto } from './extract-frames.dto';

/**
 * The wire-level half of the timestamp contract: values the HTTP layer must
 * refuse BEFORE the service runs. The global ValidationPipe applies exactly
 * these transforms/validators, so a failing property here is a controlled
 * 400 in the running API.
 *
 * The blank-string cases are the load-bearing ones: `Number('')` is 0, so a
 * bare @Type(() => Number) would silently turn an EMPTY timestamp into a
 * VALID frame-0 request. `toNumberRejectingBlank` maps blank to NaN, which
 * @IsInt then rejects — an empty value is an error, never frame zero.
 */
describe('ExtractFramesDto timestampMs', () => {
  async function timestampErrors(timestampMs: unknown): Promise<string[]> {
    const dto = plainToInstance(ExtractFramesDto, {
      timestampMs,
      idempotencyKey: 'op-1',
    });
    const errors = await validate(dto);
    return errors
      .filter((error) => error.property === 'timestampMs')
      .map((error) => Object.keys(error.constraints ?? {}))
      .flat();
  }

  it.each([['0', 0], ['2500', 2500], ['5999', 5999]] as const)(
    'accepts the in-range string %s as the integer %d',
    async (raw, expected) => {
      const dto = plainToInstance(ExtractFramesDto, {
        timestampMs: raw,
        idempotencyKey: 'op-1',
      });
      expect(await validate(dto)).toHaveLength(0);
      expect(dto.timestampMs).toBe(expected);
    },
  );

  it('rejects a blank string instead of coercing it to 0', async () => {
    expect(await timestampErrors('')).not.toHaveLength(0);
  });

  it('rejects a whitespace-only string instead of coercing it to 0', async () => {
    expect(await timestampErrors('   ')).not.toHaveLength(0);
  });

  it('rejects a negative timestamp', async () => {
    expect(await timestampErrors(-1)).not.toHaveLength(0);
  });

  it('rejects a non-numeric string', async () => {
    expect(await timestampErrors('abc')).not.toHaveLength(0);
  });

  it('rejects null (optional means ABSENT, not null)', async () => {
    expect(await timestampErrors(null)).not.toHaveLength(0);
  });

  it('still allows the field to be omitted entirely (sampling mode)', async () => {
    const dto = plainToInstance(ExtractFramesDto, { idempotencyKey: 'op-1' });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.timestampMs).toBeUndefined();
  });
});
