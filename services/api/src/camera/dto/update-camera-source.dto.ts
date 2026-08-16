import { ApiPropertyOptional } from '@nestjs/swagger';
import { CameraSourceStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { IsOptionalNonNull } from '../../common/validation';
import { CREDENTIAL_REF_PATTERN } from './create-camera-source.dto';

/** Partial update — same screening rules as creation. sourceType and
 *  location are immutable (register a new source instead). */
export class UpdateCameraSourceDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 80 })
  @IsOptionalNonNull()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;

  @ApiPropertyOptional()
  @IsOptionalNonNull()
  @IsString()
  @MaxLength(20)
  shelfZone?: string;

  @ApiPropertyOptional({ enum: CameraSourceStatus })
  @IsOptionalNonNull()
  @IsEnum(CameraSourceStatus)
  status?: CameraSourceStatus;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptionalNonNull()
  @IsString()
  @MaxLength(500)
  connectionNote?: string;

  @ApiPropertyOptional({
    description:
      'Reserved slot name (CAMERA_SECRET_SLOT_<NAME>) of an ' +
      'operator-managed secret — never the secret itself',
  })
  @IsOptionalNonNull()
  @Matches(CREDENTIAL_REF_PATTERN, {
    message:
      'credentialRef must name a reserved credential slot ' +
      '(CAMERA_SECRET_SLOT_<NAME>, A-Z/0-9/_ only) — never a password, ' +
      'card number, key, token, URL, or connection string',
  })
  credentialRef?: string;

  @ApiPropertyOptional()
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  replayVideoAssetId?: string;
}
