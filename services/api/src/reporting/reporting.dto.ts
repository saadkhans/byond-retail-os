import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
} from 'class-validator';
import { DEFAULT_BALANCE_ROWS, MAX_BALANCE_ROWS } from './reporting.constants';

/**
 * Query shapes for the read-only report routes.
 *
 * There is DELIBERATELY no free-text field anywhere in this file, and no
 * route that stores a report definition, a filter preset or a note. Reporting
 * writes nothing at all — not a domain row, not an audit reason, not a saved
 * view — so there is no free text for `containsSensitiveFreeText` to screen
 * and no way for a pasted card number to reach a persisted column through
 * this module. `read-only.spec.ts` pins that.
 */
export class ReportWindowDto {
  @ApiPropertyOptional({
    description:
      'Inclusive start of the reporting window (ISO-8601). Defaults to 30 days before `to`.',
  })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({
    description:
      'Exclusive end of the reporting window (ISO-8601). Defaults to now.',
  })
  @IsOptional()
  @IsISO8601()
  to?: string;
}

export class QuerySalesReportDto extends ReportWindowDto {
  @ApiPropertyOptional({ description: 'Restrict to one store (location id).' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  locationId?: string;

  @ApiPropertyOptional({ description: 'Restrict to one product id.' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  productId?: string;
}

export class QueryInventoryReportDto extends ReportWindowDto {
  @ApiPropertyOptional({ description: 'Restrict to one store (location id).' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  locationId?: string;

  @ApiPropertyOptional({ description: 'Restrict to one product id.' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  productId?: string;
}

export class QueryBalancesReportDto {
  @ApiPropertyOptional({ description: 'Restrict to one store (location id).' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  locationId?: string;

  @ApiPropertyOptional({ description: 'Restrict to one product id.' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  productId?: string;

  @ApiPropertyOptional({ default: 0, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip?: number;

  @ApiPropertyOptional({
    default: DEFAULT_BALANCE_ROWS,
    minimum: 1,
    maximum: MAX_BALANCE_ROWS,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_BALANCE_ROWS)
  take?: number;
}

export class QueryShrinkReportDto extends ReportWindowDto {
  @ApiPropertyOptional({ description: 'Restrict to one store (location id).' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  locationId?: string;
}

export class QueryCvAccuracyReportDto {
  @ApiPropertyOptional({
    description:
      'The pilot evaluation run to score. Required — accuracy is only ' +
      'meaningful inside one run.',
  })
  @IsString()
  @MinLength(1)
  evaluationRunId!: string;
}
