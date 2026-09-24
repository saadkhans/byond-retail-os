import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

export class SubmitPurchaseOrderDto {
  @ApiPropertyOptional({
    default: true,
    description:
      'Send the order through the supplier adapter. Set false to record a ' +
      'submission made outside the system, such as a phone call or an ' +
      'email, which leaves the acknowledgement reference empty.',
  })
  @IsOptional()
  @IsBoolean()
  sendToSupplier?: boolean;
}
