import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreatePriceBookDto {
  @ApiProperty({
    maxLength: 40,
    description:
      'Short code, unique per tenant and normalized to uppercase (RETAIL, ' +
      'STORE-01-PROMO). Charset matches the SKU/reference convention.',
  })
  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/)
  code!: string;

  @ApiProperty({ maxLength: 120 })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiProperty({
    description: 'ISO-4217 alphabetic currency code, e.g. AED. Every entry ' +
      'in every version of this book is denominated in it.',
  })
  @IsString()
  @Matches(/^[A-Za-z]{3}$/)
  currencyCode!: string;

  @ApiPropertyOptional({
    description:
      'Store (location) id in the caller’s tenant. Omit for the tenant-wide ' +
      'book; a location-scoped book overrides it at that location only.',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  locationId?: string;
}
