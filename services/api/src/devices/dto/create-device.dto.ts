import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DeviceStatus, DeviceType } from '@prisma/client';
import {
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateDeviceDto {
  @ApiProperty({ description: 'The retail unit this device is attached to.' })
  @IsString()
  @MinLength(1)
  unitId!: string;

  @ApiProperty({ example: 'Front door lock', maxLength: 120 })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiProperty({ enum: DeviceType, example: DeviceType.DOOR_LOCK })
  @IsEnum(DeviceType)
  type!: DeviceType;

  @ApiPropertyOptional({
    enum: DeviceStatus,
    default: DeviceStatus.PROVISIONED,
  })
  @IsOptional()
  @IsEnum(DeviceStatus)
  status?: DeviceStatus;

  @ApiProperty({
    example: 'SN-9F2C-0001',
    description: 'Hardware serial number / ID, unique per tenant.',
    maxLength: 120,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  serialNumber!: string;

  @ApiPropertyOptional({
    description:
      'SAFE, NON-SECRET configuration only (mount position, stream ' +
      'settings, ...). Never put credentials or tokens here.',
  })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;

  @ApiPropertyOptional({ example: '1.4.2', maxLength: 60 })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  firmwareVersion?: string;

  @ApiPropertyOptional({ example: '2026.07.1', maxLength: 60 })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  softwareVersion?: string;
}
