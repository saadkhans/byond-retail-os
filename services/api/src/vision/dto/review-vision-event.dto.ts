import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { VisionReviewDecision } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PG_INT_MAX } from '../../common/integer-bounds';
import { IsOptionalNonNull } from '../../common/validation';

/**
 * The review/policy decision for a PENDING_REVIEW event. Exactly one
 * decision per event — decisions are terminal and append-only.
 *
 * - APPROVE applies the TOP-RANKED candidate at the event's quantity.
 * - OVERRIDE applies the reviewer's `productId`/`quantity` instead (manual
 *   correction); both are required, and only basket-affecting event types
 *   (PRODUCT_PICKUP, CART_INSERTION, PRODUCT_RETURN) can be overridden.
 * - REJECT records the decision and never touches the basket.
 */
export class ReviewVisionEventDto {
  @ApiProperty({ enum: VisionReviewDecision })
  @IsEnum(VisionReviewDecision)
  decision!: VisionReviewDecision;

  @ApiPropertyOptional({
    description:
      'OVERRIDE only: the tenant product to apply instead of the top ' +
      'candidate. Rejected for APPROVE/REJECT.',
  })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  productId?: string;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: PG_INT_MAX,
    description:
      'OVERRIDE only: the quantity to apply instead of the event quantity. ' +
      'Rejected for APPROVE/REJECT.',
  })
  @IsOptionalNonNull()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PG_INT_MAX)
  quantity?: number;

  @ApiPropertyOptional({
    maxLength: 500,
    description:
      'Reviewer note recorded on the decision and in the audit trail.',
  })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason?: string;
}
