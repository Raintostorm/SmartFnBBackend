import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
export class SaveExtraDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(100) name!: string;
  @ApiProperty({ minimum: 0 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(99_999_999_999)
  price!: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}
export class ItemExtraLinkDto {
  @ApiPropertyOptional({ default: 0 }) @IsOptional() @IsInt() @Min(0) displayOrder?: number;
  @ApiProperty({ format: 'uuid' }) @IsUUID() extraId!: string;
  @ApiPropertyOptional({ minimum: 0, description: 'Omit to use the library price' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(99_999_999_999)
  price?: number;
  @ApiProperty({ minimum: 1, maximum: 5 }) @IsInt() @Min(1) @Max(5) maxQuantity!: number;
}
export class SetItemExtrasDto {
  @ApiProperty({ default: 5 }) @IsInt() @Min(0) @Max(100) maxExtras!: number;
  @ApiProperty({ type: [ItemExtraLinkDto] })
  @IsArray()
  @ArrayMaxSize(100)
  @ArrayUnique((x: ItemExtraLinkDto) => x.extraId)
  @ValidateNested({ each: true })
  @Type(() => ItemExtraLinkDto)
  extras!: ItemExtraLinkDto[];
}
export class ExtraAvailabilityDto {
  @ApiProperty() @IsBoolean() isAvailable!: boolean;
}
