import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

export class UpdateCategoryDto {
  @ApiPropertyOptional({ example: 'Beverages', maxLength: 120 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  // Non-nullable string: reject an explicit null (which @IsOptional would let
  // through into the service's .trim(), a 500) as a 400 instead.
  @ApiPropertyOptional({ example: 'Soft drinks, juices, and water.' })
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({
    description: 'Parent category id (same tenant); null detaches.',
    nullable: true,
  })
  // Explicit null is a valid value here (detach from parent), so plain
  // @IsOptional() is not enough — validate only when a string arrives.
  @ValidateIf((_object, value) => value !== undefined && value !== null)
  @IsString()
  @MinLength(1)
  parentId?: string | null;
}
