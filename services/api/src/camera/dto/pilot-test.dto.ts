import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';
import {
  IsOptionalNonNull,
  toNumberRejectingBlank,
} from '../../common/validation';

/** Phase 14 — dev/admin pilot test run against a (file-backed) dev
 *  source. Bounded budgets only; the runner is gated by
 *  CV_LIVE_PILOT_RUNNER_ENABLED and returns a controlled summary with
 *  no URL or credential material. */
export class PilotTestDto {
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

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 300,
    default: 30,
    description: 'Stop after this many sampled frames',
  })
  @IsOptionalNonNull()
  @Transform(toNumberRejectingBlank)
  @IsInt()
  @Min(1)
  @Max(300)
  maxFrames?: number;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 120,
    default: 60,
    description: 'Stop after this many seconds regardless of frames',
  })
  @IsOptionalNonNull()
  @Transform(toNumberRejectingBlank)
  @IsInt()
  @Min(1)
  @Max(120)
  maxSeconds?: number;
}
