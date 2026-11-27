import { ApiProperty, ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
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
  PaymentStatus,
  RefundMethod,
  RefundStatus,
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

class ManagerUpdateStaffBaseDto extends OmitType(PartialType(ManagerCreateStaffDto), [
  'phone',
] as const) {}

export class ManagerUpdateStaffDto extends ManagerUpdateStaffBaseDto {
  @ApiPropertyOptional({ nullable: true, example: '+84901234567' })
  @IsOptional()
  @IsString()
  phone?: string | null;
}

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
  @ApiPropertyOptional({ enum: ['placedAt', 'attentionAt', 'status', 'totalAmount'] })
  @IsOptional()
  @IsIn(['placedAt', 'attentionAt', 'status', 'totalAmount'])
  sortBy?: 'placedAt' | 'attentionAt' | 'status' | 'totalAmount';

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'desc' })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder?: 'asc' | 'desc';

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

  @ApiPropertyOptional({
    type: Boolean,
    description:
      'BM-05 "Đơn cần xử lý": orders in REQUIRES_ATTENTION plus orders holding money that arrived late ' +
      '(after cancellation or after switching to cash) and has not been refunded yet. Combines with other filters.',
  })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  needsAttention?: boolean;

  @ApiPropertyOptional({
    type: Boolean,
    description:
      'Leave out orders still awaiting payment (draft or "Chờ thanh toán": unpaid PENDING/CONFIRMED). Orders needing attention stay. Ignored when status is given.',
  })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  hideAwaitingPayment?: boolean;

  @ApiPropertyOptional({ enum: OrderPaymentStatus })
  @IsOptional()
  @IsEnum(OrderPaymentStatus)
  paymentStatus?: OrderPaymentStatus;

  @ApiPropertyOptional({
    enum: PaymentStatus,
    description: 'Status of a payment record, including AMOUNT_MISMATCH',
  })
  @IsOptional()
  @IsEnum(PaymentStatus)
  paymentRecordStatus?: PaymentStatus;

  @ApiPropertyOptional({ enum: RefundStatus })
  @IsOptional()
  @IsEnum(RefundStatus)
  refundStatus?: RefundStatus;

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

/** GAP-310: the Brand Manager order search takes every Store Manager filter plus an optional branch of the chain. */
export class ChainOrderQueryDto extends ManagerOrderQueryDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Only orders of this branch (must belong to the chain)' })
  @IsOptional()
  @IsUUID()
  branchId?: string;
}

export class CancelPaidOrderDto {
  @ApiPropertyOptional({
    enum: ['CHANGE_OF_MIND', 'WRONG_ITEM', 'OUT_OF_STOCK', 'LONG_WAIT', 'OTHER'],
  })
  @IsOptional()
  @IsString()
  reasonCode?: string;
  @ApiProperty({ minLength: 3, maxLength: 500 })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;

  @ApiProperty({ enum: RefundMethod })
  @IsEnum(RefundMethod)
  refundMethod!: RefundMethod;

  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    description: 'Omit or send an empty array to cancel the whole order',
  })
  @IsOptional()
  @IsUUID('4', { each: true })
  orderItemIds?: string[];
}

export class CompleteRefundDto {
  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(500)
  note?: string;
}

/** BM-05 "Đơn cần xử lý": cash refund the Store Manager hands back for an order that needs attention. */
export class ManagerAttentionRefundDto {
  @ApiProperty({ enum: ['CHANGE_OF_MIND', 'WRONG_ITEM', 'OUT_OF_STOCK', 'LONG_WAIT', 'OTHER'] })
  @IsIn(['CHANGE_OF_MIND', 'WRONG_ITEM', 'OUT_OF_STOCK', 'LONG_WAIT', 'OTHER'])
  reasonCode!: string;

  @ApiPropertyOptional({ maxLength: 450, description: 'Required (5+ characters) when reasonCode is OTHER' })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(450)
  note?: string;

  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    description: 'Out-of-stock lines only (combo: the whole combo). Omit to refund the whole order.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsUUID('all', { each: true })
  orderItemIds?: string[];
}

/** BM-05: put out-of-stock lines of a paid order back in the preparation queue once the item is available again. */
export class ManagerResumeItemsDto {
  @ApiPropertyOptional({ type: [String], format: 'uuid', description: 'Omit to resume every out-of-stock line' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsUUID('all', { each: true })
  orderItemIds?: string[];

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(500)
  note?: string;
}

/** BM-05: close an attention case that has no dedicated action (unknown reason). */
export class ManagerResolveAttentionDto {
  @ApiProperty({ minLength: 5, maxLength: 500 })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  note!: string;
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
