import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';
import {
  IsOptionalNonNull,
  toNumberRejectingBlank,
} from '../../common/validation';

/** Start one live RTSP shadow session on a camera source. The stream URL
 *  is resolved server-side from the source's credential slot — it is
 *  never part of any request or response. */
export class StartLiveSessionDto {
  @ApiPropertyOptional({
    minimum: 500,
    maximum: 60000,
    default: 1000,
    description: 'Live sampling interval (ms per sampled frame)',
  })
  @IsOptionalNonNull()
  @Transform(toNumberRejectingBlank)
  @IsInt()
  @Min(500)
  @Max(60000)
  frameIntervalMs?: number;
}
