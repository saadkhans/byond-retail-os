import { ApiPropertyOptional } from '@nestjs/swagger';
import { InferenceJobType } from '@prisma/client';
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
 * Creates a Phase 9 inference job from a CROP artifact. The job's input
 * descriptor is built SERVER-SIDE (artifact/asset ids, timestamp, crop box
 * — opaque references only, screened by the Phase 9 policy); the client
 * only tunes job type, priority, and idempotency.
 */
export class CreateInferenceJobFromCropDto {
  @ApiPropertyOptional({
    enum: InferenceJobType,
    description:
      'Override the job type; defaults from the crop reason ' +
      '(SHELF_AUDIT/OCR_REVIEW/VLM_REVIEW map 1:1, everything else is ' +
      'PRODUCT_RECOGNITION).',
  })
  @IsOptionalNonNull()
  @IsEnum(InferenceJobType)
  jobType?: InferenceJobType;

  @ApiPropertyOptional({ minimum: 0, maximum: 1000 })
  @IsOptionalNonNull()
  @Transform(toNumberRejectingBlank)
  @IsInt()
  @Min(0)
  @Max(1000)
  priority?: number;

  @ApiPropertyOptional({
    maxLength: 100,
    description:
      'Tenant-scoped idempotency key for the Phase 9 job; defaults to a ' +
      'key derived from the crop artifact id, so retries replay the same job.',
  })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  idempotencyKey?: string;
}
