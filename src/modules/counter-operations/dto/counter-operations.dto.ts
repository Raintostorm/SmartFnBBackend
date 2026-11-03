import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsInt,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MinLength,
  MaxLength,
  Min,
  Max,
  ValidateNested,
} from 'class-validator';
import { PrintJobStatus } from '../../../generated/prisma/client.js';

export class CreateCounterOrderDto {
  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

export class SelectedExtraDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  extraId!: string;
  @ApiProperty({ minimum: 1, maximum: 5 })
  @IsInt()
  @Min(1)
  @Max(5)
  quantity!: number;
}

export class AddCounterOrderItemDto {
  @ApiPropertyOptional({
    type: [SelectedExtraDto],
    description: 'Extra quantities per cup, not per order line',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SelectedExtraDto)
  extras: SelectedExtraDto[] = [];

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  menuItemId!: string;

  @ApiProperty({ minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  quantity!: number;

  @ApiPropertyOptional({ type: [String], format: 'uuid', default: [] })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  optionIds: string[] = [];

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  specialInstructions?: string;
}

export class SelectedComboComponentDto {
  @ApiProperty() @IsUUID() componentId!: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() menuItemId?: string;
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  optionIds: string[] = [];
  @ApiPropertyOptional({ type: [SelectedExtraDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SelectedExtraDto)
  extras: SelectedExtraDto[] = [];
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) specialInstructions?: string;
}
export class SelectedComboDto {
  @ApiProperty() @IsUUID() comboId!: string;
  @ApiProperty({ minimum: 1, maximum: 100 }) @IsInt() @Min(1) @Max(100) quantity!: number;
  @ApiPropertyOptional({ type: [SelectedComboComponentDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SelectedComboComponentDto)
  components: SelectedComboComponentDto[] = [];
}

export class CheckoutCounterOrderDto {
  @ApiPropertyOptional({ type: [SelectedComboDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SelectedComboDto)
  combos: SelectedComboDto[] = [];
  @ApiProperty({ type: [AddCounterOrderItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AddCounterOrderItemDto)
  @IsOptional()
  items: AddCounterOrderItemDto[] = [];

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

export class StartPreparationBatchDto {
  @ApiProperty({ type: [String], format: 'uuid' })
  @IsArray()
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  unitIds!: string[];
}

export class CashPaymentDto {
  @ApiProperty({
    format: 'uuid',
    description: 'POS station collecting this payment and printing its documents',
  })
  @IsUUID()
  stationId!: string;

  @ApiProperty({ minimum: 0, example: 100000 })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  tenderedAmount!: number;
}

export class AvailabilityDto {
  @ApiProperty()
  @IsBoolean()
  isAvailable!: boolean;
}

export class ReprintDto {
  @ApiProperty({ minLength: 3, maxLength: 500 })
  @IsString()
  @MaxLength(500)
  reason!: string;
}

export class PrintJobResultDto {
  @ApiProperty({ enum: [PrintJobStatus.PRINTED, PrintJobStatus.FAILED] })
  @IsIn([PrintJobStatus.PRINTED, PrintJobStatus.FAILED])
  status!: typeof PrintJobStatus.PRINTED | typeof PrintJobStatus.FAILED;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  errorMessage?: string;
}

export class CancelCounterOrderDto {
  @ApiProperty({ minLength: 3, maxLength: 500 })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}
