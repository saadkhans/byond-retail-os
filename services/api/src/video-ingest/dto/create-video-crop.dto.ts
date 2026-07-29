import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { VideoCropReason } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsEnum,
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

/**
 * Upper bound on crop geometry accepted at the DTO layer — generous for any
 * real camera (8K is 7680px) while keeping arithmetic far from integer
 * limits. The service additionally validates the box against the ACTUAL
 * probed video dimensions.
 */
export const MAX_CROP_DIMENSION = 16_384;

/** Video position ceiling at the DTO layer (~24 h) — PG int stays safe. */
export const MAX_TIMESTAMP_MS = 86_400_000;

/**
 * Manual crop request: a timestamp plus a crop box, with an OPTIONAL closed
 * reason vocabulary (no free text — nothing sensitive can ride along).
 * Validation is layered: DTO bounds here, then duration/dimension checks
 * against the probed metadata in the service.
 */
export class CreateVideoCropDto {
  @ApiProperty({ minimum: 0, maximum: MAX_TIMESTAMP_MS })
  // Not @Type(() => Number): Number('') is 0 — a blank string would become
  // a silently VALID timestamp instead of a 400. Blank → NaN → rejected.
  @Transform(toNumberRejectingBlank)
  @IsInt()
  @Min(0)
  @Max(MAX_TIMESTAMP_MS)
  timestampMs!: number;

  @ApiProperty({ minimum: 0, maximum: MAX_CROP_DIMENSION })
  @Transform(toNumberRejectingBlank)
  @IsInt()
  @Min(0)
  @Max(MAX_CROP_DIMENSION)
  x!: number;

  @ApiProperty({ minimum: 0, maximum: MAX_CROP_DIMENSION })
  @Transform(toNumberRejectingBlank)
  @IsInt()
  @Min(0)
  @Max(MAX_CROP_DIMENSION)
  y!: number;

  @ApiProperty({ minimum: 1, maximum: MAX_CROP_DIMENSION })
  @Transform(toNumberRejectingBlank)
  @IsInt()
  @Min(1)
  @Max(MAX_CROP_DIMENSION)
  width!: number;

  @ApiProperty({ minimum: 1, maximum: MAX_CROP_DIMENSION })
  @Transform(toNumberRejectingBlank)
  @IsInt()
  @Min(1)
  @Max(MAX_CROP_DIMENSION)
  height!: number;

  @ApiPropertyOptional({
    enum: VideoCropReason,
    description:
      'Why the crop was taken — closed vocabulary only, no free text.',
  })
  @IsOptionalNonNull()
  @IsEnum(VideoCropReason)
  reason?: VideoCropReason;

  /**
   * REQUIRED for the same reason as on ExtractFramesDto: the key is the
   * operation's identity and the committed artifact file is staged under a
   * key derived from it. A keyless request would derive its staging key
   * from the request fingerprint alone, so a later identical keyless crop
   * would re-put over the file an earlier append-only artifact row already
   * owns while that row kept its recorded checksum.
   */
  @ApiProperty({
    maxLength: 100,
    description:
      'REQUIRED tenant-scoped idempotency key: retrying a committed crop ' +
      'REPLAYS its artifact (append-only rows are never duplicated, and ' +
      'the committed artifact file is never rewritten).',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  idempotencyKey!: string;
}
