import { Transform, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsEmail,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  RegistrationApplicationStatus,
  SubscriptionCheckoutStatus,
} from '../../../generated/prisma/client.js';

export class SubmitRegistrationApplicationDto {
  @ApiProperty({ example: 'Smart F&B Company', maxLength: 150 })
  @IsString()
  @MinLength(2)
  @MaxLength(150)
  businessName!: string;

  @ApiPropertyOptional({ example: '0312345678', maxLength: 50 })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  taxCode?: string;

  @ApiProperty({ example: 'Nguyen Van An', maxLength: 150 })
  @IsString()
  @MinLength(2)
  @MaxLength(150)
  representativeName!: string;

  @ApiProperty({ example: 'owner@example.com' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(255)
  representativeEmail!: string;

  @ApiProperty({ example: '+84901234567' })
  @IsString()
  @Matches(/^\+?[0-9]{8,15}$/, { message: 'representativePhone must contain 8 to 15 digits' })
  representativePhone!: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  headquartersAddress?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  requestedPlanId?: string;

  @ApiPropertyOptional({ description: 'Choose the 14-day Basic trial instead of a paid plan' })
  @IsOptional()
  @IsBoolean()
  trialRequested?: boolean;
}

export class PaginationQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(150)
  search?: string;
}

export class ListRegistrationApplicationsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: RegistrationApplicationStatus })
  @IsOptional()
  @IsEnum(RegistrationApplicationStatus)
  status?: RegistrationApplicationStatus;
}

export class ApproveRegistrationApplicationDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Overrides the requested plan' })
  @IsOptional()
  @IsUUID()
  planId?: string;

  @ApiPropertyOptional({ type: Number, default: 1, minimum: 1, maximum: 60 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(60)
  subscriptionMonths = 1;

  @ApiPropertyOptional({ maxLength: 1000, description: 'Internal review note kept in the audit log (BR-06)' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class RejectRegistrationApplicationDto {
  @ApiProperty({ maxLength: 1000 })
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  reason!: string;
}

export class PlatformSupportNoteDto {
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  note!: string;
}

export class ChangeApprovedPlanDto extends PlatformSupportNoteDto {
  @IsUUID()
  planId!: string;
}

/** Platform Staff/Admin registering the next period on the customer's request (BR-74, 31.5). */
export class SupportNextPeriodDto extends PlatformSupportNoteDto {
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() planId?: string;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10) extraBranches?: number;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(4) accountPacks?: number;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @ArrayMaxSize(100) @ArrayUnique() @IsUUID('all', { each: true }) keepBranchIds?: string[];
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @ArrayMaxSize(500) @ArrayUnique() @IsUUID('all', { each: true }) keepAccountIds?: string[];
  @ApiPropertyOptional({ description: 'Cancel the registration instead' }) @IsOptional() @IsBoolean() clear?: boolean;
}

export class NextPeriodDraftQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() planId?: string;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10) extraBranches?: number;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(4) accountPacks?: number;
}

export class ActivationTokenDto {
  @IsString()
  @MinLength(32)
  @MaxLength(128)
  token!: string;
}

export class CreateServicePlanDto {
  @ApiProperty({ example: 'PRO', maxLength: 50 })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @Matches(/^[A-Z0-9_-]+$/)
  @MaxLength(50)
  code!: string;

  @ApiProperty({ example: 'Professional' })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiProperty({ example: 499000, minimum: 0 })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  monthlyPrice!: number;

  @ApiProperty({ example: 5, minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maxBranches!: number;

  @ApiProperty({ example: 50, minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maxAccounts!: number;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  extraBranchPrice?: number;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  extraBranchAccounts?: number;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  extraAccountPackPrice?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  extraBranchEnabled?: boolean;

  @ApiPropertyOptional({
    example: 100,
    minimum: 1,
    description: 'Legacy v7 table quota; omitted plans default to 1',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maxTables?: number;

  @ApiProperty({
    example: true,
    description: 'Allows the business to customize its branding',
  })
  @IsBoolean()
  brandingEnabled!: boolean;

  @ApiProperty({
    example: false,
    description: 'Allows cross-branch comparison reports',
  })
  @IsBoolean()
  multiBranchComparisonEnabled!: boolean;
}

export class UpdateServicePlanDto extends PartialType(CreateServicePlanDto) {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class RenewSubscriptionDto {
  @ApiProperty({ example: 1, minimum: 1, maximum: 60 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(60)
  months!: number;

  @ApiProperty({ minLength: 3, maxLength: 1000 })
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  note!: string;
}

export class SubscriptionStatusReasonDto {
  @ApiProperty({ minLength: 3, maxLength: 1000 })
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  reason!: string;
}

export enum PlatformRevenueGroupBy {
  DAY = 'day',
  MONTH = 'month',
  YEAR = 'year',
}

export class PlatformRevenueQueryDto {
  @ApiPropertyOptional({ example: '2026-01-01' })
  @IsOptional()
  @IsDateString({ strict: true })
  from?: string;

  @ApiPropertyOptional({ example: '2026-12-31' })
  @IsOptional()
  @IsDateString({ strict: true })
  to?: string;

  @ApiPropertyOptional({
    enum: PlatformRevenueGroupBy,
    default: PlatformRevenueGroupBy.MONTH,
  })
  @IsOptional()
  @IsEnum(PlatformRevenueGroupBy)
  groupBy = PlatformRevenueGroupBy.MONTH;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  planId?: string;
}

export class ListPlatformInvoicesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: SubscriptionCheckoutStatus })
  @IsOptional()
  @IsEnum(SubscriptionCheckoutStatus)
  status?: SubscriptionCheckoutStatus;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  chainId?: string;
}

export class ConfirmPlatformInvoiceDto extends PlatformSupportNoteDto {}
