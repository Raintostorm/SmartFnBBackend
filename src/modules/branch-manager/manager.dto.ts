import { ApiProperty, ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  OrderPaymentStatus,
  OrderStatus,
  OrderType,
  PaymentMethod,
  UserStatus,
} from '../../generated/prisma/client.js';
import { AppRole } from '../auth/app-role.enum.js';
import { CreateStaffDto } from '../auth/dto/create-staff.dto.js';

export class ManagerCreateStaffDto extends OmitType(CreateStaffDto, [
  'role',
  'branchId',
  'password',
] as const) {
  @ApiProperty({ enum: [AppRole.CASHIER, AppRole.BARISTA] })
  @IsIn([AppRole.CASHIER, AppRole.BARISTA])
  role!: AppRole.CASHIER | AppRole.BARISTA;
}

export class ManagerUpdateStaffDto extends PartialType(ManagerCreateStaffDto) {}

export class ManagerResetPasswordDto {
  @ApiProperty({ minLength: 3, maxLength: 500 })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export class ManagerStaffStatusDto {
  @ApiProperty({ enum: [UserStatus.ACTIVE, UserStatus.INACTIVE, UserStatus.SUSPENDED] })
  @IsIn([UserStatus.ACTIVE, UserStatus.INACTIVE, UserStatus.SUSPENDED])
  status!: UserStatus;

  @ApiProperty({ minLength: 3, maxLength: 500 })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export class ManagerPageDto {
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
}

export class ManagerStaffQueryDto extends ManagerPageDto {
  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({ enum: [AppRole.CASHIER, AppRole.BARISTA] })
  @IsOptional()
  @IsIn([AppRole.CASHIER, AppRole.BARISTA])
  role?: AppRole.CASHIER | AppRole.BARISTA;

  @ApiPropertyOptional({ enum: UserStatus })
  @IsOptional()
  @IsEnum(UserStatus)
  status?: UserStatus;
}

export class ManagerAvailabilityDto {
  @ApiProperty({ example: false })
  @IsBoolean()
  isAvailable!: boolean;
}

export class ManagerOrderQueryDto extends ManagerPageDto {
  @ApiPropertyOptional({
    description: 'Partial order code or exact numeric call number',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({ maxLength: 50 })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  orderCode?: string;

  @ApiPropertyOptional({ minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  callNumber?: number;

  @ApiPropertyOptional({
    format: 'date-time',
    description: 'Inclusive placedAt, ISO 8601 with timezone',
  })
  @IsOptional()
  @IsDateString({ strict: true })
  from?: string;

  @ApiPropertyOptional({
    format: 'date-time',
    description: 'Exclusive placedAt, ISO 8601 with timezone',
  })
  @IsOptional()
  @IsDateString({ strict: true })
  to?: string;

  @ApiPropertyOptional({ enum: OrderStatus })
  @IsOptional()
  @IsEnum(OrderStatus)
  status?: OrderStatus;

  @ApiPropertyOptional({ enum: OrderPaymentStatus })
  @IsOptional()
  @IsEnum(OrderPaymentStatus)
  paymentStatus?: OrderPaymentStatus;

  @ApiPropertyOptional({
    enum: PaymentMethod,
    description: 'Matches payment attempts on the order or its table session',
  })
  @IsOptional()
  @IsEnum(PaymentMethod)
  paymentMethod?: PaymentMethod;

  @ApiPropertyOptional({ enum: OrderType })
  @IsOptional()
  @IsEnum(OrderType)
  type?: OrderType;
}

export class ManagerReportQueryDto {
  @ApiPropertyOptional({
    format: 'date',
    example: '2026-10-01',
    description: 'Inclusive date in branch timezone; default: last 30 days',
  })
  @IsOptional()
  @IsDateString({ strict: true })
  from?: string;

  @ApiPropertyOptional({
    format: 'date',
    example: '2026-10-31',
    description: 'Inclusive date in branch timezone; maximum range 366 days',
  })
  @IsOptional()
  @IsDateString({ strict: true })
  to?: string;

  @ApiPropertyOptional({ enum: ['day', 'week', 'month'], default: 'day' })
  @IsIn(['day', 'week', 'month'])
  granularity: 'day' | 'week' | 'month' = 'day';

  @ApiPropertyOptional({ minimum: 1, maximum: 50, default: 10 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit = 10;
}

export class ManagerAuditQueryDto extends ManagerPageDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  entityId?: string;
}
