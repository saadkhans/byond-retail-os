import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, Matches, MinLength } from 'class-validator';
import { IsOptionalNonNull } from '../../common/validation';

/**
 * Multipart companion fields for a test-video upload. The file itself
 * travels as the `file` part; these OPTIONAL ids bind the asset to a
 * store/unit/device/session, all verified same-tenant by composite FKs.
 * There is NO client-supplied storage path, filename override, or URL —
 * storage keys are server-generated.
 */
export class UploadVideoAssetDto {
  @ApiProperty({
    description:
      'REQUIRED operator attestation that this is a staged, controlled ' +
      'TEST clip whose frames contain no payment-card or credential ' +
      'content. Text screening cannot inspect pixels, and raw card data ' +
      'must never reach storage — until CV-based frame screening ships, ' +
      'storing is gated on this explicit, audited declaration. Must be ' +
      'the literal string "true".',
  })
  @IsString()
  @Matches(/^true$/, {
    message:
      'attestNoSensitiveContent must be "true": uploads are stored only ' +
      'with an explicit attestation that the staged test clip contains no ' +
      'payment-card or credential content in its frames',
  })
  attestNoSensitiveContent!: string;

  @ApiPropertyOptional({ description: 'Store (location) the clip was shot in.' })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  locationId?: string;

  @ApiPropertyOptional({ description: 'Retail unit in frame (must be in the store).' })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  unitId?: string;

  @ApiPropertyOptional({ description: 'Source camera/device (must be attached to the unit).' })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  deviceId?: string;

  @ApiPropertyOptional({ description: 'Checkout session the clip relates to.' })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  sessionId?: string;
}
