import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ReconciliationStatus } from '@prisma/client';
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
 * Manual reconciliation status update (no settlement accounting, no provider
 * import in Phase 6). RECONCILED is terminal.
 */
export class UpdateReconciliationDto {
  @ApiProperty({
    enum: ReconciliationStatus,
    description: 'Target reconciliation status.',
  })
  @IsEnum(ReconciliationStatus)
  status!: ReconciliationStatus;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: PG_INT_MAX,
    description: 'Provider-reported settled amount, in minor units.',
  })
  @IsOptionalNonNull()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(PG_INT_MAX)
  reportedAmountMinor?: number;

  @ApiPropertyOptional({
    maxLength: 500,
    description: 'Operator reconciliation note (screened for sensitive values).',
  })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  notes?: string;
}
