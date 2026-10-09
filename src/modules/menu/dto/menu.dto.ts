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

  @ApiPropertyOptional({ example: true, description: 'Whether identical items may be prepared together' })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  allowBatching?: boolean;

  @ApiPropertyOptional({
    default: true,
    description: 'Whether identical item and size units may be grouped for preparation',
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  allowBatching?: boolean;

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

  @ApiPropertyOptional({
    description: 'Whether identical item and size units may be grouped for preparation',
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  allowBatching?: boolean;
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

export class CreateMenuOptionGroupDto {
  @ApiProperty({ example: 'SIZE', maxLength: 50 })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  @Matches(/^[A-Z0-9_-]+$/, {
    message: 'code may only contain uppercase letters, numbers, underscores, and hyphens',
  })
  code!: string;

  @ApiProperty({ example: 'Kích cỡ', maxLength: 100 })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({ example: true, default: false })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  isRequired?: boolean;

  @ApiPropertyOptional({ example: 1, default: 0, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  minSelections?: number;

  @ApiPropertyOptional({ example: 1, default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  maxSelections?: number;

  @ApiPropertyOptional({ example: 1, default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(9999)
  displayOrder?: number;
}

export class UpdateMenuOptionGroupDto extends PartialType(CreateMenuOptionGroupDto) {
  @ApiPropertyOptional({ description: 'Hide this option group across every branch' })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  isActive?: boolean;
}

export class CreateMenuOptionDto {
  @ApiProperty({ example: 'L', maxLength: 50 })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  @Matches(/^[A-Z0-9_-]+$/, {
    message: 'code may only contain uppercase letters, numbers, underscores, and hyphens',
  })
  code!: string;

  @ApiProperty({ example: 'Size L', maxLength: 100 })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({
    example: 10000,
    default: 0,
    description: 'Chain-wide price added to the base menu-item price',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(99_999_999_999)
  priceDelta?: number;

  @ApiPropertyOptional({ example: 1, default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(9999)
  displayOrder?: number;

  @ApiPropertyOptional({ example: false, description: 'Only one active default option is allowed per group' })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  isDefault?: boolean;
}

export class UpdateMenuOptionDto extends PartialType(CreateMenuOptionDto) {
  @ApiPropertyOptional({ description: 'Hide this option across every branch' })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  isActive?: boolean;
}

export class SetMenuItemOptionGroupsDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    description: 'Exact ordered set of option groups attached to the menu item',
  })
  @IsArray()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  optionGroupIds!: string[];
}
