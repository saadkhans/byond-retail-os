import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO8601, IsOptional, IsString, MaxLength } from 'class-validator';

export class ActivateVersionDto {
  @ApiPropertyOptional({
    description:
      'ISO-8601 instant the version starts applying. Defaults to now. Must ' +
      'be strictly after the currently active version’s effectiveFrom, ' +
      'otherwise the two effective windows would run backwards.',
  })
  @IsOptional()
  @IsISO8601()
  effectiveFrom?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
