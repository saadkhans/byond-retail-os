import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Rollback never resurrects the old version. It copies that version's entries
 * into a NEW version and activates it, so the history reads forward: v3 was
 * wrong, v4 restores v2. Reversibility without rewriting.
 */
export class RollbackVersionDto {
  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
