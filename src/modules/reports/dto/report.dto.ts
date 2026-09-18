import { Transform, Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayUnique,
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

export enum ReportGranularity {
  DAY = 'day',
  WEEK = 'week',
  MONTH = 'month',
}

/** A query string carries branchIds either repeated or comma separated. */
const toStringArray = ({ value }: { value: unknown }) => {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return value;
};

export class ReportRangeQueryDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Restrict to one chain. Omit to cover every chain assigned to the OWNER.',
  })
  @IsOptional()
  @IsUUID()
  chainId?: string;

  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    description: 'Restrict to specific branches. Omit to include every branch in scope.',
  })
  @IsOptional()
  @Transform(toStringArray)
  @IsArray()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  branchIds?: string[];

  @ApiPropertyOptional({
    example: '2026-08-01',
    format: 'date',
    description: 'Inclusive start date in the chain timezone. Defaults to 30 days before "to".',
  })
  @IsOptional()
  @IsDateString({ strict: true })
  from?: string;

  @ApiPropertyOptional({
    example: '2026-08-31',
    format: 'date',
    description: 'Inclusive end date in the chain timezone. Defaults to today.',
  })
  @IsOptional()
  @IsDateString({ strict: true })
  to?: string;
}

export class RevenueTimeseriesQueryDto extends ReportRangeQueryDto {
  @ApiPropertyOptional({
    enum: ReportGranularity,
    enumName: 'ReportGranularity',
    default: ReportGranularity.DAY,
  })
  @IsOptional()
  @IsEnum(ReportGranularity)
  granularity: ReportGranularity = ReportGranularity.DAY;
}

export class TopItemsQueryDto extends ReportRangeQueryDto {
  @ApiPropertyOptional({ default: 10, minimum: 1, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit: number = 10;
}
