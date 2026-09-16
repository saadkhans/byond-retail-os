import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateLoyaltyAccountDto {
  @ApiProperty({
    maxLength: 40,
    description:
      'Member code, unique per tenant and normalized to uppercase. Charset ' +
      'matches the SKU/price-book convention. It is an OPERATOR-ISSUED ' +
      'identifier — never an email address, phone number, or card number.',
  })
  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/)
  memberCode!: string;

  @ApiPropertyOptional({
    maxLength: 120,
    description:
      'Operator-facing label. Screened free text: a value that looks like a ' +
      'credential or payment instrument is rejected, not stored.',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  displayName?: string;
}

export class UpdateLoyaltyAccountDto {
  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  displayName?: string;

  @ApiPropertyOptional({
    enum: ['ACTIVE', 'SUSPENDED', 'CLOSED'],
    description:
      'CLOSED is terminal: a closed account is never reopened and never ' +
      'moves points again. Its ledger history is kept intact.',
  })
  @IsOptional()
  @IsIn(['ACTIVE', 'SUSPENDED', 'CLOSED'])
  status?: 'ACTIVE' | 'SUSPENDED' | 'CLOSED';
}

export class QueryLoyaltyAccountsDto {
  @ApiPropertyOptional({ enum: ['ACTIVE', 'SUSPENDED', 'CLOSED'] })
  @IsOptional()
  @IsIn(['ACTIVE', 'SUSPENDED', 'CLOSED'])
  status?: 'ACTIVE' | 'SUSPENDED' | 'CLOSED';

  @ApiPropertyOptional({ description: 'Exact member code (case-insensitive).' })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/)
  memberCode?: string;

  @ApiPropertyOptional({ default: 0, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip?: number;

  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  take?: number;
}

export class QueryPointMovementsDto {
  @ApiPropertyOptional({ default: 0, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip?: number;

  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  take?: number;
}
