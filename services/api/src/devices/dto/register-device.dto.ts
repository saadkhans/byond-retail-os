import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Edge registration redemption. The one-time registration token (issued to a
 * tenant admin holding device:register) is the credential — it is compared
 * by SHA-256 hash, bound to the device's serial number, single-use, and
 * expiring. Neither field is ever logged.
 */
export class RegisterDeviceDto {
  @ApiProperty({
    example: 'SN-9F2C-0001',
    description: 'Hardware serial number of the device being registered.',
    maxLength: 120,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  serialNumber!: string;

  @ApiProperty({
    description:
      'One-time registration token issued via ' +
      'POST /devices/:id/registration-token.',
  })
  @IsString()
  @MinLength(20)
  @MaxLength(200)
  registrationToken!: string;
}
