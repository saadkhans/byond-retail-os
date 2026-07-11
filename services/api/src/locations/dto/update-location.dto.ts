import { ApiPropertyOptional } from '@nestjs/swagger';
import { LocationStatus, LocationType } from '@prisma/client';
import {
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * `code` is immutable (it is the tenant-unique identifier, like a SKU);
 * tenantId never appears in any DTO — it comes from the authenticated user.
 */
export class UpdateLocationDto {
  @ApiPropertyOptional({ example: 'Downtown Flagship', maxLength: 120 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ enum: LocationType })
  @IsOptional()
  @IsEnum(LocationType)
  type?: LocationType;

  @ApiPropertyOptional({ enum: LocationStatus })
  @IsOptional()
  @IsEnum(LocationStatus)
  status?: LocationStatus;

  @ApiPropertyOptional({ example: 'Europe/Berlin' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  timezone?: string;

  @ApiPropertyOptional({ description: 'Free-form address object.' })
  @IsOptional()
  @IsObject()
  address?: Record<string, unknown>;
}
