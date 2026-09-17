import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { BranchAreaStatus, BranchAreaType } from '../../../generated/prisma/client.js';

export class CreateBranchAreaDto {
  @ApiProperty({ example: 'KITCHEN-01', maxLength: 50 })
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

  @ApiProperty({ example: 'Main Kitchen', maxLength: 150 })
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  name!: string;

  @ApiProperty({ enum: BranchAreaType, enumName: 'BranchAreaType' })
  @IsEnum(BranchAreaType)
  type!: BranchAreaType;

  @ApiPropertyOptional({ example: 1, default: 1, minimum: -10, maximum: 200 })
  @IsOptional()
  @IsInt()
  @Min(-10)
  @Max(200)
  floor?: number;
}

export class UpdateBranchAreaDto extends PartialType(CreateBranchAreaDto) {}

export class UpdateBranchAreaStatusDto {
  @ApiProperty({ enum: BranchAreaStatus, enumName: 'BranchAreaStatus' })
  @IsEnum(BranchAreaStatus)
  status!: BranchAreaStatus;
}
