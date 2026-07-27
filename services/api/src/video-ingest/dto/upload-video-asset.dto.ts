import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';
import { IsOptionalNonNull } from '../../common/validation';

/**
 * Multipart companion fields for a test-video upload. The file itself
 * travels as the `file` part; these OPTIONAL ids bind the asset to a
 * store/unit/device/session, all verified same-tenant by composite FKs.
 * There is NO client-supplied storage path, filename override, or URL —
 * storage keys are server-generated.
 */
export class UploadVideoAssetDto {
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
