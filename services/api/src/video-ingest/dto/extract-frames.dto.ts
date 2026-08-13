import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsInt,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  IsOptionalNonNull,
  toNumberRejectingBlank,
} from '../../common/validation';
import { MAX_TIMESTAMP_MS } from './create-video-crop.dto';

export const DEFAULT_FRAME_INTERVAL_MS = 1000;
export const DEFAULT_MAX_FRAMES = 5;
/** Hard ceiling per request — Phase 10 clips are 10–30 s test videos. */
export const FRAME_EXTRACTION_CAP = 30;

/**
 * Frame-extraction request. Either sample at an interval (intervalMs +
 * maxFrames, both bounded) or extract a single frame (timestampMs). All
 * values are re-validated against the probed duration in the service.
 */
export class ExtractFramesDto {
  @ApiPropertyOptional({
    minimum: 100,
    maximum: 60_000,
    default: DEFAULT_FRAME_INTERVAL_MS,
  })
  @IsOptionalNonNull()
  @Transform(toNumberRejectingBlank)
  @IsInt()
  @Min(100)
  @Max(60_000)
  intervalMs?: number;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: FRAME_EXTRACTION_CAP,
    default: DEFAULT_MAX_FRAMES,
  })
  @IsOptionalNonNull()
  @Transform(toNumberRejectingBlank)
  @IsInt()
  @Min(1)
  @Max(FRAME_EXTRACTION_CAP)
  maxFrames?: number;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: MAX_TIMESTAMP_MS,
    description:
      'Extract exactly ONE frame at this position instead of sampling.',
  })
  @IsOptionalNonNull()
  @Transform(toNumberRejectingBlank)
  @IsInt()
  @Min(0)
  @Max(MAX_TIMESTAMP_MS)
  timestampMs?: number;

  /**
   * REQUIRED (not optional): the key is the operation's identity, and the
   * committed artifact files are staged under keys derived from it. Without
   * one, every later identical keyless request would derive the SAME
   * deterministic keys from the request fingerprint alone and re-put over
   * files an earlier append-only artifact row already owns — that row keeps
   * its recorded checksum while the bytes underneath it change, silently
   * corrupting tamper-evident lineage. Requiring the key also STRENGTHENS
   * the staged-file cleanup invariant (see stagePublishAndCleanup): a
   * `replayed` outcome now always implies a CONSUMED idempotency key.
   */
  @ApiProperty({
    maxLength: 100,
    description:
      'REQUIRED tenant-scoped idempotency key: retrying a committed ' +
      'extraction REPLAYS its artifacts (append-only rows are never ' +
      'duplicated, and committed artifact files are never rewritten).',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  idempotencyKey!: string;
}
