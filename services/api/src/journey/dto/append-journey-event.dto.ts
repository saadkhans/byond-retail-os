import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CustomerJourneyEventType } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsDateString,
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
 * Runtime-validated body for MANUAL observation appends. The provenance
 * fields (sourceType, videoAssetId, fusionRunId, matchScore) are
 * DELIBERATELY absent: only the fusion-run import path may set them,
 * because it resolves the asset and run within this tenant first. The
 * previous inline body type carried no validation metadata, so the global
 * whitelist ValidationPipe let a manual request smuggle those fields in —
 * forging cross-tenant fusion/video references and poisoning the
 * fusion-import idempotency check.
 */
export class AppendJourneyEventDto {
  @ApiProperty({ enum: CustomerJourneyEventType })
  @IsEnum(CustomerJourneyEventType)
  eventType!: CustomerJourneyEventType;

  @ApiPropertyOptional({
    description: 'Observation instant (ISO 8601); defaults to now',
  })
  @IsOptionalNonNull()
  @IsDateString()
  occurredAt?: string;

  @ApiPropertyOptional({
    description: 'Observed product (required for PICKUP/RETURN)',
  })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  productId?: string;

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
