import { ApiPropertyOptional } from '@nestjs/swagger';
import { ProductStatus } from '@prisma/client';
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

export class QueryProductsDto {
  @ApiPropertyOptional({
    description: 'Case-insensitive substring match on product name or SKU.',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({ description: 'Exact barcode value.' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  barcode?: string;

  @ApiPropertyOptional({ description: 'Filter by category id.' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  categoryId?: string;

  @ApiPropertyOptional({ description: 'Filter by brand id.' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  brandId?: string;

  @ApiPropertyOptional({ enum: ProductStatus })
  @IsOptional()
  @IsEnum(ProductStatus)
  status?: ProductStatus;

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
