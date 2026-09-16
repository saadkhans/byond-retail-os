import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Only the display name and the archive flag are mutable. Code, currency and
 * location scope are identity: changing them would silently reinterpret every
 * historical version of the book.
 */
export class UpdatePriceBookDto {
  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ enum: ['ACTIVE', 'ARCHIVED'] })
  @IsOptional()
  @IsIn(['ACTIVE', 'ARCHIVED'])
  status?: 'ACTIVE' | 'ARCHIVED';
}
