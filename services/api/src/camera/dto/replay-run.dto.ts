import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsInt,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  IsOptionalNonNull,
  toNumberRejectingBlank,
} from '../../common/validation';

/** One FILE_REPLAY pilot run over an existing, already-screened asset. */
export class ReplayRunDto {
  @ApiPropertyOptional({
    description: "Defaults to the source's configured replay asset",
  })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  videoAssetId?: string;

  @ApiPropertyOptional({
    minimum: 40,
    maximum: 60000,
    default: 500,
    description: 'Replay sampling interval (ms per analyzed frame)',
  })
  @IsOptionalNonNull()
  @Transform(toNumberRejectingBlank)
  @IsInt()
  @Min(40)
  @Max(60000)
  frameIntervalMs?: number;

  @ApiPropertyOptional({
    minLength: 8,
    maxLength: 100,
    description:
      'Replay token: a retried POST with the same key returns the ' +
      'existing run instead of replaying the footage twice',
  })
  @IsOptionalNonNull()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(8)
  @MaxLength(100)
  idempotencyKey?: string;
}
