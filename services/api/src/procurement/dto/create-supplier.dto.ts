import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateSupplierDto {
  @ApiProperty({
    maxLength: 40,
    description:
      'Short code, unique per tenant and normalized to uppercase (ACME, ' +
      'GULF-FOODS). Charset matches the SKU and price-book convention.',
  })
  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/)
  code!: string;

  @ApiProperty({ maxLength: 160 })
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name!: string;

  @ApiPropertyOptional({ maxLength: 160 })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  contactName?: string;

  @ApiPropertyOptional({ maxLength: 254 })
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  contactEmail?: string;

  @ApiPropertyOptional({
    maxLength: 40,
    description: 'Digits, spaces and the usual punctuation only.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[0-9+()\s.-]{3,40}$/)
  contactPhone?: string;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: 365,
    description: 'Default lead time in days, used to suggest a delivery date.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  leadTimeDays?: number;

  @ApiPropertyOptional({
    maxLength: 2000,
    description:
      'Operator notes. Screened for credential- and payment-bearing values ' +
      'before being stored, because they are copied into the audit log.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
