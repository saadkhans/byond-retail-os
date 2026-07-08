import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

export class UpdateBrandDto {
  @ApiPropertyOptional({ example: 'Acme Foods', maxLength: 120 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  // description is a non-nullable string here (it is not documented as
  // clearable). @ValidateIf keeps an explicit null in scope so @IsString
  // rejects it as a 400, instead of it reaching the service's .trim() as a
  // TypeError/500.
  @ApiPropertyOptional({ example: 'House brand for dry goods.' })
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @MaxLength(500)
  description?: string;
}
