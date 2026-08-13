import { ApiProperty } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/** The operator-recordable subset of the ledger vocabulary. ADJUSTMENT
 *  stays on its own endpoint; SALE belongs to checkout alone. */
export const EXTERNAL_MOVEMENT_TYPES = [
  'RECEIPT',
  'CORRECTION_IN',
  'CORRECTION_OUT',
] as const;
export type ExternalMovementType = (typeof EXTERNAL_MOVEMENT_TYPES)[number];

export class RecordMovementDto {
  @ApiProperty({ description: 'Store (location) id in the caller’s tenant.' })
  @IsString()
  @MinLength(1)
  locationId!: string;

  @ApiProperty({ description: 'Product id in the caller’s tenant.' })
  @IsString()
  @MinLength(1)
  productId!: string;

  @ApiProperty({ enum: EXTERNAL_MOVEMENT_TYPES })
  @IsIn(EXTERNAL_MOVEMENT_TYPES)
  movementType!: ExternalMovementType;

  @ApiProperty({
    minimum: 1,
    description:
      'POSITIVE unit count; the movement type carries the direction ' +
      '(CORRECTION_OUT subtracts). Never a signed delta from the client.',
  })
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  quantity!: number;

  @ApiProperty({ maxLength: 500 })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;

  @ApiProperty({
    maxLength: 100,
    description:
      'External/test reference — the IDEMPOTENCY key: retrying the same ' +
      'reference replays the recorded movement instead of double-stocking.',
  })
  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/)
  reference!: string;
}
