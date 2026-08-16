import { ApiPropertyOptional } from '@nestjs/swagger';
import { CameraSourceStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { IsOptionalNonNull } from '../../common/validation';
import {
  CAMERA_CREDENTIAL_SLOTS,
  CREDENTIAL_REF_MESSAGE,
} from './create-camera-source.dto';

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
      'Server-recognized credential slot name of an operator-managed ' +
      'secret — never the secret itself',
    enum: CAMERA_CREDENTIAL_SLOTS,
  })
  @IsOptionalNonNull()
  @IsIn([...CAMERA_CREDENTIAL_SLOTS], { message: CREDENTIAL_REF_MESSAGE })
  credentialRef?: string;

  @ApiPropertyOptional()
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  replayVideoAssetId?: string;
}
