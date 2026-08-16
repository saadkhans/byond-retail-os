import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CameraSourceType } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { IsOptionalNonNull } from '../../common/validation';

/** Reserved secret-slot namespace — the ONLY credentialRef shape accepted
 *  (mirrored by a DB CHECK). A password, card number, key, token, URL, or
 *  connection string cannot accidentally take this shape; the service
 *  additionally runs the shared secret-value detector before persisting. */
export const CREDENTIAL_REF_PATTERN = /^CAMERA_SECRET_SLOT_[A-Z0-9_]{3,40}$/;

/**
 * Camera source registration. No credential and no URL is ever accepted:
 * connectionNote is screened free text (reject-on-write, same policy as
 * journey notes — a credential-embedding stream URL never passes), and
 * credentialRef is only the NAME of an operator-managed secret slot.
 */
export class CreateCameraSourceDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  locationId!: string;

  @ApiPropertyOptional()
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  unitId?: string;

  @ApiProperty({ minLength: 1, maxLength: 80 })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @ApiPropertyOptional({
    description: 'Shelf grid cell (e.g. zone-r2c3) that scopes motion scoring',
  })
  @IsOptionalNonNull()
  @IsString()
  @MaxLength(20)
  shelfZone?: string;

  @ApiProperty({ enum: CameraSourceType })
  @IsEnum(CameraSourceType)
  sourceType!: CameraSourceType;

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

  @ApiPropertyOptional({
    description: 'FILE_REPLAY: default video asset this source replays',
  })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  replayVideoAssetId?: string;
}
