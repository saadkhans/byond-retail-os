import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { EvidenceQuality, VisionEventType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsNumber,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PG_INT_MAX } from '../../common/integer-bounds';
import { IsOptionalNonNull } from '../../common/validation';

/**
 * One raw detection in the simulated model output. Field spellings match
 * the internal model-output contract shared with the Phase 8 mapper
 * (ml/scripts/sample_inference_to_vision_event.py): sku + confidence +
 * optional label.
 */
export class InferenceDetectionDto {
  @ApiProperty({
    maxLength: 100,
    description:
      'Tenant catalog SKU (case-insensitive; normalized to uppercase).',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  sku!: string;

  @ApiProperty({
    minimum: 0,
    maximum: 1,
    description: 'Normalized confidence for THIS detection.',
  })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1)
  confidence!: number;

  @ApiPropertyOptional({
    maxLength: 200,
    description:
      'Opaque label the model used for the detected object (never ' +
      'interpreted; stored verbatim).',
  })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  label?: string;
}

/**
 * Completes a RUNNING job with SIMULATED model output (no real model
 * execution in Phase 9). The output runs through the job's adapter —
 * validation plus Phase 8-parity candidate ranking (dedupe by uppercased
 * SKU keeping the strongest, sort by confidence descending, 1-based ranks,
 * scores rounded to 4 decimals, cap 20) — and persists as the job's
 * append-only InferenceResult. quantityDelta is signed: negative only (and
 * always) for PRODUCT_RETURN; the VisionEvent conversion emits the
 * magnitude.
 */
export class CompleteInferenceJobDto {
  @ApiProperty({ enum: VisionEventType })
  @IsEnum(VisionEventType)
  eventType!: VisionEventType;

  @ApiProperty({
    minimum: -PG_INT_MAX,
    maximum: PG_INT_MAX,
    description:
      'Signed quantity suggestion; never zero, negative only for ' +
      'PRODUCT_RETURN.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(-PG_INT_MAX)
  @Max(PG_INT_MAX)
  quantityDelta!: number;

  @ApiProperty({
    type: [InferenceDetectionDto],
    minItems: 1,
    maxItems: 20,
    description:
      'Raw detections (1-20). Duplicate SKUs collapse to the strongest ' +
      'detection during normalization.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => InferenceDetectionDto)
  detections!: InferenceDetectionDto[];

  @ApiPropertyOptional({ enum: EvidenceQuality })
  @IsOptionalNonNull()
  @IsEnum(EvidenceQuality)
  evidenceQuality?: EvidenceQuality;

  @ApiPropertyOptional({
    maxLength: 100,
    description:
      'Opaque model identifier (never interpreted; screened; stays ' +
      'internal to the inference result — it is not emitted on the ' +
      'converted vision event).',
  })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  modelKey?: string;

  @ApiPropertyOptional({
    maxLength: 100,
    description: 'Opaque model version (same handling as modelKey).',
  })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  modelVersion?: string;
}
