import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  CameraCalibrationMount,
  CameraCalibrationOrientation,
  CameraCalibrationZoneType,
} from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { IsOptionalNonNull } from '../../common/validation';

/**
 * Phase 17 — camera calibration DTOs. SAFE, structured setup metadata
 * only: no URL, path, credential slot, raw frame, or raw video field
 * exists here, and every free-text field is screened again at the
 * service layer (reject-on-write). The polygon body is validated deeply
 * in the service (3..20 points, each coordinate in [0, 1]).
 */

export const CALIBRATION_NAME_MAX_LENGTH = 120;
export const CALIBRATION_LABEL_MAX_LENGTH = 120;
export const CALIBRATION_NOTES_MAX_LENGTH = 500;
export const CALIBRATION_EXPECTED_PRODUCTS_MAX = 25;

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateCalibrationProfileDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  cameraSourceId!: string;

  @ApiProperty({ minLength: 1, maxLength: CALIBRATION_NAME_MAX_LENGTH })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(CALIBRATION_NAME_MAX_LENGTH)
  name!: string;

  @ApiPropertyOptional()
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  locationId?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 16384 })
  @IsOptionalNonNull()
  @IsInt()
  @Min(1)
  @Max(16384)
  frameWidth?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 16384 })
  @IsOptionalNonNull()
  @IsInt()
  @Min(1)
  @Max(16384)
  frameHeight?: number;

  @ApiPropertyOptional({ enum: CameraCalibrationOrientation })
  @IsOptionalNonNull()
  @IsEnum(CameraCalibrationOrientation)
  orientation?: CameraCalibrationOrientation;

  @ApiPropertyOptional({ enum: CameraCalibrationMount })
  @IsOptionalNonNull()
  @IsEnum(CameraCalibrationMount)
  cameraMount?: CameraCalibrationMount;

  @ApiPropertyOptional({ maxLength: CALIBRATION_NOTES_MAX_LENGTH })
  @IsOptionalNonNull()
  @IsString()
  @MaxLength(CALIBRATION_NOTES_MAX_LENGTH)
  notes?: string;
}

export class UpdateCalibrationProfileDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: CALIBRATION_NAME_MAX_LENGTH })
  @IsOptionalNonNull()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(CALIBRATION_NAME_MAX_LENGTH)
  name?: string;

  @ApiPropertyOptional()
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  locationId?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 16384 })
  @IsOptionalNonNull()
  @IsInt()
  @Min(1)
  @Max(16384)
  frameWidth?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 16384 })
  @IsOptionalNonNull()
  @IsInt()
  @Min(1)
  @Max(16384)
  frameHeight?: number;

  @ApiPropertyOptional({ enum: CameraCalibrationOrientation })
  @IsOptionalNonNull()
  @IsEnum(CameraCalibrationOrientation)
  orientation?: CameraCalibrationOrientation;

  @ApiPropertyOptional({ enum: CameraCalibrationMount })
  @IsOptionalNonNull()
  @IsEnum(CameraCalibrationMount)
  cameraMount?: CameraCalibrationMount;

  @ApiPropertyOptional({ maxLength: CALIBRATION_NOTES_MAX_LENGTH })
  @IsOptionalNonNull()
  @IsString()
  @MaxLength(CALIBRATION_NOTES_MAX_LENGTH)
  notes?: string;
}

export class CreateCalibrationZoneDto {
  @ApiProperty({ enum: CameraCalibrationZoneType })
  @IsEnum(CameraCalibrationZoneType)
  zoneType!: CameraCalibrationZoneType;

  @ApiProperty({ minLength: 1, maxLength: CALIBRATION_LABEL_MAX_LENGTH })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(CALIBRATION_LABEL_MAX_LENGTH)
  label!: string;

  @ApiProperty({
    description:
      'Normalized polygon: an array of {x, y} points with every ' +
      'coordinate in [0, 1] (never raw pixels); 3..20 points.',
  })
  @IsArray()
  polygon!: unknown[];

  @ApiPropertyOptional({ minimum: 0, maximum: 1 })
  @IsOptionalNonNull()
  @IsNumber()
  @Min(0)
  @Max(1)
  qualityScore?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptionalNonNull()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ default: 0 })
  @IsOptionalNonNull()
  @IsInt()
  @Min(0)
  @Max(10000)
  sortOrder?: number;

  @ApiPropertyOptional({
    description:
      'SHELF_ZONE only: tenant-scoped product ids the shelf is expected ' +
      'to carry (testing aid, never a basket/inventory input).',
    maxItems: CALIBRATION_EXPECTED_PRODUCTS_MAX,
  })
  @IsOptionalNonNull()
  @IsArray()
  @ArrayMaxSize(CALIBRATION_EXPECTED_PRODUCTS_MAX)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  expectedProductIds?: string[];
}

export class UpdateCalibrationZoneDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: CALIBRATION_LABEL_MAX_LENGTH })
  @IsOptionalNonNull()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(CALIBRATION_LABEL_MAX_LENGTH)
  label?: string;

  @ApiPropertyOptional({
    description: 'Replacement normalized polygon (3..20 points in [0, 1]).',
  })
  @IsOptionalNonNull()
  @IsArray()
  polygon?: unknown[];

  @ApiPropertyOptional({ minimum: 0, maximum: 1 })
  @IsOptionalNonNull()
  @IsNumber()
  @Min(0)
  @Max(1)
  qualityScore?: number;

  @ApiPropertyOptional()
  @IsOptionalNonNull()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional()
  @IsOptionalNonNull()
  @IsInt()
  @Min(0)
  @Max(10000)
  sortOrder?: number;

  @ApiPropertyOptional({
    description: 'REPLACE-ALL semantics: the full new expected-product set.',
    maxItems: CALIBRATION_EXPECTED_PRODUCTS_MAX,
  })
  @IsOptionalNonNull()
  @IsArray()
  @ArrayMaxSize(CALIBRATION_EXPECTED_PRODUCTS_MAX)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  expectedProductIds?: string[];
}
