import { Transform, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  ArrayUnique,
  IsArray,
  IsBoolean,
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

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const toBoolean = ({ value }: { value: unknown }) => {
  if (typeof value === 'boolean') {
    return value;
  }
  return value === 'true' ? true : value === 'false' ? false : value;
};

export class CreateMenuCategoryDto {
  @ApiProperty({ example: 'Món chính', maxLength: 150 })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  name!: string;

  @ApiPropertyOptional({ example: 'Các món ăn no', maxLength: 500 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ example: 1, default: 0, description: 'Sort order on the menu screen' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(9999)
  displayOrder?: number;
}

export class UpdateMenuCategoryDto extends PartialType(CreateMenuCategoryDto) {
  @ApiPropertyOptional({ description: 'Hide the whole category across every branch' })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  isActive?: boolean;
}

export class CreateMenuItemDto {
  @ApiProperty({ format: 'uuid', description: 'Chain-wide category the item belongs to' })
  @IsUUID()
  categoryId!: string;

  @ApiProperty({ example: 'RICE-001', maxLength: 50, description: 'Unique across the platform' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  @Matches(/^[A-Z0-9_-]+$/, {
    message: 'sku may only contain uppercase letters, numbers, underscores, and hyphens',
  })
  sku!: string;

  @ApiProperty({ example: 'Cơm gà nướng', maxLength: 150 })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  name!: string;

  @ApiPropertyOptional({ example: 'Cơm gà nướng mật ong, ăn kèm dưa leo' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiProperty({ example: 65000, description: 'One price for the whole chain' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(99_999_999_999)
  price!: number;

  @ApiPropertyOptional({ example: 'https://cdn.smartfnb.vn/mon/com-ga.jpg', maxLength: 500 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  imageUrl?: string;

  @ApiPropertyOptional({ example: 15, description: 'Estimated preparation time in minutes' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1440)
  preparationMinutes?: number;

  @ApiPropertyOptional({
    description:
      'Branches that will sell the item. Omit to enable it at every branch of the chain.',
    type: [String],
    format: 'uuid',
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  branchIds?: string[];
}

// sku is the stable identity order history refers to, so it is not editable here.
export class UpdateMenuItemDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({ example: 'Cơm gà nướng', maxLength: 150 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  name?: string;

  @ApiPropertyOptional({ example: 'Mô tả mới' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ example: 69000 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(99_999_999_999)
  price?: number;

  @ApiPropertyOptional({ example: 'https://cdn.smartfnb.vn/mon/com-ga.jpg', maxLength: 500 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  imageUrl?: string;

  @ApiPropertyOptional({ example: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1440)
  preparationMinutes?: number;
}

export class SetMenuItemActiveDto {
  @ApiProperty({
    description: 'false switches the item off for every branch of the chain at once',
    example: false,
  })
  @Transform(toBoolean)
  @IsBoolean()
  isActive!: boolean;
}

export class SetMenuItemBranchesDto {
  @ApiProperty({
    description:
      'The exact set of branches that sell this item; branches left out are switched off',
    type: [String],
    format: 'uuid',
  })
  @IsArray()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  branchIds!: string[];
}

export class UpdateBranchMenuItemDto {
  @ApiPropertyOptional({ description: 'Whether this branch carries the item at all' })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  isEnabled?: boolean;

  @ApiPropertyOptional({ description: 'Whether the item can be ordered right now at this branch' })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  isAvailable?: boolean;

  @ApiPropertyOptional({ example: 20, description: 'Portions left today; null clears the count' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100_000)
  remainingPortions?: number | null;
}

export class ListMenuItemsQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({ example: 'cơm', description: 'Matches the item name or SKU' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(150)
  search?: string;

  @ApiPropertyOptional({ description: 'Filter by the chain-wide on/off switch' })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  isActive?: boolean;
}
