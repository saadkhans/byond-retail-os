import { ApiPropertyOptional } from '@nestjs/swagger';
import { DeviceStatus, DeviceType } from '@prisma/client';
import {
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * `serialNumber` is immutable (it identifies the physical hardware);
 * tenantId never appears in any DTO — it comes from the authenticated user.
 * RETIRED is terminal: a retired device's status can never change again.
 * `lastSeenAt` is never client-writable — only the heartbeat endpoint and
 * edge registration update it.
 */
export class UpdateDeviceDto {
  @ApiPropertyOptional({
    description: 'Reassign the device to another unit in the same tenant.',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  unitId?: string;

  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ enum: DeviceType })
  @IsOptional()
  @IsEnum(DeviceType)
  type?: DeviceType;

  @ApiPropertyOptional({ enum: DeviceStatus })
  @IsOptional()
  @IsEnum(DeviceStatus)
  status?: DeviceStatus;

  @ApiPropertyOptional({
    description: 'SAFE, NON-SECRET configuration only.',
  })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;

  @ApiPropertyOptional({ maxLength: 60 })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  firmwareVersion?: string;

  @ApiPropertyOptional({ maxLength: 60 })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  softwareVersion?: string;
}
