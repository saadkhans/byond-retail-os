import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { GroundTruthEventKind } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsEnum,
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

/**
 * Operator-entered ground truth for one controlled test video. NONE means
 * "no pickup happens in this clip"; PICKUP/RETURN require the actual
 * product and timestamp (validated against the probed duration in the
 * service).
 */
export class UpsertGroundTruthDto {
  @ApiProperty({ enum: GroundTruthEventKind })
  @IsEnum(GroundTruthEventKind)
  eventKind!: GroundTruthEventKind;

  @ApiPropertyOptional({ description: 'Actual product (PICKUP/RETURN only)' })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  productId?: string;

  @ApiPropertyOptional({
    minimum: 0,
    description: 'Actual pickup/return instant (ms into the clip)',
  })
  @IsOptionalNonNull()
  @Transform(toNumberRejectingBlank)
  @IsInt()
  @Min(0)
  actualTimestampMs?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 1 })
  @IsOptionalNonNull()
  @Transform(toNumberRejectingBlank)
  @IsInt()
  @Min(1)
  @Max(100)
  quantity?: number;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptionalNonNull()
  @IsString()
  @MaxLength(500)
  note?: string;
}
