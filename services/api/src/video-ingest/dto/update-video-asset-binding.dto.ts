import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class RackFrameRegionBindingDto {
  @IsNumber()
  @Min(0)
  @Max(1)
  x!: number;

  @IsNumber()
  @Min(0)
  @Max(1)
  y!: number;

  @IsNumber()
  @Min(0.01)
  @Max(1)
  width!: number;

  @IsNumber()
  @Min(0.01)
  @Max(1)
  height!: number;
}

/**
 * Phase 22 — set or change the planogram binding of an uploaded clip
 * AFTER upload. Every field is optional; `null` clears the rack binding
 * (and its region). A rack code must name an ACTIVE planogram rack at the
 * clip's store — validated server-side before the row changes.
 */
export class UpdateVideoAssetBindingDto {
  @ApiPropertyOptional({ description: 'Store (location) the clip was shot in.' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  locationId?: string;

  @ApiPropertyOptional({
    description:
      'Retail unit at the clip\'s store. Classical v1 detection records a ' +
      'pickup event and needs it; null clears it.',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  unitId?: string | null;

  @ApiPropertyOptional({
    description: 'ACTIVE planogram rack code at that store; null clears the binding.',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  planogramRackCode?: string | null;

  @ApiPropertyOptional({
    description:
      'Where the rack sits in the frame (normalized rectangle). Leave out ' +
      'when the rack fills the frame; null clears it.',
    nullable: true,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => RackFrameRegionBindingDto)
  rackFrameRegion?: RackFrameRegionBindingDto | null;
}
