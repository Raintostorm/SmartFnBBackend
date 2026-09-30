import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MinLength,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class CreateCounterOrderDto {
  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

export class AddCounterOrderItemDto {
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

export class CheckoutCounterOrderDto {
  @ApiProperty({ type: [AddCounterOrderItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AddCounterOrderItemDto)
  items!: AddCounterOrderItemDto[];

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
  @ApiProperty({ format: 'uuid', description: 'POS station collecting this payment and printing its documents' })
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

export class CancelCounterOrderDto {
  @ApiProperty({ minLength: 3, maxLength: 500 })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}
