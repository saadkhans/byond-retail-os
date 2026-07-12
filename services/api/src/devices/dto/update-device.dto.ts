import { ApiPropertyOptional } from '@nestjs/swagger';
import { DeviceStatus, DeviceType } from '@prisma/client';
import {
  IsEnum,
  IsObject,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { IsOptionalNonNull } from '../../common/validation';

/**
 * `serialNumber` is immutable (it identifies the physical hardware);
 * tenantId never appears in any DTO — it comes from the authenticated user.
 * RETIRED is terminal: a retired device's status can never change again.
 * `lastSeenAt` is never client-writable — only the heartbeat endpoint and
 * edge registration update it. Fields may be omitted but never null
 * (IsOptionalNonNull → controlled 400, not a 500 from trimming null).
 */
export class UpdateDeviceDto {
  @ApiPropertyOptional({
    description: 'Reassign the device to another unit in the same tenant.',
  })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  unitId?: string;

  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ enum: DeviceType })
  @IsOptionalNonNull()
  @IsEnum(DeviceType)
  type?: DeviceType;

  @ApiPropertyOptional({ enum: DeviceStatus })
  @IsOptionalNonNull()
  @IsEnum(DeviceStatus)
  status?: DeviceStatus;

  @ApiPropertyOptional({
    description: 'SAFE, NON-SECRET configuration only.',
  })
  @IsOptionalNonNull()
  @IsObject()
  metadata?: Record<string, unknown>;

  @ApiPropertyOptional({ maxLength: 60 })
  @IsOptionalNonNull()
  @IsString()
  @MaxLength(60)
  firmwareVersion?: string;

  @ApiPropertyOptional({ maxLength: 60 })
  @IsOptionalNonNull()
  @IsString()
  @MaxLength(60)
  softwareVersion?: string;
}
