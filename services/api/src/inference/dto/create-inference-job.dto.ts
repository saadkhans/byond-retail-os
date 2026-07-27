import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { EvidenceSourceType, InferenceJobType } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsObject,
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

export const MAX_PRIORITY = 1000;
export const DEFAULT_PRIORITY = 100;

/**
 * Creates a QUEUED inference job. Provider-neutral: the trigger layer (a
 * hand entering a shelf zone, a suspected shelf change, a customer exit)
 * submits typed context only — the SAFE input descriptor may reference
 * crops/zones/frames BY ID but never carries raw media, media/storage URLs,
 * signed URLs, artifact descriptors, or credentials (screened, controlled
 * 400). Creation never runs a model and never touches the basket.
 */
export class CreateInferenceJobDto {
  @ApiProperty({ enum: InferenceJobType })
  @IsEnum(InferenceJobType)
  jobType!: InferenceJobType;

  @ApiPropertyOptional({ description: 'Store (location) the job relates to.' })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  locationId?: string;

  @ApiPropertyOptional({
    description: 'Retail unit the job relates to (must be in the store).',
  })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  unitId?: string;

  @ApiPropertyOptional({
    description: 'Source camera/device (must be attached to the unit).',
  })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  deviceId?: string;

  @ApiPropertyOptional({
    description:
      'Checkout session the job relates to (must be on the same unit). ' +
      'Carried onto the converted vision event.',
  })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  sessionId?: string;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: MAX_PRIORITY,
    default: DEFAULT_PRIORITY,
    description: 'Queue priority; higher runs first.',
  })
  // Not @Type(() => Number): Number('') is 0 — a blank string would become
  // a silently VALID priority instead of a 400. Blank → NaN → rejected.
  @IsOptionalNonNull()
  @Transform(toNumberRejectingBlank)
  @IsInt()
  @Min(0)
  @Max(MAX_PRIORITY)
  priority?: number;

  @ApiPropertyOptional({
    enum: EvidenceSourceType,
    default: EvidenceSourceType.VISION,
  })
  @IsOptionalNonNull()
  @IsEnum(EvidenceSourceType)
  sourceType?: EvidenceSourceType;

  @ApiPropertyOptional({
    maxLength: 200,
    description:
      'Opaque trigger/source reference (never interpreted; screened for ' +
      'credential- or payment-bearing content).',
  })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  sourceId?: string;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description:
      'SAFE, NON-SECRET input descriptor: trigger context and crop/zone ' +
      'references by id only. Raw media, media/storage URLs, signed URLs, ' +
      'artifact descriptors, inline base64, and credential-shaped content ' +
      'are rejected with a controlled 400.',
  })
  @IsOptionalNonNull()
  @IsObject()
  inputDescriptor?: Record<string, unknown>;

  @ApiPropertyOptional({
    maxLength: 100,
    description:
      'Tenant-scoped idempotency key: at-least-once trigger delivery ' +
      'replays the original job instead of duplicating it.',
  })
  // Persisted verbatim → screened by the service (no credential- or
  // payment-bearing values), like vision ingest.
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  idempotencyKey?: string;
}
