import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class UpdateBrandDto {
  @ApiPropertyOptional({ example: 'Acme Foods', maxLength: 120 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ example: 'House brand for dry goods.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}
