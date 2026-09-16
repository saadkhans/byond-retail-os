import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
} from 'class-validator';

export class QueryPriceBooksDto {
  @ApiPropertyOptional({ description: 'Filter by location id.' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  locationId?: string;

  @ApiPropertyOptional({ enum: ['ACTIVE', 'ARCHIVED'] })
  @IsOptional()
  @IsIn(['ACTIVE', 'ARCHIVED'])
  status?: 'ACTIVE' | 'ARCHIVED';

  @ApiPropertyOptional({ default: 0, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip?: number;

  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  take?: number;
}

export class ResolvePriceDto {
  @ApiPropertyOptional({ description: 'Product id in the caller’s tenant.' })
  @IsString()
  @MinLength(1)
  productId!: string;

  @ApiPropertyOptional({
    description: 'Instant to price at (ISO-8601). Defaults to now.',
  })
  @IsOptional()
  @IsISO8601()
  at?: string;

  @ApiPropertyOptional({
    description:
      'Store (location) id. A location-scoped book overrides the ' +
      'tenant-wide book there.',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  locationId?: string;
}
