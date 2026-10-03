import { Transform, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PaymentMethod, PaymentStatus } from '../../../generated/prisma/client.js';

export class CreateTableSessionPaymentDto {
  @ApiProperty({ enum: PaymentMethod, enumName: 'PaymentMethod' })
  @IsEnum(PaymentMethod)
  method!: PaymentMethod;

  @ApiProperty({ type: Number, minimum: 0.01, example: 250000 })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount!: number;

  @ApiPropertyOptional({ maxLength: 255, example: 'BANK-20260922-001' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  transactionRef?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class ConfirmPaymentDto {
  @ApiPropertyOptional({
    minLength: 3,
    maxLength: 500,
    description: 'Required for non-cash manual confirmation by MANAGER',
  })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason?: string;

  @ApiPropertyOptional({
    type: Number,
    minimum: 0.01,
    description:
      'Required for non-cash. Actual amount verified by Manager; any variance from amount is preserved in audit.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(999999999999.99)
  receivedAmount?: number;

  @ApiPropertyOptional({ maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  transactionRef?: string;
}

export class PaymentListQueryDto {
  @ApiPropertyOptional({ enum: PaymentStatus, enumName: 'PaymentStatus' })
  @IsOptional()
  @IsEnum(PaymentStatus)
  status?: PaymentStatus;

  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({ type: Number, minimum: 1, default: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: 100, default: 20 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;
}

export class PaymentResponseDto {
  @ApiPropertyOptional({ description: 'Manager reason for manual confirmation' })
  confirmationReason!: string | null;

  @ApiPropertyOptional({
    type: String,
    description: 'Actual amount received, stored separately from the settled amount',
  })
  receivedAmount!: string | null;

  @ApiPropertyOptional({ format: 'date-time' })
  confirmedAt!: Date | null;

  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  paymentCode!: string;

  @ApiPropertyOptional({ format: 'uuid' })
  orderId!: string | null;

  @ApiPropertyOptional({ format: 'uuid' })
  tableSessionId!: string | null;

  @ApiPropertyOptional({ format: 'uuid' })
  processedById!: string | null;

  @ApiProperty({ enum: PaymentMethod, enumName: 'PaymentMethod' })
  method!: PaymentMethod;

  @ApiProperty({ enum: PaymentStatus, enumName: 'PaymentStatus' })
  status!: PaymentStatus;

  @ApiProperty({ type: Number })
  amount!: number;

  @ApiPropertyOptional()
  transactionRef!: string | null;

  @ApiPropertyOptional({ format: 'date-time' })
  paidAt!: Date | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;
}

export class PaymentListResponseDto {
  @ApiProperty({ type: PaymentResponseDto, isArray: true })
  items!: PaymentResponseDto[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;
}
