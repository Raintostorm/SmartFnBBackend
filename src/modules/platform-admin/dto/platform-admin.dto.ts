import { Transform, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  IsEmail,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
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
  WithdrawalRequestStatus,
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
}

export class RejectRegistrationApplicationDto {
  @ApiProperty({ maxLength: 1000 })
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  reason!: string;
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

  @ApiProperty({ example: 100, minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maxTables!: number;
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

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export enum PlanChangeDirection {
  UPGRADE = 'UPGRADE',
  DOWNGRADE = 'DOWNGRADE',
}

export class ChangeSubscriptionPlanDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  planId!: string;

  @ApiProperty({ enum: PlanChangeDirection })
  @IsEnum(PlanChangeDirection)
  direction!: PlanChangeDirection;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class SubscriptionStatusReasonDto {
  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

export class UpdatePlatformFinanceConfigDto {
  @ApiProperty({ example: 0.02, minimum: 0, maximum: 1 })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0)
  @Max(1)
  paymentFeeRate!: number;

  @ApiProperty({ example: 3, minimum: 0, maximum: 365 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(365)
  holdingPeriodDays!: number;

  @ApiProperty({ example: 100000, minimum: 1 })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  minimumWithdrawalAmount!: number;
}

export class ListWithdrawalRequestsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: WithdrawalRequestStatus })
  @IsOptional()
  @IsEnum(WithdrawalRequestStatus)
  status?: WithdrawalRequestStatus;
}

export class WithdrawalReasonDto {
  @ApiProperty({ maxLength: 1000 })
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  reason!: string;
}

export class ConfirmWithdrawalTransferDto {
  @ApiProperty({ example: 'BANK-TXN-20260918-001', maxLength: 100 })
  @IsString()
  @MinLength(3)
  @MaxLength(100)
  bankTransactionCode!: string;
}

export class CreateWithdrawalRequestDto {
  @ApiProperty({ format: 'uuid', description: 'RestaurantChain/business ID' })
  @IsUUID()
  businessId!: string;

  @ApiProperty({ example: 500000, minimum: 1 })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount!: number;

  @ApiProperty({ example: 'Vietcombank', maxLength: 150 })
  @IsString()
  @MinLength(2)
  @MaxLength(150)
  bankName!: string;

  @ApiProperty({ example: 'NGUYEN VAN AN', maxLength: 150 })
  @IsString()
  @MinLength(2)
  @MaxLength(150)
  bankAccountName!: string;

  @ApiProperty({ example: '0123456789', maxLength: 50 })
  @IsString()
  @MinLength(4)
  @MaxLength(50)
  bankAccountNumber!: string;
}
