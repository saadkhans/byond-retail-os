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

/**
 * `code` is immutable (tenant-unique identifier); tenantId never appears in
 * any DTO — it comes from the authenticated user. RETIRED is terminal: a
 * retired unit's status can never change again.
 */
export class UpdateUnitDto {
  @ApiPropertyOptional({
    description: 'Reassign the unit to another store in the same tenant.',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  locationId?: string;

  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ enum: RetailUnitType })
  @IsOptional()
  @IsEnum(RetailUnitType)
  type?: RetailUnitType;

  @ApiPropertyOptional({ enum: RetailUnitStatus })
  @IsOptional()
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
