import { ApiPropertyOptional } from '@nestjs/swagger';
import { LocationStatus, LocationType } from '@prisma/client';
import {
  IsEnum,
  IsObject,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { IsOptionalNonNull } from '../../common/validation';

/**
 * `code` is immutable (it is the tenant-unique identifier, like a SKU);
 * tenantId never appears in any DTO — it comes from the authenticated user.
 * Fields may be omitted but never null (IsOptionalNonNull → controlled 400).
 */
export class UpdateLocationDto {
  @ApiPropertyOptional({ example: 'Downtown Flagship', maxLength: 120 })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ enum: LocationType })
  @IsOptionalNonNull()
  @IsEnum(LocationType)
  type?: LocationType;

  @ApiPropertyOptional({ enum: LocationStatus })
  @IsOptionalNonNull()
  @IsEnum(LocationStatus)
  status?: LocationStatus;

  @ApiPropertyOptional({ example: 'Europe/Berlin' })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  timezone?: string;

  @ApiPropertyOptional({ description: 'Free-form address object.' })
  @IsOptionalNonNull()
  @IsObject()
  address?: Record<string, unknown>;
}
