import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBooleanString,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
} from 'class-validator';

export class QueryLevelsDto {
  @ApiPropertyOptional({ description: 'Filter by location id.' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  locationId?: string;

  @ApiPropertyOptional({ description: 'Filter by product id.' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  productId?: string;

  @ApiPropertyOptional({
    description:
      'true → only levels at or below the product’s low-stock threshold.',
  })
  @IsOptional()
  @IsBooleanString()
  lowStockOnly?: string;
}

export class QueryMovementsDto {
  @ApiPropertyOptional({ description: 'Filter by location id.' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  locationId?: string;

  @ApiPropertyOptional({ description: 'Filter by product id.' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  productId?: string;

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
