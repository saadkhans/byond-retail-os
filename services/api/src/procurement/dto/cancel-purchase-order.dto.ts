import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class CancelPurchaseOrderDto {
  @ApiProperty({
    maxLength: 500,
    description:
      'Why the order was cancelled. Required, because a cancellation with ' +
      'no stated reason is not auditable. Screened for sensitive values.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}
