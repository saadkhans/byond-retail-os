import { ApiPropertyOptional } from '@nestjs/swagger';
import { ProductStatus, UnitOfMeasure } from '@prisma/client';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { PG_INT_MAX } from '../../common/integer-bounds';

// SKU is intentionally NOT updatable: it identifies the product to external
// systems (barcode mappings, future POS/edge caches) and to the immutable
// inventory ledger's consumers. Barcodes are managed via the dedicated
// barcode sub-endpoints, not here.
export class UpdateProductDto {
  @ApiPropertyOptional({ example: 'Cola 330ml Can', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({ maxLength: 2000, nullable: true })
  @ValidateIf((_object, value) => value !== undefined && value !== null)
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @ApiPropertyOptional({
    description: 'Category id (same tenant); null detaches.',
    nullable: true,
  })
  @ValidateIf((_object, value) => value !== undefined && value !== null)
  @IsString()
  @MinLength(1)
  categoryId?: string | null;

  @ApiPropertyOptional({
    description: 'Brand id (same tenant); null detaches.',
    nullable: true,
  })
  @ValidateIf((_object, value) => value !== undefined && value !== null)
  @IsString()
  @MinLength(1)
  brandId?: string | null;

  // These enum columns are NOT nullable. Plain @IsOptional() would let an
  // explicit `null` skip @IsEnum and fall through to a Prisma/DB error;
  // @ValidateIf keeps null in scope so it is rejected as a 400 instead.
  @ApiPropertyOptional({ enum: UnitOfMeasure })
  @ValidateIf((_object, value) => value !== undefined)
  @IsEnum(UnitOfMeasure)
  unitOfMeasure?: UnitOfMeasure;

  @ApiPropertyOptional({ enum: ProductStatus })
  @ValidateIf((_object, value) => value !== undefined)
  @IsEnum(ProductStatus)
  status?: ProductStatus;

  @ApiPropertyOptional({ example: 12, nullable: true })
  @ValidateIf((_object, value) => value !== undefined && value !== null)
  @IsInt()
  @Min(0)
  @Max(PG_INT_MAX)
  lowStockThreshold?: number | null;
}
