import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';
import { PG_INT_MAX } from '../../common/integer-bounds';
import { IsOptionalNonNull } from '../../common/validation';
import { EvidenceRefsDto } from './evidence-refs.dto';

export class UpdateSessionLineDto extends EvidenceRefsDto {
  @ApiPropertyOptional({ minimum: 1, maximum: PG_INT_MAX })
  @IsOptionalNonNull()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PG_INT_MAX)
  quantity?: number;
}
