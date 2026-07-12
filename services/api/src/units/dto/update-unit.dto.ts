import { ApiPropertyOptional } from '@nestjs/swagger';
import { RetailUnitStatus, RetailUnitType } from '@prisma/client';
import {
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { IsOptionalNonNull } from '../../common/validation';

/**
 * `code` is immutable (tenant-unique identifier); tenantId never appears in
 * any DTO — it comes from the authenticated user. RETIRED is terminal: a
 * retired unit's status can never change again. Fields may be omitted but
 * never null — except `placement`, where null explicitly clears the value.
 */
export class UpdateUnitDto {
  @ApiPropertyOptional({
    description: 'Reassign the unit to another store in the same tenant.',
  })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  locationId?: string;

  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ enum: RetailUnitType })
  @IsOptionalNonNull()
  @IsEnum(RetailUnitType)
  type?: RetailUnitType;

  @ApiPropertyOptional({ enum: RetailUnitStatus })
  @IsOptionalNonNull()
  @IsEnum(RetailUnitStatus)
  status?: RetailUnitStatus;

  @ApiPropertyOptional({
    description: 'Physical placement within the store. Null clears it.',
    maxLength: 240,
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsString()
  @MaxLength(240)
  placement?: string | null;
}
