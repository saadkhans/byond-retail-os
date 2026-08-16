import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  CustomerJourneyEventType,
  JourneyEventReviewDecision,
} from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsIn,
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
 * Runtime-validated body for the append-only journey event review. The
 * corrected* snapshot fields (correctedSku, correctedProductName) are
 * DELIBERATELY absent: the service resolves the corrected product within
 * this tenant and snapshots sku/name itself — a caller-supplied snapshot
 * could describe a product the id does not name.
 */
export class ReviewJourneyEventDto {
  @ApiProperty({ enum: JourneyEventReviewDecision })
  @IsEnum(JourneyEventReviewDecision)
  decision!: JourneyEventReviewDecision;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptionalNonNull()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @ApiPropertyOptional({
    enum: [
      CustomerJourneyEventType.PRODUCT_PICKUP,
      CustomerJourneyEventType.PRODUCT_RETURN,
    ],
    description:
      'CORRECT only — required when the reviewed observation is ' +
      'REVIEW_REQUIRED; defaults to the observed kind for product events',
  })
  @IsOptionalNonNull()
  @IsIn([
    CustomerJourneyEventType.PRODUCT_PICKUP,
    CustomerJourneyEventType.PRODUCT_RETURN,
  ])
  correctedEventType?: CustomerJourneyEventType;

  @ApiPropertyOptional({ description: 'CORRECT only — the actual product' })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  correctedProductId?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 100 })
  @IsOptionalNonNull()
  @Transform(toNumberRejectingBlank)
  @IsInt()
  @Min(1)
  @Max(100)
  correctedQuantity?: number;

  @ApiPropertyOptional({
    minLength: 8,
    maxLength: 100,
    description:
      'Replay token: a retried POST with the same key returns the ' +
      'existing review instead of appending a second immutable record ' +
      'of the same human action',
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
