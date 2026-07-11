import { ApiPropertyOptional } from '@nestjs/swagger';
import { RetailUnitStatus, RetailUnitType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class QueryUnitsDto {
  @ApiPropertyOptional({
    description: 'Case-insensitive substring match on unit name or code.',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({ description: 'Filter by store (location) id.' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  locationId?: string;

  @ApiPropertyOptional({ enum: RetailUnitType })
  @IsOptional()
  @IsEnum(RetailUnitType)
  type?: RetailUnitType;

  @ApiPropertyOptional({ enum: RetailUnitStatus })
  @IsOptional()
  @IsEnum(RetailUnitStatus)
  status?: RetailUnitStatus;

  @ApiPropertyOptional({ default: 0, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip?: number;

  @ApiPropertyOptional({ default: 25, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  take?: number;
}
