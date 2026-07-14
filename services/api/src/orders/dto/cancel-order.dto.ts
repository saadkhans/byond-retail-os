import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { IsOptionalNonNull } from '../../common/validation';

export class CancelOrderDto {
  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason?: string;
}
