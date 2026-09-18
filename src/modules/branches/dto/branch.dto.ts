import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { BranchStatus } from '../../../generated/prisma/client.js';

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const TIME_PATTERN_SOURCE = TIME_PATTERN.source;

export class CreateBranchDto {
  @ApiProperty({ example: 'HCM-D1', maxLength: 50 })
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

  @ApiProperty({ example: 'Smart F&B Nguyen Hue', maxLength: 150 })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  name!: string;

  @ApiPropertyOptional({ example: '+84901234567', maxLength: 20 })
  @IsOptional()
  @Matches(/^\+?[0-9]{8,15}$/, { message: 'phone must contain 8 to 15 digits' })
  phone?: string;

  @ApiPropertyOptional({ example: 'branch@smartfnb.vn', maxLength: 255 })
  @IsOptional()
  @IsEmail()
  @MaxLength(255)
  email?: string;

  @ApiProperty({ example: '123 Nguyen Hue', maxLength: 255 })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  addressLine1!: string;

  @ApiPropertyOptional({ example: 'Floor 2', maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  addressLine2?: string;

  @ApiPropertyOptional({ example: 'Ben Nghe', maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  ward?: string;

  @ApiPropertyOptional({ example: 'District 1', maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  district?: string;

  @ApiProperty({ example: 'Ho Chi Minh City', maxLength: 100 })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  city!: string;

  @ApiPropertyOptional({ example: 'Vietnam', default: 'Vietnam', maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  country?: string;

  @ApiPropertyOptional({ example: 'Asia/Ho_Chi_Minh', default: 'Asia/Ho_Chi_Minh' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  timezone?: string;

  @ApiPropertyOptional({
    example: '08:00',
    description: 'Opening time applied to all seven days; pair it with closeTime.',
    pattern: TIME_PATTERN_SOURCE,
  })
  @IsOptional()
  @Matches(TIME_PATTERN, { message: 'openTime must use HH:mm format' })
  openTime?: string;

  @ApiPropertyOptional({
    example: '22:00',
    description:
      'Closing time applied to all seven days. Also the cut-off used to auto-close work sessions.',
    pattern: TIME_PATTERN_SOURCE,
  })
  @IsOptional()
  @Matches(TIME_PATTERN, { message: 'closeTime must use HH:mm format' })
  closeTime?: string;
}

// Opening hours are seeded at creation; per-day edits go through the operating-hours routes.
export class UpdateBranchDto extends PartialType(
  OmitType(CreateBranchDto, ['openTime', 'closeTime'] as const),
) {}

export class UpdateBranchStatusDto {
  @ApiProperty({ enum: BranchStatus, enumName: 'BranchStatus' })
  @IsEnum(BranchStatus)
  status!: BranchStatus;
}

export class ListBranchesQueryDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'ADMIN-only chain filter' })
  @IsOptional()
  @IsUUID()
  chainId?: string;

  @ApiPropertyOptional({ enum: BranchStatus, enumName: 'BranchStatus' })
  @IsOptional()
  @IsEnum(BranchStatus)
  status?: BranchStatus;

  @ApiPropertyOptional({ example: 'Ho Chi Minh City' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  city?: string;
}

export class ListPublicBranchesQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  chainId?: string;

  @ApiPropertyOptional({ example: 'Ho Chi Minh City' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  city?: string;
}
