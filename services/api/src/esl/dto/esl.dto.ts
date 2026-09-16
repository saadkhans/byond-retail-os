import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { ESL_DEFAULT_TAKE, ESL_MAX_TAKE } from '../esl.constants';

const GATEWAY_STATUSES = [
  'PENDING',
  'ACTIVE',
  'DISABLED',
  'UNREACHABLE',
] as const;
const LABEL_STATUSES = ['UNBOUND', 'BOUND', 'RETIRED'] as const;
const JOB_STATUSES = [
  'QUEUED',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
] as const;

export type GatewayStatusInput = (typeof GATEWAY_STATUSES)[number];
export type LabelStatusInput = (typeof LABEL_STATUSES)[number];
export type JobStatusInput = (typeof JOB_STATUSES)[number];

class PaginationDto {
  @ApiPropertyOptional({ default: 0, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip?: number;

  @ApiPropertyOptional({
    default: ESL_DEFAULT_TAKE,
    minimum: 1,
    maximum: ESL_MAX_TAKE,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(ESL_MAX_TAKE)
  take?: number;
}

export class CreateGatewayDto {
  @ApiProperty({
    maxLength: 40,
    description:
      'Short code, unique per tenant and normalized to uppercase. Charset ' +
      'matches the price-book/SKU convention.',
  })
  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/)
  code!: string;

  @ApiProperty({ maxLength: 120 })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiProperty({
    description:
      'Selects the adapter behind EslVendorPort. SIMULATED always resolves; ' +
      'GET /esl/vendors lists what this deployment offers.',
  })
  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/)
  vendorCode!: string;

  @ApiProperty({ description: 'Store (location) id in the caller’s tenant.' })
  @IsString()
  @MinLength(1)
  locationId!: string;

  @ApiPropertyOptional({
    description:
      'OPAQUE configuration key naming the credential this gateway uses ' +
      '(e.g. ACME_STORE_01). NEVER the credential itself — a value that ' +
      'looks like a secret is rejected.',
    maxLength: 120,
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  credentialRef?: string;

  @ApiPropertyOptional({
    description:
      'Credential-free connection hints. Screened on write: a ' +
      'credential-shaped key or value is rejected, exactly as for device ' +
      'metadata.',
  })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class UpdateGatewayDto {
  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ enum: GATEWAY_STATUSES })
  @IsOptional()
  @IsIn(GATEWAY_STATUSES)
  status?: GatewayStatusInput;

  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  credentialRef?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class QueryGatewaysDto extends PaginationDto {
  @ApiPropertyOptional({ enum: GATEWAY_STATUSES })
  @IsOptional()
  @IsIn(GATEWAY_STATUSES)
  status?: GatewayStatusInput;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  locationId?: string;
}

export class RegisterLabelDto {
  @ApiProperty({
    maxLength: 80,
    description: 'The vendor’s own identifier for the hardware.',
  })
  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/)
  vendorLabelId!: string;
}

export class UpdateLabelDto {
  @ApiPropertyOptional({
    description:
      'Product id in the caller’s tenant. Binding a product is what makes ' +
      'the label eligible for price propagation; null unbinds it.',
  })
  @IsOptional()
  @IsString()
  productId?: string | null;

  @ApiPropertyOptional({ description: 'Planogram cell assignment id.' })
  @IsOptional()
  @IsString()
  cellAssignmentId?: string | null;

  @ApiPropertyOptional({
    enum: LABEL_STATUSES,
    description:
      'Normally derived from the binding. Send RETIRED when the hardware ' +
      'leaves the shelf — that is one-way, and it cancels queued work.',
  })
  @IsOptional()
  @IsIn(LABEL_STATUSES)
  status?: LabelStatusInput;
}

export class QueryLabelsDto extends PaginationDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  gatewayId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  productId?: string;

  @ApiPropertyOptional({ enum: LABEL_STATUSES })
  @IsOptional()
  @IsIn(LABEL_STATUSES)
  status?: LabelStatusInput;
}

export class QueryJobsDto extends PaginationDto {
  @ApiPropertyOptional({ enum: JOB_STATUSES })
  @IsOptional()
  @IsIn(JOB_STATUSES)
  status?: JobStatusInput;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  labelId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  gatewayId?: string;
}

export class ProcessJobsDto {
  @ApiPropertyOptional({
    default: ESL_DEFAULT_TAKE,
    minimum: 1,
    maximum: 100,
    description: 'How many jobs this pass may claim.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
