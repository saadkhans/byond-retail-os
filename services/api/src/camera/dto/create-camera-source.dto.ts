import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CameraSourceType } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { IsOptionalNonNull } from '../../common/validation';

/**
 * The ONLY credential references accepted: an explicit SERVER-RECOGNIZED
 * allowlist (mirrored by a DB CHECK). Adding a slot is a code+migration
 * change, never operator input — and that is the point (Codex P1): any
 * caller-composed suffix could smuggle a letter-separated card number
 * (…SLOT_ABCD4111…) or a password word past every shape heuristic, so no
 * heuristic is trusted. The value is only ever the lookup NAME of an
 * operator-managed secret slot; no secret is stored, and responses expose
 * only a hasCredentialRef boolean.
 */
export const CAMERA_CREDENTIAL_SLOTS = [
  'CAMERA_SECRET_SLOT_TEST',
  'CAMERA_SECRET_SLOT_ALPHA',
  'CAMERA_SECRET_SLOT_DEMO',
  'CAMERA_SECRET_SLOT_EDGE_CAM_A',
  'CAMERA_SECRET_SLOT_EDGE_CAM_B',
] as const;

export const CREDENTIAL_REF_MESSAGE =
  'credentialRef must be one of the server-recognized credential slots ' +
  `(${CAMERA_CREDENTIAL_SLOTS.join(', ')}) — never a password, card ` +
  'number, key, token, URL, or connection string';

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
      'Server-recognized credential slot name of an operator-managed ' +
      'secret — never the secret itself',
    enum: CAMERA_CREDENTIAL_SLOTS,
  })
  @IsOptionalNonNull()
  @IsIn([...CAMERA_CREDENTIAL_SLOTS], { message: CREDENTIAL_REF_MESSAGE })
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
