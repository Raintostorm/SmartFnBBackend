import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
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
export class ComboChoiceDto {
  @ApiProperty() @IsUUID() menuItemId!: string;
  @ApiProperty({ minimum: 0 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(99999999999)
  surcharge!: number;
  @ApiProperty() @IsBoolean() isDefault!: boolean;
}
export class ComboComponentDto {
  @ApiProperty({ enum: ['FIXED', 'CHOICE'] }) @IsIn(['FIXED', 'CHOICE']) type!: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(100) name!: string;
  @ApiProperty({ minimum: 1, maximum: 5 }) @IsInt() @Min(1) @Max(5) quantity!: number;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsString() @MaxLength(50) fixedSizeCode?:
    string | null;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) displayOrder?: number;
  @ApiProperty({ type: [ComboChoiceDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ArrayUnique((x: ComboChoiceDto) => x.menuItemId)
  @ValidateNested({ each: true })
  @Type(() => ComboChoiceDto)
  choices!: ComboChoiceDto[];
}
export class SaveComboDto {
  @ApiProperty() @IsUUID() categoryId!: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(150) name!: string;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsString() @MaxLength(2000) description?:
    string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsString() @MaxLength(500) imageUrl?:
    string | null;
  @ApiProperty() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(99999999999) price!: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) displayOrder?: number;
  @ApiProperty({ type: [ComboComponentDto] })
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(6)
  @ValidateNested({ each: true })
  @Type(() => ComboComponentDto)
  components!: ComboComponentDto[];
}
export class UpdateComboDto extends PartialType(SaveComboDto) {}
export class ComboBranchesDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMaxSize(1000)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  branchIds!: string[];
}
export class ComboBranchAvailabilityDto {
  @ApiProperty() @IsBoolean() isAvailable!: boolean;
}
