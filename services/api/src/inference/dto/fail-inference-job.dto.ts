import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsInt,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PG_INT_MAX } from '../../common/integer-bounds';
import {
  IsOptionalNonNull,
  toNumberRejectingBlank,
} from '../../common/validation';

export const ERROR_CODE_PATTERN = '^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$';
export const ERROR_CODE_REGEX = new RegExp(ERROR_CODE_PATTERN);
export const MAX_ERROR_CODE_LENGTH = 64;

/**
 * Fails a QUEUED or RUNNING job. The error code is a strict UPPER_SNAKE
 * slug (ADAPTER_TIMEOUT, LOW_QUALITY_INPUT) so there is no room for
 * encoded content; the optional message is screened for credential- or
 * payment-bearing content before persistence.
 */
export class FailInferenceJobDto {
  @ApiProperty({
    minimum: 0,
    maximum: PG_INT_MAX,
    description:
      'The `attempts` value observed on the job being failed (from start ' +
      'or the job detail). Fences the transition to that observation: a ' +
      'reclaimed-and-re-claimed job rejects the stale failure with a 409. ' +
      'A QUEUED job that was never claimed has attempts 0 — failing it ' +
      'with attempt 0 fences correctly too, since only claims increment ' +
      'the counter.',
  })
  @Transform(toNumberRejectingBlank)
  @IsInt()
  @Min(0)
  @Max(PG_INT_MAX)
  attempt!: number;

  @ApiProperty({
    maxLength: MAX_ERROR_CODE_LENGTH,
    pattern: ERROR_CODE_PATTERN,
    description: 'Stable UPPER_SNAKE error code.',
  })
  @IsString()
  @MaxLength(MAX_ERROR_CODE_LENGTH)
  @Matches(ERROR_CODE_REGEX, {
    message:
      'errorCode must be an UPPER_SNAKE code (uppercase letter/digit ' +
      'segments joined by "_")',
  })
  errorCode!: string;

  @ApiPropertyOptional({
    maxLength: 500,
    description:
      'Safe human-readable failure context (screened; never raw provider ' +
      'payloads or credentials).',
  })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  errorMessage?: string;
}
