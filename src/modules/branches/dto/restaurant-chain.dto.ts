import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { RestaurantChainStatus } from '../../../generated/prisma/client.js';

export class CreateRestaurantChainDto {
  @ApiProperty({ example: 'SMART_FNB', maxLength: 50 })
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

  @ApiProperty({ example: 'Smart F&B Chain', maxLength: 150 })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  name!: string;

  @ApiPropertyOptional({ example: 'https://cdn.example.com/logo.png', maxLength: 500 })
  @IsOptional()
  @IsUrl({ require_tld: false })
  @MaxLength(500)
  logoUrl?: string;

  @ApiPropertyOptional({ example: 'contact@smartfnb.vn', maxLength: 255 })
  @IsOptional()
  @IsEmail()
  @MaxLength(255)
  email?: string;

  @ApiPropertyOptional({ example: '+84901234567', maxLength: 20 })
  @IsOptional()
  @Matches(/^\+?[0-9]{8,15}$/, { message: 'phone must contain 8 to 15 digits' })
  phone?: string;

  @ApiPropertyOptional({ example: 'https://smartfnb.vn', maxLength: 500 })
  @IsOptional()
  @IsUrl({ require_tld: false })
  @MaxLength(500)
  website?: string;

  @ApiPropertyOptional({ example: '0312345678', maxLength: 50 })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  taxCode?: string;

  @ApiPropertyOptional({ example: '123 Nguyen Hue, Ho Chi Minh City', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  headquartersAddress?: string;

  @ApiPropertyOptional({ example: 'Asia/Ho_Chi_Minh', default: 'Asia/Ho_Chi_Minh' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  timezone?: string;

  @ApiPropertyOptional({ example: 'VND', default: 'VND', minLength: 3, maxLength: 3 })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be a three-letter ISO code' })
  currency?: string;
}

export class UpdateRestaurantChainDto extends PartialType(CreateRestaurantChainDto) {}

export class UpdateRestaurantChainStatusDto {
  @ApiProperty({ enum: RestaurantChainStatus, enumName: 'RestaurantChainStatus' })
  @IsEnum(RestaurantChainStatus)
  status!: RestaurantChainStatus;
}
